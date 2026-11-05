import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { backupTargets } from '@skiff/db';
import {
	backupTargetCreateSchema,
	backupTargetUpdateSchema,
	canAdministerPlatform,
	requirePermission,
	type BackupTargetCredentials,
	type BackupTargetResolution,
	type BackupTargetTestResult,
	type BackupTargetView,
	type Principal,
} from '@skiff/contracts';
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

export class BackupTargetService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal): BackupTargetView[] {
		requirePermission(principal, 'database:read');
		return this.ctx.db
			.select()
			.from(backupTargets)
			.where(or(eq(backupTargets.orgId, principal.orgId), isNull(backupTargets.orgId)))
			.orderBy(asc(backupTargets.createdAt))
			.all()
			.map((row) => this.toView(row));
	}

	get(principal: Principal, id: string): BackupTargetView {
		requirePermission(principal, 'database:read');
		const row = this.findVisible(principal, id);
		if (!row) throw new NotFoundError('Backup target');
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
		else requirePermission(principal, 'database:update');
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

	delete(principal: Principal, id: string): void {
		this.requireMutationsEnabled();
		const row = this.requireMutableRow(principal, id);
		this.ctx.db.delete(backupTargets).where(eq(backupTargets.id, id)).run();
		this.ctx.audit.record({
			principal,
			action: 'backup-target.delete',
			resource: 'backupTarget',
			resourceId: id,
			args: { name: row.name, kind: row.kind },
			result: 'ok',
		});
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
		else requirePermission(principal, 'database:update');
		return row;
	}

	private requirePlatformAdmin(principal: Principal): void {
		if (!canAdministerPlatform(principal))
			throw new CoreError('forbidden', 'Only a platform admin dashboard session can change the platform backup target.', 403);
	}

	private requireMutationsEnabled(): void {
		if (!featureEnabled(this.ctx.config, 'BACKUPS_RESTORE'))
			throw new CoreError('feature_disabled', 'Backup management is disabled by SKIFF_FEATURE_BACKUPS_RESTORE.', 403);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const LOCAL_BACKUP_TARGET_ID = LOCAL_DEFAULT_ID;
