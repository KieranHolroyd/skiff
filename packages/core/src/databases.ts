import { and, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import {
	databaseAttachments,
	databaseBackups,
	databaseRotations,
	databases,
	nodes,
	projects,
	workloads,
} from '@skiff/db';
import {
	DATABASE_BACKUP_FORMAT,
	DATABASE_MONITOR_USER,
	DATABASE_POOLER_PORT_MAX,
	DATABASE_POOLER_PORT_MIN,
	DATABASE_PORT_MAX,
	DATABASE_PORT_MIN,
	databaseAlias,
	databaseAttachSchema,
	databaseBackupCreateSchema,
	databaseBackupPolicySchema,
	databaseCreateSchema,
	databaseEngineRegistry,
	databaseEnvNames,
	databaseIdentifier,
	databaseImage,
	databaseRestartSchema,
	databaseRestoreSchema,
	databaseRotateSchema,
	databaseUpdateSchema,
	limits,
	requirePermission,
	type DatabaseAttach,
	type DatabaseAttachmentView,
	type DatabaseBackupResult,
	type DatabaseBackupSummary,
	type DatabaseBackupTask,
	type DatabaseBackupView,
	type DatabaseCreate,
	type DatabaseCredentials,
	type DatabaseMetricBucket,
	type DatabaseMetricPoint,
	type DatabaseRotationActivation,
	type DatabaseRotationResult,
	type DatabaseRotationTask,
	type DatabaseRotationView,
	type DatabaseSnapshot,
	type DatabaseStatus,
	type DatabaseTableStat,
	type DatabaseUpdate,
	type DatabaseView,
	type Principal,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadRuntime,
	type WorkloadStatus,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { nextCronTime } from './cron.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { resolvePlacement } from './placement.ts';
import type { ProjectRow } from './projects.ts';
import type { VolumeRow } from './volumes.ts';
import { newId, parseJson, randomBytes, sha256Hex } from './util.ts';

export type DatabaseRow = typeof databases.$inferSelect;

const ACTIVE: DatabaseStatus[] = ['pending', 'starting', 'running'];
const DAY_MS = 86_400_000;
/** Presigned upload/download URLs handed to a node; regenerated on every desired-state pull. */
const BACKUP_TASK_TTL_SECONDS = 3_600;
const BACKUP_OBJECT_PREFIX = 'database-backups';

/** A consumer's view of one attachment, resolved for the node and runtime it runs on. */
interface ResolvedAttachment {
	databaseId: string;
	prefix: string;
	host: string;
	port: number;
	user: string;
	databaseName: string;
	scheme: string;
	row: DatabaseRow;
	poolerPort: number | null;
}

/**
 * Managed databases (docs/DATABASES.md, D55–D61). A database is an org resource that runs as a
 * tier-3 container on one node. Credentials are sealed with the org key; connection values reach
 * attached apps only at activation (D56, D58).
 */
export class DatabaseService {
	constructor(private readonly ctx: CoreContext) {}

	// ---------------------------------------------------------------- reads

	list(principal: Principal, options: { includeDeleted?: boolean } = {}): DatabaseView[] {
		requirePermission(principal, 'database:read');
		const filters = [eq(databases.orgId, principal.orgId)];
		if (!options.includeDeleted) filters.push(isNull(databases.deletedAt));
		return this.ctx.db
			.select()
			.from(databases)
			.where(and(...filters))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => this.toView(row));
	}

	get(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): DatabaseView {
		requirePermission(principal, 'database:read');
		return this.toView(this.requireRow(principal, name, options));
	}

	requireRow(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): DatabaseRow {
		const row = this.ctx.db
			.select()
			.from(databases)
			.where(and(eq(databases.orgId, principal.orgId), eq(databases.name, name)))
			.get();
		if (!row || (row.deletedAt && !options.includeDeleted)) throw new NotFoundError(`Database "${name}"`);
		return row;
	}

	// ---------------------------------------------------------------- lifecycle

	create(principal: Principal, raw: DatabaseCreate): DatabaseView {
		requirePermission(principal, 'database:create');
		const input = databaseCreateSchema.parse(raw);
		const info = databaseEngineRegistry[input.engine];
		const version = input.version ?? info.defaultVersion;
		const memoryMb = input.memoryMb ?? info.defaultMemoryMb;
		if (input.name.startsWith('pg-'))
			throw new ValidationError('Database names cannot start with "pg-" (Postgres reserves pg_ roles).');

		const existing = this.ctx.db
			.select({ id: databases.id, deletedAt: databases.deletedAt })
			.from(databases)
			.where(and(eq(databases.orgId, principal.orgId), eq(databases.name, input.name)))
			.get();
		if (existing)
			throw new ConflictError(
				existing.deletedAt
					? `Database "${input.name}" is in the trash. Restore it or pick another name.`
					: `Database "${input.name}" already exists.`,
			);

		let project: ProjectRow | null = null;
		let requested = input.placement;
		if (input.project) {
			requirePermission(principal, 'project:update');
			project = this.ctx.projects.requireRow(principal, input.project);
			if (project.runtime === 'static')
				throw new ValidationError(
					`Project "${project.slug}" is static; only process or container projects can use a database.`,
				);
			// Co-locate with the app (D56): its current workload node, else its placement request.
			const workloadNode = this.ctx.db
				.select({ nodeId: workloads.nodeId })
				.from(workloads)
				.where(eq(workloads.projectId, project.id))
				.get()?.nodeId;
			const pinned = this.ctx.workloads.attachmentNode(project.id);
			requested = pinned ?? workloadNode ?? project.placement;
		}

		// A named volume pins the node: the data dir has to be on the same node as the container.
		let volume: VolumeRow | null = null;
		if (input.volume) {
			volume = this.ctx.volumes.findByName(input.volume);
			const edgeNodeId = this.ctx.workloads.edgeNode();
			const target = requested === 'auto' ? null : requested === 'edge' ? edgeNodeId : requested;
			if (target && target !== volume.nodeId)
				throw new ValidationError(
					`Volume "${volume.name}" is on another node; place this database there or pick a volume on the target node.`,
				);
			requested = volume.nodeId;
		}

		const decision = resolvePlacement({
			runtime: 'container',
			requested,
			memoryMb,
			edgeNodeId: this.ctx.workloads.edgeNode(),
			candidates: this.ctx.workloads.placementCandidates(),
		});
		if (!decision.ok)
			throw new ValidationError(decision.message.replace('this app reserves', 'this database reserves'), decision.freeByNode);

		// No explicit volume: use the node's default, so an operator only sets it once.
		if (!volume) volume = this.ctx.volumes.defaultFor(decision.nodeId);
		if (volume) this.ctx.volumes.assertRoom(volume, input.storageMb);

		const id = newId('db_');
		const now = this.ctx.now();
		const hostPort = this.allocatePort(decision.nodeId);
		const poolerPort = input.pooler ? this.allocatePoolerPort(decision.nodeId) : null;
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.insert(databases)
				.values({
					id,
					orgId: principal.orgId,
					name: input.name,
					engine: input.engine,
					version,
					nodeId: decision.nodeId,
					hostPort,
					memoryMb,
					cpus: input.cpus,
					storageMb: input.storageMb,
					volumeId: volume?.id ?? null,
					extensionsJson: JSON.stringify(input.extensions),
					poolerEnabled: input.pooler,
					poolerPort,
					status: 'pending',
					ownerSecret: this.ctx.secrets.seal(principal.orgId, password()),
					monitorSecret: this.ctx.secrets.seal(principal.orgId, password()),
					nextBackupAt: nextCronTime('0 3 * * *', now),
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			if (project)
				this.insertAttachment(principal, id, project, input.envPrefix ?? 'DATABASE');
		})();
		this.ctx.audit.record({
			principal,
			action: 'database.create',
			resource: 'database',
			resourceId: id,
			args: {
				name: input.name,
				engine: input.engine,
				version,
				nodeId: decision.nodeId,
				memoryMb,
				...(volume ? { volume: volume.name } : {}),
				...(project ? { project: project.slug } : {}),
			},
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, input.name));
	}

	update(principal: Principal, name: string, raw: DatabaseUpdate): DatabaseView {
		requirePermission(principal, 'database:update');
		const patch = databaseUpdateSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const info = databaseEngineRegistry[row.engine];
		if (patch.memoryMb !== undefined) {
			if (patch.memoryMb < info.minMemoryMb)
				throw new ValidationError(`${info.label} needs at least ${info.minMemoryMb} MB.`);
			if (patch.memoryMb > row.memoryMb) this.admit(row, patch.memoryMb);
		}
		const { extensions, pooler, ...columns } = patch;
		const poolerEnabled = pooler ?? row.poolerEnabled;
		const poolerPort =
			pooler === false
				? null
				: row.poolerPort ?? (poolerEnabled ? this.allocatePoolerPort(row.nodeId) : null);
		this.ctx.db
			.update(databases)
			.set({
				...columns,
				...(extensions ? { extensionsJson: JSON.stringify(extensions) } : {}),
				poolerEnabled,
				poolerPort,
				updatedAt: this.ctx.now(),
			})
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.update',
			resource: 'database',
			resourceId: row.id,
			args: { name, ...patch },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	/** Soft delete (D59): the container stops, the data dir stays on the node for `trashDays`. */
	delete(principal: Principal, name: string): DatabaseView {
		requirePermission(principal, 'database:delete');
		const row = this.requireRow(principal, name);
		const attached = this.attachmentsOf(row.id);
		if (attached.length > 0)
			throw new ConflictError(
				`Database "${name}" is attached to ${attached.map((item) => item.projectSlug).join(', ')}. Detach it first.`,
			);
		const now = this.ctx.now();
		this.ctx.db
			.update(databases)
			.set({ deletedAt: now, purgeAt: now + limits.trashDays * DAY_MS, status: 'stopped', updatedAt: now })
			.where(eq(databases.id, row.id))
			.run();
		// A backup queued before the delete can no longer run; fail it rather than leaving a task
		// pending forever on a node that no longer receives the database.
		this.ctx.db
			.update(databaseBackups)
			.set({ status: 'failed', error: 'Database was deleted before the backup ran.', finishedAt: now })
			.where(and(eq(databaseBackups.databaseId, row.id), inArray(databaseBackups.status, ['pending', 'running'])))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.delete',
			resource: 'database',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name, { includeDeleted: true }));
	}

	restore(principal: Principal, name: string): DatabaseView {
		requirePermission(principal, 'database:delete');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!row.deletedAt) return this.toView(row);
		if (row.purgeRequestedAt)
			throw new ConflictError(`Database "${name}" is being purged and can no longer be restored.`);
		this.admit(row, row.memoryMb);
		this.ctx.volumes.assertVolumeReady(row.volumeId, row.storageMb);
		this.ctx.db
			.update(databases)
			.set({ deletedAt: null, purgeAt: null, status: 'pending', message: null, updatedAt: this.ctx.now() })
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.restore',
			resource: 'database',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	/** Permanently delete a trashed database now. The node deletes the data, then the row goes. */
	purgeNow(principal: Principal, name: string): void {
		requirePermission(principal, 'database:delete');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!row.deletedAt) throw new ConflictError(`Database "${name}" must be deleted before it can be purged.`);
		const now = this.ctx.now();
		this.ctx.db
			.update(databases)
			.set({ purgeAt: now, purgeRequestedAt: now, updatedAt: now })
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.purge',
			resource: 'database',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/** Maintenance sweep: hand expired trash to its node. Returns how many purges were requested. */
	requestExpiredPurges(): number {
		const now = this.ctx.now();
		const due = this.ctx.db
			.select({ id: databases.id })
			.from(databases)
			.where(
				and(
					isNotNull(databases.deletedAt),
					isNotNull(databases.purgeAt),
					lte(databases.purgeAt, now),
					isNull(databases.purgeRequestedAt),
				),
			)
			.all();
		if (due.length === 0) return 0;
		this.ctx.db
			.update(databases)
			.set({ purgeRequestedAt: now })
			.where(inArray(databases.id, due.map((row) => row.id)))
			.run();
		this.ctx.projects.bump();
		return due.length;
	}

	credentials(principal: Principal, name: string): DatabaseCredentials {
		requirePermission(principal, 'database:credentials');
		const row = this.requireRow(principal, name);
		const user = databaseIdentifier(row.name);
		const pass = this.ctx.secrets.open(row.orgId, row.ownerSecret);
		const info = databaseEngineRegistry[row.engine];
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
		this.ctx.audit.record({
			principal,
			action: 'database.credentials',
			resource: 'database',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		return {
			databaseId: row.id,
			name: row.name,
			username: user,
			password: pass,
			databaseName: user,
			url: connectionUrl(info.scheme, user, pass, '127.0.0.1', row.hostPort, user),
			host: '127.0.0.1',
			port: row.hostPort,
			note: `Listens on loopback on node "${node?.name ?? row.nodeId}" only. From elsewhere, tunnel: ssh -L ${row.hostPort}:127.0.0.1:${row.hostPort} <node>.`,
		};
	}

	// ---------------------------------------------------------------- restarts

	/**
	 * Restart the database container (and its pooler) by bumping the restart generation, or only
	 * the PgBouncer sidecar through a small request flag the node acknowledges.
	 */
	restart(principal: Principal, name: string, raw: unknown = {}): DatabaseView {
		requirePermission(principal, 'database:update');
		const input = databaseRestartSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const now = this.ctx.now();
		if (input.target === 'pooler') {
			if (!row.poolerEnabled || row.poolerPort === null)
				throw new ConflictError(`Database "${name}" does not have a pooler. Enable it first.`);
			this.ctx.db
				.update(databases)
				.set({ poolerRestartRequestedAt: now, updatedAt: now })
				.where(eq(databases.id, row.id))
				.run();
		} else {
			this.ctx.db
				.update(databases)
				.set({
					restartGeneration: row.restartGeneration + 1,
					message: 'Restart requested.',
					updatedAt: now,
				})
				.where(eq(databases.id, row.id))
				.run();
		}
		this.ctx.logs.appendServiceSystem({
			kind: 'database',
			serviceId: row.id,
			orgId: row.orgId,
			nodeId: row.nodeId,
			message:
				input.target === 'pooler'
					? 'Pooler restart requested.'
					: 'Database restart requested; the container and its pooler will restart.',
		});
		this.ctx.audit.record({
			principal,
			action: input.target === 'pooler' ? 'database.pooler-restart' : 'database.restart',
			resource: 'database',
			resourceId: row.id,
			args: { name, target: input.target },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, name));
	}

	poolerRestartTasksForNode(nodeId: string): string[] {
		return this.ctx.db
			.select({ id: databases.id })
			.from(databases)
			.where(
				and(
					eq(databases.nodeId, nodeId),
					eq(databases.poolerEnabled, true),
					isNotNull(databases.poolerRestartRequestedAt),
					isNull(databases.deletedAt),
				),
			)
			.all()
			.map((row) => row.id);
	}

	applyPoolerRestarted(nodeId: string, ids: string[]): void {
		let changed = false;
		for (const id of ids) {
			const row = this.ctx.db.select().from(databases).where(eq(databases.id, id)).get();
			if (!row || row.nodeId !== nodeId || row.poolerRestartRequestedAt === null) continue;
			this.ctx.db
				.update(databases)
				.set({ poolerRestartRequestedAt: null, updatedAt: this.ctx.now() })
				.where(eq(databases.id, id))
				.run();
			this.ctx.audit.record({
				orgId: row.orgId,
				action: 'database.pooler-restarted',
				resource: 'database',
				resourceId: id,
				args: { name: row.name },
				result: 'ok',
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	// ---------------------------------------------------------------- credential rotation

	rotations(principal: Principal, name: string): DatabaseRotationView[] {
		requirePermission(principal, 'database:read');
		const db = this.requireRow(principal, name, { includeDeleted: true });
		return this.ctx.db
			.select()
			.from(databaseRotations)
			.where(eq(databaseRotations.databaseId, db.id))
			.orderBy(desc(databaseRotations.createdAt))
			.all()
			.map(toRotationView);
	}

	/**
	 * Rotate the owner or monitor password. The new value is sealed in the rotation row and the
	 * node applies `ALTER ROLE`; the live secret is replaced only after the node confirms, so a
	 * failed rotation cannot lock an app out.
	 */
	rotateCredentials(principal: Principal, name: string, raw: unknown): DatabaseRotationView {
		requirePermission(principal, 'database:credentials');
		requirePermission(principal, 'database:update');
		const input = databaseRotateSchema.parse(raw);
		const db = this.requireRow(principal, name);
		const pending = this.ctx.db
			.select({ id: databaseRotations.id })
			.from(databaseRotations)
			.where(
				and(
					eq(databaseRotations.databaseId, db.id),
					inArray(databaseRotations.status, ['pending', 'running']),
				),
			)
			.get();
		if (pending) throw new ConflictError(`A ${input.role} rotation for "${name}" is already running.`);
		const id = newId('rot_');
		const now = this.ctx.now();
		this.ctx.db
			.insert(databaseRotations)
			.values({
				id,
				orgId: db.orgId,
				databaseId: db.id,
				role: input.role,
				status: 'pending',
				secretSealed: this.ctx.secrets.seal(db.orgId, password()),
				createdBy: principal.userId,
				createdAt: now,
			})
			.run();
		this.ctx.logs.appendServiceSystem({
			kind: 'database',
			serviceId: db.id,
			orgId: db.orgId,
			nodeId: db.nodeId,
			message: `${input.role === 'owner' ? 'Owner' : 'Monitor'} credential rotation requested.`,
		});
		this.ctx.audit.record({
			principal,
			action: 'database.rotate',
			resource: 'database',
			resourceId: db.id,
			args: { name, role: input.role, rotationId: id },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.rotations(principal, name)[0]!;
	}

	rotationTasksForNode(nodeId: string): DatabaseRotationTask[] {
		return this.ctx.db
			.select({ rotation: databaseRotations, db: databases })
			.from(databaseRotations)
			.innerJoin(databases, eq(databases.id, databaseRotations.databaseId))
			.where(
				and(
					eq(databases.nodeId, nodeId),
					eq(databaseRotations.status, 'pending'),
					isNull(databases.deletedAt),
				),
			)
			.all()
			.map(({ rotation }) => ({
				id: rotation.id,
				databaseId: rotation.databaseId,
				role: rotation.role,
			}));
	}

	rotationActivation(nodeId: string, id: string): DatabaseRotationActivation {
		const row = this.ctx.db
			.select({ rotation: databaseRotations, db: databases })
			.from(databaseRotations)
			.innerJoin(databases, eq(databases.id, databaseRotations.databaseId))
			.where(eq(databaseRotations.id, id))
			.get();
		if (!row || row.db.nodeId !== nodeId)
			throw new CoreError('forbidden', 'This rotation is not on this node.', 403);
		if (row.rotation.status !== 'pending' && row.rotation.status !== 'running')
			throw new ConflictError('This rotation has already finished.');
		return {
			id: row.rotation.id,
			databaseId: row.db.id,
			role: row.rotation.role,
			password: this.ctx.secrets.open(row.db.orgId, row.rotation.secretSealed),
		};
	}

	applyRotationResults(nodeId: string, results: DatabaseRotationResult[]): void {
		const now = this.ctx.now();
		let changed = false;
		for (const result of results) {
			const row = this.ctx.db
				.select({ rotation: databaseRotations, db: databases })
				.from(databaseRotations)
				.innerJoin(databases, eq(databases.id, databaseRotations.databaseId))
				.where(eq(databaseRotations.id, result.taskId))
				.get();
			if (!row || row.db.nodeId !== nodeId) continue;
			if (row.rotation.status === 'ok' || row.rotation.status === 'failed') continue;
			if (result.status === 'ok') {
				this.ctx.sqlite.transaction(() => {
					this.ctx.db
						.update(databases)
						.set({
							...(result.role === 'owner'
								? { ownerSecret: row.rotation.secretSealed }
								: { monitorSecret: row.rotation.secretSealed }),
							message: null,
							updatedAt: now,
						})
						.where(eq(databases.id, row.db.id))
						.run();
					this.ctx.db
						.update(databaseRotations)
						.set({ status: 'ok', finishedAt: now, error: null })
						.where(eq(databaseRotations.id, row.rotation.id))
						.run();
				})();
			} else {
				this.ctx.db
					.update(databaseRotations)
					.set({
						status: 'failed',
						finishedAt: now,
						error: result.error ?? 'Rotation failed on the node.',
					})
					.where(eq(databaseRotations.id, row.rotation.id))
					.run();
				this.ctx.db
					.update(databases)
					.set({ message: `Credential rotation failed: ${result.error ?? 'unknown error'}`, updatedAt: now })
					.where(eq(databases.id, row.db.id))
					.run();
			}
			this.ctx.audit.record({
				orgId: row.db.orgId,
				action: result.status === 'ok' ? 'database.rotate-ok' : 'database.rotate-failed',
				resource: 'database',
				resourceId: row.db.id,
				args: { name: row.db.name, role: result.role, rotationId: row.rotation.id },
				result: result.status === 'ok' ? 'ok' : 'error',
				...(result.status === 'ok' ? {} : { error: result.error ?? 'Rotation failed on the node.' }),
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	// ---------------------------------------------------------------- backups

	/** Backup policy and last known result for one database. */
	backupSummary(row: DatabaseRow): DatabaseBackupSummary {
		return {
			enabled: row.backupEnabled,
			schedule: row.backupSchedule,
			retentionDays: row.backupRetentionDays,
			nextBackupAt: row.nextBackupAt ? new Date(row.nextBackupAt).toISOString() : null,
			lastBackupAt: row.lastBackupAt ? new Date(row.lastBackupAt).toISOString() : null,
			lastBackupStatus: row.lastBackupStatus ?? null,
			lastBackupError: row.lastBackupError,
			lastVerifiedAt: row.lastVerifiedAt ? new Date(row.lastVerifiedAt).toISOString() : null,
			pendingRestoreId: row.pendingRestoreId,
		};
	}

	backupPolicy(principal: Principal, name: string): DatabaseBackupSummary {
		requirePermission(principal, 'database:read');
		return this.backupSummary(this.requireRow(principal, name));
	}

	setBackupPolicy(principal: Principal, name: string, raw: unknown): DatabaseBackupSummary {
		requirePermission(principal, 'database:update');
		const patch = databaseBackupPolicySchema.parse(raw);
		const row = this.requireRow(principal, name);
		const schedule = patch.schedule ?? row.backupSchedule;
		const enabled = patch.enabled ?? row.backupEnabled;
		if (enabled) {
			const next = nextCronTime(schedule, this.ctx.now());
			if (next === null)
				throw new ValidationError(`Backup schedule "${schedule}" never fires; check the cron fields.`);
		}
		const now = this.ctx.now();
		this.ctx.db
			.update(databases)
			.set({
				backupEnabled: enabled,
				backupSchedule: schedule,
				...(patch.retentionDays !== undefined ? { backupRetentionDays: patch.retentionDays } : {}),
				nextBackupAt: enabled ? nextCronTime(schedule, now) : null,
				updatedAt: now,
			})
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.backup-policy',
			resource: 'database',
			resourceId: row.id,
			args: { name, ...patch },
			result: 'ok',
		});
		return this.backupSummary(this.requireRow(principal, name));
	}

	listBackups(principal: Principal, name: string, options: { includeDeleted?: boolean } = {}): DatabaseBackupView[] {
		requirePermission(principal, 'database:read');
		const db = this.requireRow(principal, name, options);
		return this.ctx.db
			.select()
			.from(databaseBackups)
			.where(eq(databaseBackups.databaseId, db.id))
			.orderBy(desc(databaseBackups.createdAt))
			.all()
			.map((row) => this.toBackupView(row, db.name));
	}

	getBackup(principal: Principal, name: string, backupId: string): DatabaseBackupView {
		requirePermission(principal, 'database:read');
		const db = this.requireRow(principal, name, { includeDeleted: true });
		const row = this.ctx.db
			.select()
			.from(databaseBackups)
			.where(and(eq(databaseBackups.id, backupId), eq(databaseBackups.databaseId, db.id)))
			.get();
		if (!row) throw new NotFoundError('Backup');
		return this.toBackupView(row, db.name);
	}

	/** Queue a dump now. The node picks it up on its next desired-state pull. */
	createBackup(principal: Principal, name: string, raw: unknown = {}): DatabaseBackupView {
		requirePermission(principal, 'database:update');
		const input = databaseBackupCreateSchema.parse(raw);
		const db = this.requireRow(principal, name);
		const pending = this.ctx.db
			.select({ id: databaseBackups.id })
			.from(databaseBackups)
			.where(and(eq(databaseBackups.databaseId, db.id), inArray(databaseBackups.status, ['pending', 'running'])))
			.get();
		if (pending) throw new ConflictError(`A backup for "${name}" is already running.`);
		const now = this.ctx.now();
		const id = newId('bkp_');
		this.ctx.db
			.insert(databaseBackups)
			.values({
				id,
				orgId: db.orgId,
				databaseId: db.id,
				kind: 'manual',
				status: 'pending',
				objectKey: backupObjectKey(db.orgId, db.id, id),
				pinned: input.pinned,
				createdBy: principal.userId,
				createdAt: now,
				expiresAt: now + db.backupRetentionDays * DAY_MS,
			})
			.run();
		this.ctx.db
			.update(databases)
			.set({ lastBackupStatus: 'pending', lastBackupError: null, updatedAt: now })
			.where(eq(databases.id, db.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.backup',
			resource: 'database',
			resourceId: db.id,
			args: { name, backupId: id },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.getBackup(principal, name, id);
	}

	/** Delete one artifact. The object goes first; a missing object is treated as already gone. */
	async deleteBackup(principal: Principal, name: string, backupId: string): Promise<void> {
		requirePermission(principal, 'database:delete');
		const db = this.requireRow(principal, name, { includeDeleted: true });
		const backup = this.ctx.db
			.select()
			.from(databaseBackups)
			.where(and(eq(databaseBackups.id, backupId), eq(databaseBackups.databaseId, db.id)))
			.get();
		if (!backup) throw new NotFoundError('Backup');
		if (backup.status === 'pending' || backup.status === 'running')
			throw new ConflictError('Wait for the backup to finish before deleting it.');
		if (db.pendingRestoreId === backup.id)
			throw new ConflictError('This backup is being restored into a database right now.');
		const resolved = this.ctx.backupTargets.storeFor(db.orgId);
		this.ctx.backupTargets.assertDeleteAllowed(resolved.target);
		await resolved.store.delete(backup.objectKey).catch(() => undefined);
		this.ctx.db.delete(databaseBackups).where(eq(databaseBackups.id, backup.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'database.backup-delete',
			resource: 'database',
			resourceId: db.id,
			args: { name, backupId },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/**
	 * Restore a backup into a brand-new database (the default and the only mode in v1). The new
	 * instance gets new credentials and is marked `pendingRestoreId` until its node confirms the
	 * `pg_restore` succeeded; consumers can attach it immediately.
	 */
	restoreBackup(principal: Principal, sourceName: string, backupId: string, raw: unknown): DatabaseView {
		requirePermission(principal, 'database:create');
		const source = this.requireRow(principal, sourceName, { includeDeleted: true });
		const backup = this.ctx.db
			.select()
			.from(databaseBackups)
			.where(and(eq(databaseBackups.id, backupId), eq(databaseBackups.databaseId, source.id)))
			.get();
		if (!backup) throw new NotFoundError('Backup');
		if (backup.status !== 'ok')
			throw new ConflictError(`Backup "${backupId}" is ${backup.status}; only a completed backup can be restored.`);
		const input = databaseRestoreSchema.parse(raw);
		const created = this.create(principal, {
			name: input.name,
			engine: source.engine,
			version: source.version,
			placement: input.placement,
			...(input.memoryMb !== undefined ? { memoryMb: input.memoryMb } : {}),
			...(input.cpus !== undefined ? { cpus: input.cpus } : {}),
			...(input.storageMb !== undefined ? { storageMb: input.storageMb } : {}),
			...(input.volume !== undefined ? { volume: input.volume } : {}),
			...(input.project !== undefined ? { project: input.project } : {}),
			...(input.envPrefix !== undefined ? { envPrefix: input.envPrefix } : {}),
			extensions: parseJson(source.extensionsJson, []),
			pooler: source.poolerEnabled,
		});
		const row = this.requireRow(principal, input.name);
		this.ctx.db
			.update(databases)
			.set({
				pendingRestoreId: backup.id,
				// No scheduled dump can fire while the new instance is still being restored.
				backupEnabled: false,
				nextBackupAt: null,
				message: `Restoring backup ${backup.id}.`,
				updatedAt: this.ctx.now(),
			})
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.restore-backup',
			resource: 'database',
			resourceId: row.id,
			args: { source: sourceName, backupId, name: input.name },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, input.name));
	}

	/**
	 * Maintenance: queue one scheduled backup per database whose `nextBackupAt` is due. A database
	 * with a pending/running backup is skipped so a slow dump cannot pile up.
	 */
	tickBackups(now = this.ctx.now()): number {
		const due = this.ctx.db
			.select()
			.from(databases)
			.where(
				and(
					isNull(databases.deletedAt),
					eq(databases.backupEnabled, true),
					isNotNull(databases.nextBackupAt),
					lte(databases.nextBackupAt, now),
				),
			)
			.all();
		let queued = 0;
		for (const db of due) {
			const busy = this.ctx.db
				.select({ id: databaseBackups.id })
				.from(databaseBackups)
				.where(
					and(
						eq(databaseBackups.databaseId, db.id),
						inArray(databaseBackups.status, ['pending', 'running']),
					),
				)
				.get();
			const next = nextCronTime(db.backupSchedule, now);
			if (busy || next === null) {
				this.ctx.db
					.update(databases)
					.set({
						nextBackupAt: next,
						...(next === null
							? {
									backupEnabled: false,
									lastBackupError: `Backup schedule "${db.backupSchedule}" never fires.`,
								}
							: {}),
						updatedAt: now,
					})
					.where(eq(databases.id, db.id))
					.run();
				continue;
			}
			const id = newId('bkp_');
			this.ctx.sqlite.transaction(() => {
				this.ctx.db
					.insert(databaseBackups)
					.values({
						id,
						orgId: db.orgId,
						databaseId: db.id,
						kind: 'scheduled',
						status: 'pending',
						objectKey: backupObjectKey(db.orgId, db.id, id),
						createdBy: 'system',
						createdAt: now,
						expiresAt: now + db.backupRetentionDays * DAY_MS,
					})
					.run();
				this.ctx.db
					.update(databases)
					.set({
						nextBackupAt: next,
						lastBackupStatus: 'pending',
						lastBackupError: null,
						updatedAt: now,
					})
					.where(eq(databases.id, db.id))
					.run();
			})();
			this.ctx.audit.record({
				orgId: db.orgId,
				action: 'database.backup',
				resource: 'database',
				resourceId: db.id,
				args: { name: db.name, backupId: id, scheduled: true },
				result: 'ok',
			});
			queued += 1;
		}
		if (queued > 0) this.ctx.projects.bump();
		return queued;
	}

	/**
	 * Tasks for one node. Presigned URLs expire in an hour; a pending task whose URL expired is
	 * regenerated on the next pull without changing the backup row.
	 */
	async backupTasksForNode(nodeId: string): Promise<DatabaseBackupTask[]> {
		const tasks: DatabaseBackupTask[] = [];
		const backups = this.ctx.db
			.select({ backup: databaseBackups, db: databases })
			.from(databaseBackups)
			.innerJoin(databases, eq(databases.id, databaseBackups.databaseId))
			.where(and(eq(databases.nodeId, nodeId), eq(databaseBackups.status, 'pending'), isNull(databases.deletedAt)))
			.all();
		for (const { backup, db } of backups) {
			const { store } = this.ctx.backupTargets.storeFor(db.orgId);
			tasks.push({
				id: backup.id,
				action: 'backup',
				databaseId: db.id,
				databaseName: databaseIdentifier(db.name),
				engine: db.engine,
				backupId: null,
				objectKey: backup.objectKey,
				url: await store.presignPut(backup.objectKey, BACKUP_TASK_TTL_SECONDS, 'application/octet-stream'),
				format: DATABASE_BACKUP_FORMAT,
			});
		}
		const restores = this.ctx.db
			.select()
			.from(databases)
			.where(and(eq(databases.nodeId, nodeId), isNotNull(databases.pendingRestoreId), isNull(databases.deletedAt)))
			.all();
		for (const db of restores) {
			const backup = this.ctx.db
				.select()
				.from(databaseBackups)
				.where(eq(databaseBackups.id, db.pendingRestoreId!))
				.get();
			if (!backup) continue;
			const { store } = this.ctx.backupTargets.storeFor(db.orgId);
			tasks.push({
				id: `restore:${db.id}`,
				action: 'restore',
				databaseId: db.id,
				databaseName: databaseIdentifier(db.name),
				engine: db.engine,
				backupId: backup.id,
				objectKey: backup.objectKey,
				url: await store.presignGet(backup.objectKey, BACKUP_TASK_TTL_SECONDS),
				format: DATABASE_BACKUP_FORMAT,
			});
		}
		return tasks;
	}

	/** Record dump/restore outcomes from a node's heartbeat. */
	applyBackupResults(nodeId: string, results: DatabaseBackupResult[]): void {
		const now = this.ctx.now();
		let changed = false;
		for (const result of results) {
			if (result.action === 'backup') {
				const backup = this.ctx.db
					.select({ backup: databaseBackups, db: databases })
					.from(databaseBackups)
					.innerJoin(databases, eq(databases.id, databaseBackups.databaseId))
					.where(eq(databaseBackups.id, result.taskId))
					.get();
				if (!backup || backup.db.nodeId !== nodeId) continue;
				if (backup.backup.status === 'ok' || backup.backup.status === 'failed') continue;
				const ok = result.status === 'ok';
				this.ctx.db
					.update(databaseBackups)
					.set({
						status: ok ? 'ok' : 'failed',
						sizeBytes: result.sizeBytes ?? backup.backup.sizeBytes,
						sha256: result.sha256 ?? backup.backup.sha256,
						error: ok ? null : result.error ?? 'Backup failed on the node.',
						startedAt: backup.backup.startedAt ?? now,
						finishedAt: now,
					})
					.where(eq(databaseBackups.id, backup.backup.id))
					.run();
				this.ctx.db
					.update(databases)
					.set({
						lastBackupAt: ok ? now : backup.db.lastBackupAt,
						lastBackupStatus: ok ? 'ok' : 'failed',
						lastBackupError: ok ? null : result.error ?? 'Backup failed on the node.',
						updatedAt: now,
					})
					.where(eq(databases.id, backup.db.id))
					.run();
				this.ctx.audit.record({
					orgId: backup.db.orgId,
					action: ok ? 'database.backup-ok' : 'database.backup-failed',
					resource: 'database',
					resourceId: backup.db.id,
					args: { name: backup.db.name, backupId: backup.backup.id, sizeBytes: result.sizeBytes ?? null },
					result: ok ? 'ok' : 'error',
					...(ok ? {} : { error: result.error ?? 'Backup failed on the node.' }),
				});
				changed = true;
				continue;
			}

			const db = this.ctx.db
				.select()
				.from(databases)
				.where(and(eq(databases.id, result.databaseId), eq(databases.nodeId, nodeId)))
				.get();
			if (!db || !db.pendingRestoreId) continue;
			const backup = this.ctx.db
				.select()
				.from(databaseBackups)
				.where(eq(databaseBackups.id, db.pendingRestoreId))
				.get();
			if (!backup) continue;
			const ok = result.status === 'ok';
			this.ctx.db
				.update(databases)
				.set({
					pendingRestoreId: null,
					message: ok ? null : `Restore failed: ${result.error ?? 'unknown error'}`,
					status: ok ? db.status : 'running',
					backupEnabled: ok,
					nextBackupAt: ok ? nextCronTime(db.backupSchedule, now) : null,
					lastVerifiedAt: ok ? now : db.lastVerifiedAt,
					updatedAt: now,
				})
				.where(eq(databases.id, db.id))
				.run();
			if (ok) {
				this.ctx.db
					.update(databaseBackups)
					.set({ verifiedAt: now, restoredDatabaseId: db.id })
					.where(eq(databaseBackups.id, backup.id))
					.run();
			}
			this.ctx.audit.record({
				orgId: db.orgId,
				action: ok ? 'database.restore-backup-ok' : 'database.restore-backup-failed',
				resource: 'database',
				resourceId: db.id,
				args: { name: db.name, backupId: backup.id },
				result: ok ? 'ok' : 'error',
				...(ok ? {} : { error: result.error ?? 'Restore failed on the node.' }),
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	/** Retention sweep; never deletes a pinned backup or the newest good backup of a database. */
	async pruneBackups(now = this.ctx.now()): Promise<number> {
		const candidates = this.ctx.db
			.select({ backup: databaseBackups, db: databases })
			.from(databaseBackups)
			.innerJoin(databases, eq(databases.id, databaseBackups.databaseId))
			.where(
				and(
					eq(databaseBackups.status, 'ok'),
					eq(databaseBackups.pinned, false),
					isNotNull(databaseBackups.expiresAt),
					lte(databaseBackups.expiresAt, now),
				),
			)
			.all();
		let removed = 0;
		for (const { backup, db } of candidates) {
			const newest = this.ctx.db
				.select({ id: databaseBackups.id })
				.from(databaseBackups)
				.where(and(eq(databaseBackups.databaseId, db.id), eq(databaseBackups.status, 'ok')))
				.orderBy(desc(databaseBackups.createdAt))
				.limit(1)
				.get();
			if (newest?.id === backup.id) continue;
			const resolved = this.ctx.backupTargets.storeFor(db.orgId);
			if (resolved.target.writeOnly) continue;
			await resolved.store.delete(backup.objectKey).catch(() => undefined);
			this.ctx.db.delete(databaseBackups).where(eq(databaseBackups.id, backup.id)).run();
			removed += 1;
		}
		if (removed > 0) this.ctx.projects.bump();
		return removed;
	}

	private toBackupView(row: typeof databaseBackups.$inferSelect, databaseName: string): DatabaseBackupView {
		return {
			id: row.id,
			databaseId: row.databaseId,
			databaseName,
			kind: row.kind,
			status: row.status,
			format: DATABASE_BACKUP_FORMAT,
			sizeBytes: row.sizeBytes,
			sha256: row.sha256,
			objectKey: row.objectKey,
			pinned: row.pinned,
			error: row.error,
			verifiedAt: row.verifiedAt ? new Date(row.verifiedAt).toISOString() : null,
			restoredDatabaseId: row.restoredDatabaseId,
			startedAt: new Date(row.startedAt ?? row.createdAt).toISOString(),
			finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
			expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
		};
	}

	// ---------------------------------------------------------------- attachments

	attachments(principal: Principal, project: ProjectRow): DatabaseAttachmentView[] {
		requirePermission(principal, 'database:read');
		return this.attachmentsForProject(project.id);
	}

	attach(
		principal: Principal,
		project: ProjectRow,
		raw: DatabaseAttach,
	): { attachment: DatabaseAttachmentView; warning: string | null } {
		requirePermission(principal, 'database:update');
		requirePermission(principal, 'project:update');
		const input = databaseAttachSchema.parse(raw);
		if (project.runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static; only process or container projects can use a database.`,
			);
		const row = this.requireRow(principal, input.database);
		const current = this.attachmentsForProject(project.id);
		if (current.some((item) => item.databaseId === row.id))
			throw new ConflictError(`Database "${row.name}" is already attached to "${project.slug}".`);
		if (current.some((item) => item.envPrefix === input.envPrefix))
			throw new ConflictError(
				`"${project.slug}" already uses the env prefix ${input.envPrefix}. Pick another, e.g. ${input.envPrefix}_2.`,
			);
		const others = new Set(current.map((item) => this.rowById(item.databaseId)?.nodeId).filter(Boolean));
		if (others.size > 0 && !others.has(row.nodeId))
			throw new ValidationError(
				`"${project.slug}" already uses a database on another node. Attached databases must share a node (D56).`,
			);
		const storageNode = this.ctx.storage.requiredNode(project.id);
		if (storageNode && storageNode !== row.nodeId)
			throw new ValidationError(
				`"${project.slug}" uses private storage on another node. Databases and private storage must share a node (D56).`,
			);
		const placementProblem = this.placementConflict(project, row.nodeId);
		if (placementProblem) throw new ValidationError(placementProblem);

		this.insertAttachment(principal, row.id, project, input.envPrefix);
		this.ctx.audit.record({
			principal,
			action: 'database.attach',
			resource: 'database',
			resourceId: row.id,
			args: { name: row.name, project: project.slug, envPrefix: input.envPrefix },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);

		const workloadNode = this.ctx.db
			.select({ nodeId: workloads.nodeId })
			.from(workloads)
			.where(eq(workloads.projectId, project.id))
			.get()?.nodeId;
		const warning =
			workloadNode && workloadNode !== row.nodeId
				? `"${project.slug}" currently runs on another node. Redeploy it to move it next to "${row.name}"; until then it gets no ${input.envPrefix}_URL.`
				: workloadNode
					? null
					: `"${project.slug}" has no running workload yet. Its next deploy is placed next to "${row.name}".`;
		const attachment = this.attachmentsForProject(project.id).find((item) => item.databaseId === row.id)!;
		return { attachment, warning };
	}

	detach(principal: Principal, project: ProjectRow, name: string): void {
		requirePermission(principal, 'database:update');
		requirePermission(principal, 'project:update');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		const result = this.ctx.sqlite.run('DELETE FROM database_attachments WHERE database_id = ? AND project_id = ?', [
			row.id,
			project.id,
		]);
		if (result.changes === 0) throw new NotFoundError(`Attachment of "${name}" to "${project.slug}"`);
		this.ctx.audit.record({
			principal,
			action: 'database.detach',
			resource: 'database',
			resourceId: row.id,
			args: { name, project: project.slug },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
	}

	/**
	 * The node every database attached to this project lives on, or null with no attachments.
	 * WorkloadService pins the project's placement to it at deploy time (D56).
	 */
	requiredNode(projectId: string): string | null {
		const rows = this.liveAttachmentRows(projectId);
		const nodeIds = [...new Set(rows.map(({ db }) => db.nodeId))];
		if (nodeIds.length > 1)
			throw new ValidationError('Attached databases live on different nodes; detach one so they share a node.');
		return nodeIds[0] ?? null;
	}

	/** Problem message when a project's explicit placement can't reach a database on `nodeId`. */
	placementConflict(project: ProjectRow, nodeId: string): string | null {
		if (project.placement === 'auto' || project.placement === nodeId) return null;
		if (project.placement === 'edge' && this.ctx.workloads.edgeNode() === nodeId) return null;
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get();
		return `"${project.slug}" is placed on "${project.placement}" but the database runs on "${node?.name ?? nodeId}". Set the project's placement to "auto" or that node; databases are reachable on their own node only (D56).`;
	}

	/**
	 * Env vars one consumer workload receives, resolved for its node and runtime. Databases on
	 * another node are skipped (the next deploy moves the app next to them).
	 */
	consumerEnv(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): Record<string, string> {
		const env: Record<string, string> = {};
		for (const item of this.resolveForConsumer(projectId, nodeId, runtime)) {
			const pass = this.ctx.secrets.open(item.row.orgId, item.row.ownerSecret);
			env[`${item.prefix}_URL`] = connectionUrl(item.scheme, item.user, pass, item.host, item.port, item.databaseName);
			env[`${item.prefix}_HOST`] = item.host;
			env[`${item.prefix}_PORT`] = String(item.port);
			env[`${item.prefix}_USER`] = item.user;
			env[`${item.prefix}_PASSWORD`] = pass;
			env[`${item.prefix}_NAME`] = item.databaseName;
			if (item.poolerPort !== null) {
				const poolHost = runtime === 'container' ? `${databaseAlias(item.databaseId)}-pool` : '127.0.0.1';
				const poolPort = runtime === 'container' ? 6432 : item.poolerPort;
				env[`${item.prefix}_POOL_URL`] = connectionUrl(
					item.scheme,
					item.user,
					pass,
					poolHost,
					poolPort,
					item.databaseName,
				);
				env[`${item.prefix}_POOL_HOST`] = poolHost;
				env[`${item.prefix}_POOL_PORT`] = String(poolPort);
			}
		}
		return env;
	}

	/**
	 * Stable fingerprint of a consumer's attachments (no secret values), folded into its activation
	 * version so attach/detach re-activates the app. Empty string when nothing applies.
	 */
	consumerVersion(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): string {
		const items = this.resolveForConsumer(projectId, nodeId, runtime).map((item) => ({
			id: item.databaseId,
			prefix: item.prefix,
			host: item.host,
			port: item.port,
			poolerPort: item.poolerPort,
		}));
		return items.length === 0 ? '' : sha256Hex(JSON.stringify(items));
	}

	// ---------------------------------------------------------------- node protocol

	/** Live databases placed on a node, as container workloads with the database profile. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		return this.ctx.db
			.select()
			.from(databases)
			.where(and(eq(databases.nodeId, nodeId), isNull(databases.deletedAt)))
			.all()
			.map((row) => {
				const user = databaseIdentifier(row.name);
				const env = { POSTGRES_USER: user, POSTGRES_DB: user, PGDATA: '/data/pgdata' };
				return {
					id: row.id,
					projectId: row.id,
					projectSlug: row.name,
					deploymentId: row.id,
					runtime: 'container' as const,
					// Desired, not observed: a database on this list must run. Echoing a reported
					// `stopped` back would make the agent remove the unit and never start it again.
					status: 'running' as const,
					release: null,
					image: databaseImage(row.engine, row.version),
					upstream: `127.0.0.1:${row.hostPort}`,
					memoryMb: row.memoryMb,
					cpus: row.cpus,
					port: row.hostPort,
					healthPath: '/',
					socketActivation: false,
					activationVersion: databaseActivationVersion(row, env),
					env,
					secrets: [],
					dataSizeMb: null,
					...(row.volumeId ? { volumeId: row.volumeId } : {}),
					database: { engine: row.engine, version: row.version },
					...(row.poolerEnabled && row.poolerPort ? { pooler: { port: row.poolerPort } } : {}),
				};
			});
	}

	/** Trashed databases whose purge is due on this node (D59). */
	purgesForNode(nodeId: string): string[] {
		return this.ctx.db
			.select({ id: databases.id })
			.from(databases)
			.where(and(eq(databases.nodeId, nodeId), isNotNull(databases.deletedAt), isNotNull(databases.purgeRequestedAt)))
			.all()
			.map((row) => row.id);
	}

	isDatabaseId(id: string): boolean {
		return id.startsWith('db_');
	}

	activation(nodeId: string, id: string): WorkloadActivation {
		const row = this.ctx.db.select().from(databases).where(eq(databases.id, id)).get();
		if (!row || row.deletedAt) throw new NotFoundError('Database');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This database is placed on another node.', 403);
		const user = databaseIdentifier(row.name);
		const ownerPassword = this.ctx.secrets.open(row.orgId, row.ownerSecret);
		const env = { POSTGRES_USER: user, POSTGRES_DB: user, PGDATA: '/data/pgdata' };
		return {
			workloadId: row.id,
			activationVersion: databaseActivationVersion(row, env),
			env: { POSTGRES_PASSWORD: ownerPassword },
			files: {},
			databaseSetup: { extensions: parseJson<string[]>(row.extensionsJson, []) },
			monitor: {
				databaseName: user,
				ownerUser: user,
				ownerPassword,
				monitorUser: DATABASE_MONITOR_USER,
				monitorPassword: this.ctx.secrets.open(row.orgId, row.monitorSecret),
				port: row.hostPort,
			},
		};
	}

	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		for (const report of reports) {
			if (!this.isDatabaseId(report.id)) continue;
			const row = this.rowById(report.id);
			if (!row || row.nodeId !== nodeId || row.deletedAt) continue;
			const status: DatabaseStatus = report.status === 'running' && report.restarts >= 5 ? 'failed' : report.status;
			if (status === row.status) {
				if (status === 'running' && row.message === 'Restart requested.')
					this.ctx.db
						.update(databases)
						.set({ message: null, updatedAt: this.ctx.now() })
						.where(eq(databases.id, row.id))
						.run();
				continue;
			}
			this.ctx.db
				.update(databases)
				.set({
					status,
					message: report.restarts >= 5 ? `Restart loop (${report.restarts} restarts)` : null,
					updatedAt: this.ctx.now(),
				})
				.where(eq(databases.id, row.id))
				.run();
		}
	}

	/** The node deleted these data dirs; drop the rows (D59). */
	applyPurged(nodeId: string, ids: string[]): void {
		for (const id of ids) {
			const row = this.rowById(id);
			if (!row || row.nodeId !== nodeId || !row.deletedAt || !row.purgeRequestedAt) continue;
			const backups = this.ctx.db
				.select({ key: databaseBackups.objectKey })
				.from(databaseBackups)
				.where(eq(databaseBackups.databaseId, id))
				.all();
			for (const backup of backups) {
				const resolved = this.ctx.backupTargets.storeFor(row.orgId);
				if (!resolved.target.writeOnly)
					void resolved.store.delete(backup.key).catch(() => undefined);
			}
			this.ctx.sqlite.transaction(() => {
				this.ctx.db.delete(databaseAttachments).where(eq(databaseAttachments.databaseId, id)).run();
				this.ctx.db.delete(databaseRotations).where(eq(databaseRotations.databaseId, id)).run();
				this.ctx.db.delete(databaseBackups).where(eq(databaseBackups.databaseId, id)).run();
				this.ctx.db.delete(databases).where(eq(databases.id, id)).run();
			})();
			this.ctx.audit.record({
				orgId: row.orgId,
				action: 'database.purged',
				resource: 'database',
				resourceId: id,
				args: { name: row.name, nodeId },
				result: 'ok',
			});
		}
		if (ids.length > 0) this.ctx.projects.bump();
	}

	/**
	 * Telemetry from a node (D57). Samples for databases not placed on that node are dropped, the
	 * latest size and table snapshot go to SQLite, and the time series goes to DuckDB.
	 */
	async ingestTelemetry(
		nodeId: string,
		buckets: DatabaseMetricBucket[],
		snapshots: DatabaseSnapshot[],
	): Promise<{ stored: number }> {
		const owned = new Set(
			this.ctx.db
				.select({ id: databases.id })
				.from(databases)
				.where(eq(databases.nodeId, nodeId))
				.all()
				.map((row) => row.id),
		);
		const accepted = buckets.filter((bucket) => owned.has(bucket.databaseId));
		const latest = new Map<string, DatabaseMetricBucket>();
		for (const bucket of accepted) {
			const previous = latest.get(bucket.databaseId);
			if (!previous || previous.bucket < bucket.bucket) latest.set(bucket.databaseId, bucket);
		}
		for (const [id, bucket] of latest) {
			if (!bucket.up) continue;
			this.ctx.db.update(databases).set({ sizeBytes: bucket.sizeBytes }).where(eq(databases.id, id)).run();
		}
		for (const snapshot of snapshots) {
			if (!owned.has(snapshot.databaseId)) continue;
			const at = Date.parse(snapshot.at);
			const statsAt = Number.isFinite(at) ? at : this.ctx.now();
			this.ctx.db
				.update(databases)
				.set({
					statsJson: JSON.stringify(snapshot.tables),
					statsAt,
					...(snapshot.slowQueries
						? { slowQueriesJson: JSON.stringify(snapshot.slowQueries), slowQueriesAt: statsAt }
						: {}),
				})
				.where(eq(databases.id, snapshot.databaseId))
				.run();
		}
		if (accepted.length === 0 || !this.ctx.telemetry) return { stored: 0 };
		const result = await this.ctx.telemetry.ingestDatabaseMetrics(accepted);
		return { stored: result.inserted };
	}

	async metrics(
		principal: Principal,
		name: string,
		input: { from: string | number | Date; to: string | number | Date; interval?: '1m' | '1h' },
	): Promise<DatabaseMetricPoint[]> {
		requirePermission(principal, 'database:read');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (!this.ctx.telemetry) return [];
		return this.ctx.telemetry.queryDatabaseMetrics({
			databaseId: row.id,
			from: input.from,
			to: input.to,
			interval: input.interval ?? '1m',
		});
	}

	/** Databases near their limits, for the maintenance alert pass. */
	alertCandidates(): Array<{ row: DatabaseRow; kind: 'storage'; ratio: number }> {
		return this.ctx.db
			.select()
			.from(databases)
			.where(and(isNull(databases.deletedAt), isNotNull(databases.sizeBytes)))
			.all()
			.flatMap((row) => {
				const ratio = (row.sizeBytes ?? 0) / (row.storageMb * 1024 * 1024);
				return ratio >= 0.85 ? [{ row, kind: 'storage' as const, ratio }] : [];
			});
	}

	/** Memory reserved by live databases per node (D42 admission). */
	reservedByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; total: number | null }, [string, string, string]>(
				`SELECT node_id AS nodeId, SUM(memory_mb) AS total FROM databases
				 WHERE deleted_at IS NULL AND status IN (?, ?, ?) GROUP BY node_id`,
			)
			.all(...(ACTIVE as [string, string, string]));
		return new Map(rows.map((row) => [row.nodeId, row.total ?? 0]));
	}

	countByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; n: number }, []>(
				'SELECT node_id AS nodeId, COUNT(*) AS n FROM databases WHERE deleted_at IS NULL GROUP BY node_id',
			)
			.all();
		return new Map(rows.map((row) => [row.nodeId, row.n]));
	}

	// ---------------------------------------------------------------- internals

	private rowById(id: string): DatabaseRow | undefined {
		return this.ctx.db.select().from(databases).where(eq(databases.id, id)).get();
	}

	/** Admission for a database growing to (or coming back with) `memoryMb` on its node. */
	private admit(row: DatabaseRow, memoryMb: number): void {
		const capacity = this.ctx.workloads.capacityInternal().find((item) => item.nodeId === row.nodeId);
		if (!capacity) throw new ValidationError('The database node is no longer registered.');
		const counted = !row.deletedAt && ACTIVE.includes(row.status) ? row.memoryMb : 0;
		const free = capacity.freeMemoryMb + counted;
		if (free < memoryMb)
			throw new ValidationError(
				`Node "${capacity.name}" only has ${free} MB of workload budget free, but this database needs ${memoryMb} MB.`,
			);
	}

	private allocatePort(nodeId: string): number {
		const used = new Set(
			this.ctx.db
				.select({ port: databases.hostPort })
				.from(databases)
				.where(eq(databases.nodeId, nodeId))
				.all()
				.map((row) => row.port),
		);
		for (let port = DATABASE_PORT_MIN; port <= DATABASE_PORT_MAX; port++) if (!used.has(port)) return port;
		throw new ValidationError('This node has no free database ports left.');
	}

	private allocatePoolerPort(nodeId: string): number {
		const used = new Set(
			this.ctx.db
				.select({ port: databases.poolerPort })
				.from(databases)
				.where(and(eq(databases.nodeId, nodeId), isNotNull(databases.poolerPort)))
				.all()
				.flatMap((row) => (row.port === null ? [] : [row.port])),
		);
		for (let port = DATABASE_POOLER_PORT_MIN; port <= DATABASE_POOLER_PORT_MAX; port++)
			if (!used.has(port)) return port;
		throw new ValidationError('This node has no free database pooler ports left.');
	}

	private insertAttachment(principal: Principal, databaseId: string, project: ProjectRow, envPrefix: string): void {
		this.ctx.db
			.insert(databaseAttachments)
			.values({
				id: newId('dba_'),
				orgId: project.orgId,
				databaseId,
				projectId: project.id,
				envPrefix,
				createdBy: principal.userId,
				createdAt: this.ctx.now(),
			})
			.run();
	}

	private attachmentsOf(databaseId: string): DatabaseAttachmentView[] {
		return this.attachmentViews(eq(databaseAttachments.databaseId, databaseId));
	}

	private attachmentsForProject(projectId: string): DatabaseAttachmentView[] {
		return this.attachmentViews(eq(databaseAttachments.projectId, projectId));
	}

	private attachmentViews(filter: ReturnType<typeof eq>): DatabaseAttachmentView[] {
		return this.ctx.db
			.select({ attachment: databaseAttachments, db: databases, project: projects })
			.from(databaseAttachments)
			.innerJoin(databases, eq(databases.id, databaseAttachments.databaseId))
			.innerJoin(projects, eq(projects.id, databaseAttachments.projectId))
			.where(and(filter, isNull(projects.deletedAt)))
			.all()
			.map(({ attachment, db, project }) => ({
				databaseId: db.id,
				databaseName: db.name,
				projectId: project.id,
				projectSlug: project.slug,
				envPrefix: attachment.envPrefix,
				envNames: databaseEnvNames(attachment.envPrefix),
				createdAt: new Date(attachment.createdAt).toISOString(),
			}))
			.sort((a, b) => a.projectSlug.localeCompare(b.projectSlug) || a.databaseName.localeCompare(b.databaseName));
	}

	private liveAttachmentRows(projectId: string): Array<{ db: DatabaseRow; prefix: string }> {
		return this.ctx.db
			.select({ attachment: databaseAttachments, db: databases })
			.from(databaseAttachments)
			.innerJoin(databases, eq(databases.id, databaseAttachments.databaseId))
			.where(and(eq(databaseAttachments.projectId, projectId), isNull(databases.deletedAt)))
			.all()
			.map(({ attachment, db }) => ({ db, prefix: attachment.envPrefix }))
			.sort((a, b) => a.prefix.localeCompare(b.prefix));
	}

	private resolveForConsumer(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): ResolvedAttachment[] {
		if (!nodeId) return [];
		return this.liveAttachmentRows(projectId)
			.filter(({ db }) => db.nodeId === nodeId)
			.map(({ db, prefix }) => {
				const info = databaseEngineRegistry[db.engine];
				const user = databaseIdentifier(db.name);
				const container = runtime === 'container';
				return {
					databaseId: db.id,
					prefix,
					host: container ? databaseAlias(db.id) : '127.0.0.1',
					port: container ? info.containerPort : db.hostPort,
					user,
					databaseName: user,
					scheme: info.scheme,
					row: db,
					poolerPort: db.poolerEnabled ? db.poolerPort : null,
				};
			});
	}

	private toView(row: DatabaseRow): DatabaseView {
		const info = databaseEngineRegistry[row.engine];
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
		const user = databaseIdentifier(row.name);
		return {
			id: row.id,
			name: row.name,
			engine: row.engine,
			engineLabel: info.label,
			version: row.version,
			status: row.status,
			message: row.message,
			nodeId: row.nodeId,
			nodeName: node?.name ?? null,
			memoryMb: row.memoryMb,
			cpus: row.cpus,
			storageMb: row.storageMb,
			sizeBytes: row.sizeBytes,
			databaseName: user,
			username: user,
			internalHost: {
				process: `127.0.0.1:${row.hostPort}`,
				container: `${databaseAlias(row.id)}:${info.containerPort}`,
			},
			pooler: {
				enabled: row.poolerEnabled && row.poolerPort !== null,
				host: {
					process: row.poolerPort ? `127.0.0.1:${row.poolerPort}` : '',
					container: row.poolerPort ? `${databaseAlias(row.id)}-pool:6432` : '',
				},
				port: row.poolerPort,
			},
			volume: this.ctx.volumes.summary(row.volumeId),
			attachments: this.attachmentsOf(row.id),
			tables: parseJson<DatabaseTableStat[]>(row.statsJson, []),
			statsAt: row.statsAt ? new Date(row.statsAt).toISOString() : null,
			extensions: parseJson(row.extensionsJson, []),
			slowQueries: parseJson(row.slowQueriesJson, []),
			slowQueriesAt: row.slowQueriesAt ? new Date(row.slowQueriesAt).toISOString() : null,
			backup: this.backupSummary(row),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
			purgeAt: row.purgeAt ? new Date(row.purgeAt).toISOString() : null,
		};
	}
}

function password(): string {
	return Buffer.from(randomBytes(24)).toString('base64url');
}

function connectionUrl(scheme: string, user: string, pass: string, host: string, port: number, db: string): string {
	return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${encodeURIComponent(db)}`;
}

function toRotationView(row: typeof databaseRotations.$inferSelect): DatabaseRotationView {
	return {
		id: row.id,
		databaseId: row.databaseId,
		role: row.role,
		status: row.status,
		error: row.error,
		createdAt: new Date(row.createdAt).toISOString(),
		finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
	};
}

function backupObjectKey(orgId: string, databaseId: string, backupId: string): string {
	return `${BACKUP_OBJECT_PREFIX}/${orgId}/${databaseId}/${backupId}.dump`;
}

function databaseActivationVersion(row: DatabaseRow, env: Record<string, string>): string {
	return sha256Hex(
		JSON.stringify({
			id: row.id,
			// Bump when the fixed helper profile changes and existing units must be re-rendered.
			profile: 2,
			engine: row.engine,
			version: row.version,
			port: row.hostPort,
			poolerPort: row.poolerPort,
			restartGeneration: row.restartGeneration,
			env,
			extensions: row.extensionsJson,
			// A rotated secret must re-activate consumers even though the public spec is unchanged.
			secret: sha256Hex(`${row.ownerSecret}:${row.monitorSecret}`),
		}),
	);
}
