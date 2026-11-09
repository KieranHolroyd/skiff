import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { backupTargets, databaseBackups, databases } from '@yoal/db';
import {
	backupTargetCreateSchema,
	backupTargetUpdateSchema,
	type BackupTargetCredentials,
	type BackupTargetResolution,
	type BackupTargetTestResult,
	type BackupTargetView,
	type DatabaseBackupLocation,
	type Principal,
} from '@yoal/contracts';
import { join } from 'node:path';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { LocalObjectStore, S3ObjectStore, type ObjectStore } from './object-store.ts';
import { newId, parseJson } from './util.ts';

/**
 * Backup targets (plan 05, docs/BACKUPS.md). A target is a local directory or an S3-compatible
 * bucket that backups are written to. Resolution is resource → org → platform → local default.
 * Credentials are sealed with the org key and only returned once, on create or rotation.
 *
 * Resolution only decides where the NEXT backup goes. Each backup row records the target it was
 * written to and a snapshot of its location (`placementFor`), and restore, retention and purge open
 * that record (`openRecorded`), so adding a target or switching the default never moves an existing
 * backup. A target that still holds retained backups cannot be deleted or re-pointed without force.
 */

type BackupTargetRow = typeof backupTargets.$inferSelect;

/** Org id used to seal a platform target, which has no org of its own. */
const PLATFORM_KEY_ORG = 'platform';
const LOCAL_DEFAULT_ID = 'local-default';

export interface BackupTargetCreateOptions {
	/** Create/replace the platform default (org_id NULL) instead of an org target. */
	platform?: boolean;
}

export interface BackupTargetMutationResult {
	target: BackupTargetView;
	/** Present once, when credentials were supplied (create or rotation); never stored in a view. */
	credentials: BackupTargetCredentials | null;
}

export interface ResolvedStore {
	store: ObjectStore;
	target: BackupTargetView;
	source: BackupTargetResolution['source'];
}

export interface BackupTargetDeleteOptions {
	/**
	 * Delete even though retained backups were written to this target. Those backups stay listed
	 * but become unavailable until a target with the same location is added again.
	 */
	force?: boolean;
}

/** Location snapshot stored in `database_backups.location_json`. Never holds credentials. */
export interface BackupLocationSnapshot {
	kind: 'platform' | 'local' | 's3';
	orgId?: string | null;
	path?: string | null;
	endpoint?: string | null;
	bucket?: string | null;
	region?: string | null;
	pathPrefix?: string | null;
}

/** Columns a new `database_backups` row records about where it is written. */
export interface BackupPlacement {
	targetId: string | null;
	targetName: string;
	locationJson: string;
}

/** The recorded columns of a backup row, as `openRecorded`/`describeRecorded` read them. */
export interface RecordedBackup {
	orgId: string;
	objectKey: string;
	targetId: string | null;
	targetName: string | null;
	locationJson: string | null;
}

export type RecordedStore =
	| {
			available: true;
			store: ObjectStore;
			/** The live target row; null for the platform object store. */
			target: BackupTargetView | null;
			writeOnly: boolean;
			location: DatabaseBackupLocation;
	  }
	| { available: false; reason: string; location: DatabaseBackupLocation };

/** Backup statuses whose object Yoal may still need to read or delete. */
const RETAINED_BACKUP_STATUSES = ['pending', 'running', 'ok'] as const;
const PLATFORM_STORE_NAME = 'platform object store';

export class BackupTargetService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal): BackupTargetView[] {
		this.ctx.iam.require(principal, 'database:read', { type: 'org' });
		return this.ctx.db
			.select()
			.from(backupTargets)
			.where(or(eq(backupTargets.orgId, principal.orgId), isNull(backupTargets.orgId)))
			.orderBy(asc(backupTargets.createdAt))
			.all()
			.map((row) => this.toView(row));
	}

	get(principal: Principal, id: string): BackupTargetView {
		const row = this.findVisible(principal, id);
		if (!row) throw new NotFoundError('Backup target');
		this.ctx.iam.require(principal, 'database:read', { type: 'org' });
		return this.toView(row);
	}

	/** Internal lookup used by signed local-object URLs; no principal is involved. */
	getById(id: string): BackupTargetView | null {
		const row = this.ctx.db.select().from(backupTargets).where(eq(backupTargets.id, id)).get();
		return row ? this.toView(row) : null;
	}

	// ------------------------------------------------------------- mutations

	create(principal: Principal, raw: unknown, options: BackupTargetCreateOptions = {}): BackupTargetMutationResult {
		this.requireMutationsEnabled();
		const input = backupTargetCreateSchema.parse(raw);
		const platform = options.platform === true;
		if (platform) this.requirePlatformAdmin(principal);
		else this.ctx.iam.require(principal, 'database:update', { type: 'org' });
		const orgId = platform ? null : principal.orgId;
		const duplicate = this.ctx.db
			.select({ id: backupTargets.id })
			.from(backupTargets)
			.where(and(orgId === null ? isNull(backupTargets.orgId) : eq(backupTargets.orgId, orgId), eq(backupTargets.name, input.name)))
			.get();
		if (duplicate) throw new ConflictError(`A backup target named "${input.name}" already exists.`);
		const now = this.ctx.now();
		const id = newId('bt_');
		const values =
			input.kind === 'local'
				? {
						id,
						orgId,
						name: input.name,
						kind: 'local' as const,
						path: input.path,
						endpoint: null,
						bucket: null,
						region: null,
						pathPrefix: '',
						forcePathStyle: true,
						accessKeySealed: null,
						secretSealed: null,
						writeOnly: input.writeOnly,
						objectLock: false,
						status: 'pending' as const,
						createdAt: now,
						updatedAt: now,
					}
				: {
						id,
						orgId,
						name: input.name,
						kind: 's3' as const,
						path: null,
						endpoint: input.endpoint ?? null,
						bucket: input.bucket,
						region: input.region,
						pathPrefix: input.pathPrefix,
						forcePathStyle: input.forcePathStyle,
						accessKeySealed: this.seal(orgId, input.accessKeyId),
						secretSealed: this.seal(orgId, input.secretAccessKey),
						writeOnly: input.writeOnly,
						objectLock: input.objectLock,
						status: 'pending' as const,
						createdAt: now,
						updatedAt: now,
					};
		this.ctx.db.insert(backupTargets).values(values).run();
		const view = this.toView(this.requireRow(id));
		const reconnected = this.reconnectOrphans(view);
		this.ctx.audit.record({
			principal,
			action: 'backup-target.create',
			resource: 'backupTarget',
			resourceId: id,
			args: {
				name: input.name,
				kind: input.kind,
				platform,
				endpoint: input.kind === 's3' ? (input.endpoint ?? null) : null,
				bucket: input.kind === 's3' ? input.bucket : null,
				writeOnly: input.writeOnly,
				objectLock: input.kind === 's3' ? input.objectLock : false,
				reconnectedBackups: reconnected,
			},
			result: 'ok',
		});
		return {
			target: view,
			credentials: input.kind === 's3' ? this.credentials(view, input.accessKeyId, input.secretAccessKey, 'created') : null,
		};
	}

	update(principal: Principal, id: string, raw: unknown): BackupTargetMutationResult {
		this.requireMutationsEnabled();
		const input = backupTargetUpdateSchema.parse(raw);
		const row = this.requireMutableRow(principal, id);
		if (row.kind === 'local') {
			if (
				input.endpoint !== undefined ||
				input.bucket !== undefined ||
				input.region !== undefined ||
				input.pathPrefix !== undefined ||
				input.forcePathStyle !== undefined ||
				input.objectLock !== undefined ||
				input.accessKeyId !== undefined ||
				input.secretAccessKey !== undefined
			)
				throw new ValidationError('A local target only has a name, path and write-only setting.');
		} else if (input.path !== undefined) {
			throw new ValidationError('An S3 target has no local path.');
		}
		if ((input.accessKeyId === undefined) !== (input.secretAccessKey === undefined))
			throw new ValidationError('Supply both accessKeyId and secretAccessKey to rotate credentials.');
		const moved = (['path', 'endpoint', 'bucket', 'pathPrefix'] as const).filter(
			(field) => input[field] !== undefined && (input[field] ?? null) !== (row[field] ?? null),
		);
		if (moved.length > 0) {
			const held = this.retainedBackups(id).total;
			if (held > 0)
				throw new ConflictError(
					`Backup target "${row.name}" holds ${countLabel(held, 'database backup')} at its current location, so its ${moved.join(', ')} cannot change. ` +
						'Add a new target for the new location instead; existing backups stay where they were written.',
				);
		}
		if (input.name !== undefined && input.name !== row.name) {
			const duplicate = this.ctx.db
				.select({ id: backupTargets.id })
				.from(backupTargets)
				.where(
					and(
						row.orgId === null ? isNull(backupTargets.orgId) : eq(backupTargets.orgId, row.orgId),
						eq(backupTargets.name, input.name),
					),
				)
				.get();
			if (duplicate) throw new ConflictError(`A backup target named "${input.name}" already exists.`);
		}
		const patch: Partial<typeof backupTargets.$inferInsert> = { updatedAt: this.ctx.now() };
		if (input.name !== undefined) patch.name = input.name;
		if (input.path !== undefined) patch.path = input.path;
		if (input.endpoint !== undefined) patch.endpoint = input.endpoint;
		if (input.bucket !== undefined) patch.bucket = input.bucket;
		if (input.region !== undefined) patch.region = input.region;
		if (input.pathPrefix !== undefined) patch.pathPrefix = input.pathPrefix;
		if (input.forcePathStyle !== undefined) patch.forcePathStyle = input.forcePathStyle;
		if (input.writeOnly !== undefined) patch.writeOnly = input.writeOnly;
		if (input.objectLock !== undefined) patch.objectLock = input.objectLock;
		if (input.accessKeyId !== undefined) patch.accessKeySealed = this.seal(row.orgId, input.accessKeyId);
		if (input.secretAccessKey !== undefined) patch.secretSealed = this.seal(row.orgId, input.secretAccessKey);
		this.ctx.db.update(backupTargets).set(patch).where(eq(backupTargets.id, id)).run();
		// Backups name their target in messages after it is gone; keep that name current.
		if (input.name !== undefined && input.name !== row.name)
			this.ctx.db.update(databaseBackups).set({ targetName: input.name }).where(eq(databaseBackups.targetId, id)).run();
		const view = this.toView(this.requireRow(id));
		this.ctx.audit.record({
			principal,
			action: 'backup-target.update',
			resource: 'backupTarget',
			resourceId: id,
			args: { name: view.name, fields: Object.keys(input) },
			result: 'ok',
		});
		return {
			target: view,
			credentials:
				input.accessKeyId !== undefined && input.secretAccessKey !== undefined
					? this.credentials(view, input.accessKeyId, input.secretAccessKey, 'rotated')
					: null,
		};
	}

	/**
	 * Delete a target. Refused while database backups that are still retained (ok, pending or
	 * running) were written to it: the sealed credentials are the only way Yoal can restore or
	 * prune those objects, so deleting them by accident would be unrecoverable. `force` deletes it
	 * anyway once nothing is in flight, and the backups are listed as unavailable until a target
	 * with the same location is added again. Objects are never deleted here.
	 */
	delete(principal: Principal, id: string, options: BackupTargetDeleteOptions = {}): { unavailableBackups: number } {
		this.requireMutationsEnabled();
		const row = this.requireMutableRow(principal, id);
		const held = this.retainedBackups(id);
		if (held.total > 0) {
			if (!options.force)
				throw new ConflictError(
					`Backup target "${row.name}" still holds ${countLabel(held.total, 'database backup')} that Yoal restores and prunes from it. ` +
						'Deleting it would discard the only credentials for those objects. Delete the backups first (yoal db backup-delete), ' +
						`wait for retention to remove them, or force the delete (yoal backup-target remove ${row.id} --force) to keep them listed as unavailable.`,
				);
			if (held.inFlight > 0)
				throw new ConflictError(
					`Backup target "${row.name}" has ${countLabel(held.inFlight, 'backup')} in progress. Wait for ${held.inFlight === 1 ? 'it' : 'them'} to finish before deleting the target.`,
				);
			if (held.restoring > 0)
				throw new ConflictError(
					`A database is being restored from a backup on "${row.name}". Wait for the restore to finish before deleting the target.`,
				);
		}
		this.ctx.db.delete(backupTargets).where(eq(backupTargets.id, id)).run();
		this.ctx.audit.record({
			principal,
			action: 'backup-target.delete',
			resource: 'backupTarget',
			resourceId: id,
			args: { name: row.name, kind: row.kind, force: options.force === true, unavailableBackups: held.total },
			result: 'ok',
		});
		return { unavailableBackups: held.total };
	}

	/** Probe the target, record the result and return it. Never includes credentials. */
	async testConnection(principal: Principal, id: string): Promise<BackupTargetTestResult> {
		this.requireMutationsEnabled();
		const row = this.requireMutableRow(principal, id);
		const target = this.toView(row);
		const result = await this.probe(target);
		this.ctx.db
			.update(backupTargets)
			.set({
				status: result.ok ? 'ok' : 'failed',
				lastCheckedAt: Date.parse(result.checkedAt),
				lastError: result.ok ? null : result.message,
				lastTestJson: JSON.stringify(result),
				updatedAt: this.ctx.now(),
			})
			.where(eq(backupTargets.id, id))
			.run();
		this.ctx.audit.record({
			principal,
			action: result.ok ? 'backup-target.test-ok' : 'backup-target.test-failed',
			resource: 'backupTarget',
			resourceId: id,
			args: { name: row.name, kind: row.kind, latencyMs: result.latencyMs },
			result: result.ok ? 'ok' : 'error',
			...(result.ok ? {} : { error: result.message.slice(0, 2_000) }),
		});
		return result;
	}

	// -------------------------------------------------------------- resolution

	/**
	 * Named target (when supplied) → the org's oldest target → the platform target → the local
	 * default directory under the data dir. A named target may be the platform default.
	 */
	resolveTarget(orgId: string, targetId?: string): BackupTargetResolution {
		if (targetId !== undefined) {
			const row = this.ctx.db.select().from(backupTargets).where(eq(backupTargets.id, targetId)).get();
			if (!row || (row.orgId !== null && row.orgId !== orgId)) throw new NotFoundError('Backup target');
			return { target: this.toView(row), source: 'resource' };
		}
		const org = this.ctx.db
			.select()
			.from(backupTargets)
			.where(eq(backupTargets.orgId, orgId))
			.orderBy(asc(backupTargets.createdAt))
			.get();
		if (org) return { target: this.toView(org), source: 'org' };
		const platform = this.ctx.db
			.select()
			.from(backupTargets)
			.where(isNull(backupTargets.orgId))
			.orderBy(asc(backupTargets.createdAt))
			.get();
		if (platform) return { target: this.toView(platform), source: 'platform' };
		return { target: this.localDefault(), source: 'local' };
	}

	/**
	 * Store for a resource. `source: 'local'` means no target is configured yet: return the
	 * platform object store unchanged, so existing installs keep their current backup location.
	 */
	storeFor(orgId: string, targetId?: string): ResolvedStore {
		const resolved = this.resolveTarget(orgId, targetId);
		return {
			...resolved,
			store: resolved.source === 'local' ? this.ctx.objectStore : this.objectStore(resolved.target),
		};
	}

	/** ObjectStore for a target row (or the synthetic local default). */
	objectStore(target: BackupTargetView): ObjectStore {
		if (target.kind === 'local') {
			if (!target.path) throw new ValidationError('A local backup target needs a path.');
			return new LocalObjectStore(
				target.pathPrefix ? join(target.path, target.pathPrefix) : target.path,
				this.ctx.config.platformOrigin,
				this.ctx.config.objectStoreSecret,
				`/api/backup-targets/${encodeURIComponent(target.id)}/objects/`,
			);
		}
		const row = this.ctx.db.select().from(backupTargets).where(eq(backupTargets.id, target.id)).get();
		if (!row?.accessKeySealed || !row.secretSealed)
			throw new ValidationError('This S3 backup target has no stored credentials.');
		if (!target.bucket) throw new ValidationError('An S3 backup target needs a bucket.');
		const region = target.region ?? 'us-east-1';
		return new S3ObjectStore({
			endpoint: target.endpoint ?? `https://s3.${region}.amazonaws.com`,
			bucket: target.bucket,
			region,
			forcePathStyle: target.forcePathStyle,
			prefix: target.pathPrefix || undefined,
			accessKeyId: this.open(row.orgId, row.accessKeySealed),
			secretAccessKey: this.open(row.orgId, row.secretSealed),
			fetch: this.ctx.config.storageFetch,
		});
	}

	/** Local store + target for the signed `/api/backup-targets/:id/objects/` route. */
	localStore(id: string): { target: BackupTargetView; store: LocalObjectStore } | null {
		const target = this.getById(id);
		if (!target || target.kind !== 'local' || !target.path) return null;
		const store = this.objectStore(target);
		if (!(store instanceof LocalObjectStore)) return null;
		return { target, store };
	}

	// ------------------------------------------------------ recorded backup locations

	/**
	 * What a new backup records: the target that applies now (or the named one) and a snapshot of
	 * its location.
	 */
	placementFor(orgId: string, targetId?: string): BackupPlacement {
		const resolved = this.resolveTarget(orgId, targetId);
		if (resolved.source === 'local')
			return { targetId: null, targetName: PLATFORM_STORE_NAME, locationJson: JSON.stringify({ kind: 'platform' }) };
		return {
			targetId: resolved.target.id,
			targetName: resolved.target.name,
			locationJson: JSON.stringify(snapshotOf(resolved.target)),
		};
	}

	/** Where a backup lives and whether Yoal can still reach it. Never opens credentials. */
	describeRecorded(backup: RecordedBackup): DatabaseBackupLocation {
		const recorded = this.recordedTarget(backup);
		return recorded.location;
	}

	/**
	 * Store for a backup as it was recorded, never the target that applies now. The location comes
	 * from the snapshot; credentials, region and write-only come from the live target row.
	 */
	openRecorded(backup: RecordedBackup): RecordedStore {
		const recorded = this.recordedTarget(backup);
		if (!recorded.available) return { available: false, reason: recorded.reason, location: recorded.location };
		if (recorded.row === null)
			return { available: true, store: this.ctx.objectStore, target: null, writeOnly: false, location: recorded.location };
		const live = this.toView(recorded.row);
		const snapshot = recorded.snapshot;
		const target: BackupTargetView =
			snapshot && snapshot.kind === live.kind
				? {
						...live,
						path: snapshot.path ?? live.path,
						endpoint: snapshot.endpoint !== undefined ? snapshot.endpoint : live.endpoint,
						bucket: snapshot.bucket ?? live.bucket,
						pathPrefix: snapshot.pathPrefix ?? live.pathPrefix,
					}
				: live;
		return { available: true, store: this.objectStore(target), target: live, writeOnly: live.writeOnly, location: recorded.location };
	}

	/** Like `openRecorded`, but throws a clear conflict when the backup cannot be reached. */
	requireRecorded(backup: RecordedBackup): Extract<RecordedStore, { available: true }> {
		const opened = this.openRecorded(backup);
		if (!opened.available) throw new ConflictError(opened.reason);
		return opened;
	}

	private recordedTarget(
		backup: RecordedBackup,
	):
		| { available: true; row: BackupTargetRow | null; snapshot: BackupLocationSnapshot | null; location: DatabaseBackupLocation }
		| { available: false; reason: string; location: DatabaseBackupLocation } {
		let snapshot = parseJson<BackupLocationSnapshot | null>(backup.locationJson, null);
		let targetId = backup.targetId;
		let name = backup.targetName;
		if (!snapshot) {
			// Written by a release before 0053 (or a rolled-back one): today's resolution is all we know.
			const resolved = this.resolveTarget(backup.orgId);
			targetId = resolved.source === 'local' ? null : resolved.target.id;
			name = resolved.source === 'local' ? PLATFORM_STORE_NAME : resolved.target.name;
			snapshot = resolved.source === 'local' ? { kind: 'platform' } : snapshotOf(resolved.target);
		}
		const base = {
			id: targetId,
			name: name ?? (targetId ? targetId : PLATFORM_STORE_NAME),
			kind: snapshot.kind,
			location: locationUri(snapshot, backup.objectKey, this.ctx.objectStore.kind),
		};
		if (targetId === null)
			return { available: true, row: null, snapshot, location: { ...base, available: true, unavailableReason: null } };
		const row = this.ctx.db.select().from(backupTargets).where(eq(backupTargets.id, targetId)).get();
		if (!row || (row.orgId !== null && row.orgId !== backup.orgId)) {
			const reason =
				`Backup target "${base.name}" (${targetId}) that this backup was written to has been deleted, so Yoal has no credentials for ${base.location}. ` +
				'The object was not removed. Add a backup target with the same location to reconnect it.';
			return { available: false, reason, location: { ...base, available: false, unavailableReason: reason } };
		}
		return {
			available: true,
			row,
			snapshot,
			location: { ...base, name: row.name, available: true, unavailableReason: null },
		};
	}

	/** Backups recorded on a target that Yoal may still need to read or delete. */
	private retainedBackups(targetId: string): { total: number; inFlight: number; restoring: number } {
		const rows = this.ctx.db
			.select({ id: databaseBackups.id, status: databaseBackups.status })
			.from(databaseBackups)
			.where(and(eq(databaseBackups.targetId, targetId), inArray(databaseBackups.status, [...RETAINED_BACKUP_STATUSES])))
			.all();
		if (rows.length === 0) return { total: 0, inFlight: 0, restoring: 0 };
		const ids = rows.map((row) => row.id);
		const restoring = this.ctx.db
			.select({ count: sql<number>`count(*)` })
			.from(databases)
			.where(inArray(databases.pendingRestoreId, ids))
			.get();
		return {
			total: rows.length,
			inFlight: rows.filter((row) => row.status !== 'ok').length,
			restoring: Number(restoring?.count ?? 0),
		};
	}

	/**
	 * A new target whose location matches backups left behind by a deleted target takes them over,
	 * so a mistaken (forced) delete is undone by adding the target again. An org target only adopts
	 * its own org's backups; a platform target only adopts backups written to a platform target.
	 */
	private reconnectOrphans(target: BackupTargetView): number {
		const candidates = this.ctx.db
			.select({
				id: databaseBackups.id,
				orgId: databaseBackups.orgId,
				targetId: databaseBackups.targetId,
				locationJson: databaseBackups.locationJson,
			})
			.from(databaseBackups)
			.leftJoin(backupTargets, eq(backupTargets.id, databaseBackups.targetId))
			.where(
				and(
					sql`${databaseBackups.targetId} IS NOT NULL`,
					isNull(backupTargets.id),
					target.orgId === null ? undefined : eq(databaseBackups.orgId, target.orgId),
				),
			)
			.all();
		const want = locationIdentity(snapshotOf(target));
		const ids = candidates
			.filter((row) => {
				const snapshot = parseJson<BackupLocationSnapshot | null>(row.locationJson, null);
				if (!snapshot || (snapshot.orgId ?? null) !== target.orgId) return false;
				return locationIdentity(snapshot) === want;
			})
			.map((row) => row.id);
		if (ids.length === 0) return 0;
		this.ctx.db
			.update(databaseBackups)
			.set({ targetId: target.id, targetName: target.name })
			.where(inArray(databaseBackups.id, ids))
			.run();
		return ids.length;
	}

	/** Write-only targets keep PutObject/ListBucket; a delete must use a privileged path. */
	assertDeleteAllowed(target: BackupTargetView): void {
		if (!target.writeOnly) return;
		throw new ConflictError(
			`Backup target "${target.name}" is write-only, so it cannot delete objects. Use a privileged target key for retention.`,
		);
	}

	// ---------------------------------------------------------------- helpers

	private async probe(target: BackupTargetView): Promise<BackupTargetTestResult> {
		const checkedAt = new Date(this.ctx.now()).toISOString();
		let raw;
		try {
			const store = this.objectStore(target);
			raw = store.testConnection ? await store.testConnection() : null;
		} catch (error) {
			return {
				ok: false,
				checkedAt,
				message: errorMessage(error).slice(0, 2_000),
				latencyMs: null,
				versioning: null,
				objectLock: null,
			};
		}
		if (!raw)
			return {
				ok: false,
				checkedAt,
				message: 'This store does not support connection checks.',
				latencyMs: null,
				versioning: null,
				objectLock: null,
			};
		const checks = raw.checks;
		const writeOnlyOk = checks.head && checks.put && checks.list;
		const ok = target.writeOnly ? writeOnlyOk : raw.ok;
		let message = ok
			? `Connected in ${raw.latencyMs} ms (` +
				`${checks.head ? 'bucket' : 'no bucket'}, ${checks.put ? 'put' : 'no put'}, ` +
				`${checks.list ? 'list' : 'no list'}, ${checks.delete ? 'delete' : 'delete denied'}).`
			: raw.error ?? 'The target did not pass the connection check.';
		if (target.writeOnly && ok && checks.delete)
			message += ' Warning: the key can delete objects, so it is not actually write-only.';
		if (target.writeOnly && ok && target.kind === 'local')
			message += ' Warning: a local directory cannot enforce write-only; use filesystem permissions.';
		if (target.objectLock && raw.objectLock === false && target.kind === 's3')
			message += ' Warning: object lock is recorded on the target but the bucket does not report it.';
		return {
			ok,
			checkedAt,
			message,
			latencyMs: raw.latencyMs,
			versioning: raw.versioning ?? null,
			objectLock: raw.objectLock ?? target.objectLock,
		};
	}

	private toView(row: BackupTargetRow): BackupTargetView {
		return {
			id: row.id,
			orgId: row.orgId,
			name: row.name,
			kind: row.kind,
			path: row.path,
			endpoint: row.endpoint,
			bucket: row.bucket,
			region: row.region,
			pathPrefix: row.pathPrefix,
			forcePathStyle: row.forcePathStyle,
			writeOnly: row.writeOnly,
			objectLock: row.objectLock,
			hasCredentials: Boolean(row.accessKeySealed && row.secretSealed),
			status: row.status,
			lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
			lastError: row.lastError,
			lastTest: parseJson<BackupTargetTestResult | null>(row.lastTestJson, null),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	private localDefault(): BackupTargetView {
		const now = new Date(this.ctx.now()).toISOString();
		return {
			id: LOCAL_DEFAULT_ID,
			orgId: null,
			name: 'local-default',
			kind: 'local',
			path: join(this.ctx.config.dataDir, 'backups'),
			endpoint: null,
			bucket: null,
			region: null,
			pathPrefix: '',
			forcePathStyle: true,
			writeOnly: false,
			objectLock: false,
			hasCredentials: false,
			status: 'ok',
			lastCheckedAt: null,
			lastError: null,
			lastTest: null,
			createdAt: now,
			updatedAt: now,
		};
	}

	private credentials(
		target: BackupTargetView,
		accessKeyId: string,
		secretAccessKey: string,
		reason: 'created' | 'rotated',
	): BackupTargetCredentials {
		return {
			targetId: target.id,
			name: target.name,
			kind: target.kind,
			accessKeyId,
			secretAccessKey,
			endpoint: target.endpoint,
			bucket: target.bucket,
			region: target.region,
			note: `Copy these now. They are ${reason} and cannot be shown again.`,
		};
	}

	private seal(orgId: string | null, value: string): string {
		return this.ctx.secrets.seal(orgId ?? PLATFORM_KEY_ORG, value);
	}

	private open(orgId: string | null, sealed: string): string {
		return this.ctx.secrets.open(orgId ?? PLATFORM_KEY_ORG, sealed);
	}

	private requireRow(id: string): BackupTargetRow {
		const row = this.ctx.db.select().from(backupTargets).where(eq(backupTargets.id, id)).get();
		if (!row) throw new NotFoundError('Backup target');
		return row;
	}

	private findVisible(principal: Principal, id: string): BackupTargetRow | null {
		const row = this.ctx.db.select().from(backupTargets).where(eq(backupTargets.id, id)).get();
		if (!row) return null;
		return row.orgId === null || row.orgId === principal.orgId ? row : null;
	}

	private requireMutableRow(principal: Principal, id: string): BackupTargetRow {
		const row = this.findVisible(principal, id);
		if (!row) throw new NotFoundError('Backup target');
		if (row.orgId === null) this.requirePlatformAdmin(principal);
		else this.ctx.iam.require(principal, 'database:update', { type: 'org' });
		return row;
	}

	private requirePlatformAdmin(principal: Principal): void {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new CoreError('forbidden', 'Only a platform admin role dashboard session can change the platform backup target.', 403);
	}

	private requireMutationsEnabled(): void {
		if (!featureEnabled(this.ctx.config, 'BACKUPS_RESTORE'))
			throw new CoreError('feature_disabled', 'Backup management is disabled by YOAL_FEATURE_BACKUPS_RESTORE.', 403);
	}
}

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function snapshotOf(target: BackupTargetView): BackupLocationSnapshot {
	return {
		kind: target.kind,
		orgId: target.orgId,
		path: target.path,
		endpoint: target.endpoint,
		bucket: target.bucket,
		region: target.region,
		pathPrefix: target.pathPrefix,
	};
}

/** What makes two locations the same place: kind, directory or endpoint+bucket, and prefix. */
function locationIdentity(snapshot: BackupLocationSnapshot): string {
	const prefix = (snapshot.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
	if (snapshot.kind === 'local') return `local|${(snapshot.path ?? '').replace(/\/+$/, '')}|${prefix}`;
	if (snapshot.kind === 's3')
		return `s3|${(snapshot.endpoint ?? `aws:${snapshot.region ?? 'us-east-1'}`).replace(/\/+$/, '')}|${snapshot.bucket ?? ''}|${prefix}`;
	return 'platform';
}

/** Human-readable exact object location for a recorded backup. */
export function locationUri(snapshot: BackupLocationSnapshot, key: string, platformKind: string): string {
	const prefix = (snapshot.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
	const keyed = prefix ? `${prefix}/${key}` : key;
	if (snapshot.kind === 'local') return `file://${join(snapshot.path ?? '/', keyed)}`;
	if (snapshot.kind === 's3') {
		const where = snapshot.endpoint ?? `AWS ${snapshot.region ?? 'us-east-1'}`;
		return `s3://${snapshot.bucket ?? '?'}/${keyed} (${where})`;
	}
	return `${PLATFORM_STORE_NAME} (${platformKind}): ${key}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const LOCAL_BACKUP_TARGET_ID = LOCAL_DEFAULT_ID;
