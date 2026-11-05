import { and, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import {
	databaseAttachments,
	databaseBackups,
	databasePitr,
	databasePitrTasks,
	databaseCredentials,
	databaseRotations,
	databases,
	nodes,
	projects,
	workloads,
} from '@skiff/db';
import {
	DATABASE_BACKUP_FORMAT,
	DATABASE_MONITOR_USER,
	DATABASE_PORT_MAX,
	DATABASE_PORT_MIN,
	PITR_ARCHIVE_TIMEOUT_SECONDS,
	PITR_DIFF_SCHEDULE,
	PITR_FULL_SCHEDULE,
	PITR_RETENTION_DIFF,
	PITR_RETENTION_FULL,
	DATABASE_CONSOLE_PORT_MAX,
	DATABASE_CONSOLE_PORT_MIN,
	DATABASE_POOLER_PORT_MAX,
	DATABASE_POOLER_PORT_MIN,
	databaseAlias,
	databaseAttachSchema,
	databaseConsoleHost,
	databaseConsoleOpenSchema,
	databaseBackupCreateSchema,
	databaseBackupPolicySchema,
	databaseConnectionSnippets,
	databaseConnectionUrl,
	databaseCreateSchema,
	databaseCredentialCreateSchema,
	databaseEngineRegistry,
	databaseEnvNames,
	databaseIdentifier,
	databaseImage,
	databasePitrBackupSchema,
	databasePitrPolicySchema,
	databasePitrRestoreSchema,
	databasePublicUrlUpdateSchema,
	databaseRestartSchema,
	databaseRestoreSchema,
	databaseRotateSchema,
	databaseUpdateSchema,
	orgNetworkName,
	databaseUpgradeSchema,
	limits,
	pitrStanzaFor,
	requirePermission,
	validatePitrTargetTime,
	type DatabaseAttach,
	type DatabaseAttachmentView,
	type DatabaseBackupResult,
	type DatabaseBackupSummary,
	type DatabaseBackupTask,
	type DatabaseBackupView,
	type DatabaseConsoleActivation,
	type DatabaseConsoleResult,
	type DatabaseConsoleStatus,
	type DatabaseConsoleTask,
	type DatabaseConsoleView,
	type DatabaseCreate,
	type DatabaseCredentialActivation,
	type DatabaseCredentialCreate,
	type DatabaseCredentialResult,
	type DatabaseCredentialTask,
	type DatabaseCredentialView,
	type DatabaseCredentials,
	type DatabaseMetricBucket,
	type DatabaseMetricPoint,
	type DatabasePitrActivation,
	type DatabasePitrResult,
	type DatabasePitrStatus,
	type DatabasePitrTask,
	type DatabasePublicUrlReveal,
	type DatabasePublicUrlView,
	type DatabaseRotationActivation,
	type DatabaseRotationResult,
	type DatabaseRotationTask,
	type DatabaseRotationView,
	type DatabaseSnapshot,
	type DatabaseSslMode,
	type DatabaseStatus,
	type DatabaseTableStat,
	type DatabaseUpdate,
	type DatabaseUpgradeInput,
	type DatabaseUpgradePlan,
	type DatabaseUpgradeStep,
	type DatabaseView,
	type Principal,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadRuntime,
	type WorkloadStatus,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { nextCronTime } from './cron.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { resolvePlacement } from './placement.ts';
import type { ProjectRow } from './projects.ts';
import type { VolumeRow } from './volumes.ts';
import { isPostgresMajorChange, postgresMajor } from './upgrade-plan.ts';
import { newId, parseJson, randomBytes, sha256Hex } from './util.ts';

export type DatabaseRow = typeof databases.$inferSelect;

const ACTIVE: DatabaseStatus[] = ['pending', 'starting', 'running'];
const DAY_MS = 86_400_000;
/** Presigned upload/download URLs handed to a node; regenerated on every desired-state pull. */
const BACKUP_TASK_TTL_SECONDS = 3_600;
const BACKUP_OBJECT_PREFIX = 'database-backups';
/** Full backups are kept ~4 weeks; differentials cover the rest of the retention window. */
const PITR_RETENTION_DAYS = PITR_RETENTION_FULL * 7 + PITR_RETENTION_DIFF;
const PITR_SCHEDULER_KIND = 'database.pitr.basebackup';

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
	/**
	 * Latest TLS state reported by nodes, keyed by database id. It is derived from the helper's
	 * certificate files and deliberately not persisted: a control-plane restart loses only the CA
	 * PEM until the next heartbeat (10 s), never the certificate itself.
	 */
	private readonly tlsReports = new Map<string, { caPem: string | null; error: string | null }>();

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
		this.ctx.quota.assertCanCreateDatabase(principal.orgId, project?.id, input.storageMb, memoryMb);

		const id = newId('db_');
		const now = this.ctx.now();
		const hostPort = this.allocatePort(decision.nodeId);
		const poolerPort = input.pooler ? this.allocatePoolerPort(decision.nodeId) : null;
		const ownerSecret = this.ctx.secrets.seal(principal.orgId, password());
		const monitorSecret = this.ctx.secrets.seal(principal.orgId, password());
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
					ownerSecret,
					monitorSecret,
					nextBackupAt: nextCronTime('0 3 * * *', now),
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			this.insertBuiltInCredentials(principal, id, input.name, ownerSecret, monitorSecret);
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
		const projectId = this.attachmentsOf(row.id)[0]?.projectId;
		if (patch.storageMb !== undefined || patch.memoryMb !== undefined)
			this.ctx.quota.assertCanResizeDatabase(
				principal.orgId,
				projectId,
				{ storageMb: row.storageMb, memoryMb: row.memoryMb },
				{
					...(patch.storageMb !== undefined ? { storageMb: patch.storageMb } : {}),
					...(patch.memoryMb !== undefined ? { memoryMb: patch.memoryMb } : {}),
				},
			);
		if (patch.version !== undefined && patch.version !== row.version) {
			if (!info.versions.includes(patch.version))
				throw new ValidationError(`${info.label} versions: ${info.versions.join(', ')}.`);
			if (isPostgresMajorChange(row.version, patch.version))
				throw new ConflictError(
					`PostgreSQL ${row.version} → ${patch.version} is a major-version upgrade. ` +
						`Run \`skif db upgrade ${name} --to ${patch.version} --plan\`; the platform never switches a Postgres major automatically.`
				);
		}
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

	/**
	 * A PostgreSQL major upgrade is a data-layer operation, never a row update. Plan it, refuse
	 * when it cannot be reversed, and—on `apply`—queue a pinned backup and return the runbook.
	 * The platform deliberately does not start the version switch itself in this release.
	 */
	upgradeDatabase(principal: Principal, name: string, raw: DatabaseUpgradeInput): DatabaseUpgradePlan {
		requirePermission(principal, 'database:update');
		const input = databaseUpgradeSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const info = databaseEngineRegistry[row.engine];
		if (!info.versions.includes(input.targetVersion))
			throw new ValidationError(`${info.label} versions: ${info.versions.join(', ')}.`);
		const fromMajor = postgresMajor(row.version);
		const toMajor = postgresMajor(input.targetVersion);
		if (!fromMajor || !toMajor)
			throw new ValidationError(`Cannot compare PostgreSQL version "${row.version}" with "${input.targetVersion}".`);
		if (fromMajor === toMajor)
			throw new ValidationError(
				`${row.version} → ${input.targetVersion} is not a major change; use \`skif db update\` for a maintenance update.`
			);

		const blockers: string[] = [];
		const warnings: string[] = [];
		if (row.pendingRestoreId) blockers.push('A backup restore is running on this database.');
		const busy = this.ctx.db
			.select({ id: databaseBackups.id })
			.from(databaseBackups)
			.where(and(eq(databaseBackups.databaseId, row.id), inArray(databaseBackups.status, ['pending', 'running'])))
			.get();
		if (busy) blockers.push('Wait for the in-flight backup to finish.');
		if (row.status !== 'running' && row.status !== 'stopped')
			blockers.push(`The database is ${row.status}; start it and verify it is healthy first.`);
		const attachments = this.attachmentsOf(row.id);
		if (attachments.length > 0)
			warnings.push(
				`Attached projects (${attachments.map((item) => item.projectSlug).join(', ')}) must be stopped for the duration of the dump/restore.`
			);
		const extensions = parseJson<string[]>(row.extensionsJson, []);
		if (extensions.length > 0)
			warnings.push(
				`Verify extension compatibility for ${extensions.join(', ')} in PostgreSQL ${input.targetVersion}; missing extensions block the restore.`
			);
		warnings.push(
			'The old data directory is kept until the new instance passes a canary and a row-count check. Re-pointing it back is the rollback path.'
		);

		const steps: DatabaseUpgradeStep[] = [
			{
				id: 'freeze',
				title: 'Stop consumers',
				detail:
					attachments.length > 0
						? `Stop or detach ${attachments.map((item) => item.projectSlug).join(', ')} so no writes occur during the dump.`
						: 'Confirm no external clients are connected; the database listens on loopback only (D56).',
				automatic: false
			},
			{
				id: 'backup',
				title: 'Take a pinned backup',
				detail: input.apply
					? 'Queued a manual pinned backup; wait for it to reach status ok before continuing.'
					: 'Queue a manual pinned backup and verify it reaches status ok.',
				automatic: true
			},
			{
				id: 'preflight',
				title: 'Run pg_upgrade --check or verify dump/restore',
				detail:
					`Run \`pg_upgrade --check\` in the PostgreSQL ${input.targetVersion} image if available. ` +
					'Otherwise export with pg_dump (custom format) and verify it restores into a scratch instance of the new major.',
				automatic: false
			},
			{
				id: 'upgrade',
				title: 'Switch the data directory',
				detail:
					`Use the new PostgreSQL ${input.targetVersion} image with a new data dir (pg_upgrade) or restore the dump into it. ` +
					'Never point an old major at a data dir written by a newer major.',
				automatic: false
			},
			{
				id: 'verify',
				title: 'Verify and run a canary',
				detail: 'Check row counts, the expected extensions, and attach one non-production consumer before switching production.',
				automatic: false
			}
		];

		let backupId: string | null = null;
		if (input.apply && blockers.length === 0) {
			const backup = this.createBackup(principal, name, { pinned: true });
			backupId = backup.id;
		}
		const status: DatabaseUpgradePlan['status'] =
			blockers.length > 0 ? 'blocked' : input.apply ? 'manual' : 'planned';
		this.ctx.audit.record({
			principal,
			action: input.apply ? 'database.upgrade-request' : 'database.upgrade-plan',
			resource: 'database',
			resourceId: row.id,
			args: {
				name,
				from: row.version,
				to: input.targetVersion,
				apply: input.apply,
				backupId,
				blockers: blockers.length
			},
			result: blockers.length > 0 ? 'error' : 'ok'
		});
		return {
			databaseId: row.id,
			name: row.name,
			fromVersion: row.version,
			toVersion: input.targetVersion,
			majorChange: true,
			status,
			mode: 'dump-restore',
			blockers,
			warnings,
			steps,
			backupId,
			docs: 'docs/OPS.md#425-postgres-major-upgrades',
			message:
				status === 'manual'
					? `Pre-upgrade backup ${backupId} is queued. Follow the steps, then update the database version only after the new instance is verified.`
					: status === 'blocked'
						? `This major upgrade is blocked: ${blockers.join(' ')}`
						: 'Plan only. Re-run with --apply to queue the pinned pre-upgrade backup.'
		};
	}

	/** Soft delete (D59): the container stops, the data dir stays on the node for `trashDays`. */	delete(principal: Principal, name: string): DatabaseView {
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
			.set({
				deletedAt: now,
				purgeAt: now + limits.trashDays * DAY_MS,
				status: 'stopped',
				// The workload removal also removes the studio sidecar; clear the session so a
				// restore never advertises a console that is no longer running.
				consoleRequested: false,
				consoleStatus: 'stopped',
				consolePort: null,
				consoleSecret: null,
				consoleExpiresAt: null,
				consoleError: null,
				updatedAt: now
			})
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
		this.ctx.quota.assertCanCreateDatabase(
			principal.orgId,
			this.attachmentsOf(row.id)[0]?.projectId,
			row.storageMb,
			row.memoryMb,
		);
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
		const tls = this.tlsState(row);
		const directUrl = databaseConnectionUrl({
			scheme: info.scheme,
			user,
			pass,
			host: '127.0.0.1',
			port: row.hostPort,
			database: user,
			sslmode: tls.mode,
		});
		const poolerUrl =
			row.poolerEnabled && row.poolerPort !== null
				? databaseConnectionUrl({
						scheme: info.scheme,
						user,
						pass,
						host: '127.0.0.1',
						port: row.poolerPort,
						database: user,
						sslmode: tls.mode,
					})
				: null;
		const tlsNote = tls.enabled
			? 'TLS is on; use sslmode=require (or verify-full with the CA).'
			: 'TLS is off; enable SKIFF_FEATURE_DB_TLS to encrypt connections.';
		return {
			databaseId: row.id,
			name: row.name,
			username: user,
			password: pass,
			databaseName: user,
			url: directUrl,
			directUrl,
			poolerUrl,
			host: '127.0.0.1',
			port: row.hostPort,
			sslmode: tls.mode,
			tlsEnabled: tls.enabled,
			caPem: tls.caPem,
			connectionSnippets: databaseConnectionSnippets({
				directUrl,
				poolerUrl,
				sslmode: tls.mode,
				caPem: tls.caPem,
			}),
			note: `${tlsNote} Listens on loopback on node "${node?.name ?? row.nodeId}" only. From elsewhere, tunnel: ssh -L ${row.hostPort}:127.0.0.1:${row.hostPort} <node>. Use the direct URL for migrations and session-only features.`,
		};
	}

	// ---------------------------------------------------------------- public connection URL

	/** Metadata only: whether a public URL exists and when it was last set. */
	publicUrl(principal: Principal, name: string): DatabasePublicUrlView {
		requirePermission(principal, 'database:read');
		return this.publicUrlView(this.requireRow(principal, name));
	}

	/**
	 * Store an operator-managed public URL. The value is sealed with the org key before it touches
	 * SQLite; the URL is never written to the audit row, desired state or a view.
	 */
	setPublicUrl(principal: Principal, name: string, raw: unknown): DatabasePublicUrlView {
		requirePermission(principal, 'database:update');
		const input = databasePublicUrlUpdateSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const now = this.ctx.now();
		this.ctx.db
			.update(databases)
			.set({
				publicUrlSealed: this.ctx.secrets.seal(row.orgId, input.url),
				publicUrlUpdatedAt: now,
				publicUrlUpdatedBy: principal.userId,
				updatedAt: now,
			})
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.public-url.set',
			resource: 'database',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		return this.publicUrlView(this.requireRow(principal, name));
	}

	/** Decrypt the public URL. This is the only read path; every call is audited. */
	revealPublicUrl(principal: Principal, name: string): DatabasePublicUrlReveal {
		requirePermission(principal, 'database:read');
		requirePermission(principal, 'database:credentials');
		const row = this.requireRow(principal, name);
		if (!row.publicUrlSealed) throw new NotFoundError(`Public URL for "${name}"`);
		const url = this.ctx.secrets.open(row.orgId, row.publicUrlSealed);
		this.ctx.audit.record({
			principal,
			action: 'database.public-url.reveal',
			resource: 'database',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		return {
			configured: true,
			url,
			updatedAt: row.publicUrlUpdatedAt ? new Date(row.publicUrlUpdatedAt).toISOString() : null,
			updatedBy: row.publicUrlUpdatedBy,
		};
	}

	clearPublicUrl(principal: Principal, name: string): DatabasePublicUrlView {
		requirePermission(principal, 'database:update');
		const row = this.requireRow(principal, name);
		this.ctx.db
			.update(databases)
			.set({
				publicUrlSealed: null,
				publicUrlUpdatedAt: null,
				publicUrlUpdatedBy: null,
				updatedAt: this.ctx.now(),
			})
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.public-url.clear',
			resource: 'database',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		return this.publicUrlView(this.requireRow(principal, name));
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

	// ---------------------------------------------------------------- on-demand studio (D60)

	/**
	 * The studio state for one database. A session that has passed its expiry is reported as
	 * stopped without writing to the row; the maintenance sweep performs the actual close.
	 */
	console(principal: Principal, name: string): DatabaseConsoleView {
		requirePermission(principal, 'database:read');
		requirePermission(principal, 'database:console');
		return this.consoleView(this.requireRow(principal, name));
	}

	/**
	 * Start (or extend) a DBGate session. The password is generated per session, sealed with the
	 * org key and only ever leaves through `consoleEndpoint`; desired state carries the port but
	 * never the secret. Opening never re-applies the Postgres workload.
	 */
	openConsole(principal: Principal, name: string, raw: unknown = {}): DatabaseConsoleView {
		requirePermission(principal, 'database:console');
		if (!featureEnabled(this.ctx.config, 'DB_CONSOLE'))
			throw new ConflictError('The database studio is disabled on this control plane.');
		if (principal.kind !== 'user')
			throw new CoreError('forbidden', 'The database studio needs an interactive user session.', 403);
		const input = databaseConsoleOpenSchema.parse(raw);
		if (input.readOnly === false) requirePermission(principal, 'database:update');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		if (row.deletedAt)
			throw new ConflictError(`Database "${name}" is in the trash. Restore it before opening the studio.`);
		if (row.status !== 'running')
			throw new ConflictError(
				`Database "${name}" is ${row.status}. Start it and wait until it is running before opening the studio.`,
			);

		const now = this.ctx.now();
		const ttlMs = input.ttlMinutes * 60_000;
		const idleMs = input.idleMinutes * 60_000;
		const expiresAt = now + ttlMs;
		const active =
			row.consoleRequested &&
			(row.consoleStatus === 'starting' || row.consoleStatus === 'running') &&
			row.consoleExpiresAt !== null &&
			row.consoleExpiresAt > now;
		// Same mode: keep the running sidecar and password, only extend the session and idle window.
		if (active && row.consoleReadOnly === input.readOnly) {
			this.ctx.db
				.update(databases)
				.set({ consoleExpiresAt: expiresAt, consoleIdleMs: idleMs, updatedAt: now })
				.where(eq(databases.id, row.id))
				.run();
			this.ctx.audit.record({
				principal,
				action: 'database.console.open',
				resource: 'database',
				resourceId: row.id,
				args: { readOnly: input.readOnly, ttlMinutes: input.ttlMinutes },
				result: 'ok',
			});
			this.ctx.projects.bump(row.orgId);
			return this.consoleView(this.requireRow(principal, name, { includeDeleted: true }));
		}

		const port = row.consolePort ?? this.allocateConsolePort(row.nodeId);
		const secret = this.ctx.secrets.seal(row.orgId, password());
		this.ctx.db
			.update(databases)
			.set({
				consoleRequested: true,
				consoleStatus: 'starting',
				consolePort: port,
				consoleSecret: secret,
				consoleReadOnly: input.readOnly,
				consoleExpiresAt: expiresAt,
				consoleIdleMs: idleMs,
				consoleLastUsedAt: now,
				consoleGeneration: row.consoleGeneration + 1,
				consoleError: null,
				updatedAt: now,
			})
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.console.open',
			resource: 'database',
			resourceId: row.id,
			args: { readOnly: input.readOnly, ttlMinutes: input.ttlMinutes },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
		return this.consoleView(this.requireRow(principal, name, { includeDeleted: true }));
	}

	/** Stop a session now. The node gets a `stop` task; the port and secret are released at once. */
	closeConsole(principal: Principal, name: string): DatabaseConsoleView {
		requirePermission(principal, 'database:console');
		requireInteractiveStudio(principal);
		const row = this.requireRow(principal, name, { includeDeleted: true });
		const now = this.ctx.now();
		this.ctx.db
			.update(databases)
			.set({
				consoleRequested: false,
				consoleStatus: 'stopped',
				consoleGeneration: row.consoleGeneration + 1,
				consolePort: null,
				consoleSecret: null,
				consoleExpiresAt: null,
				consoleError: null,
				updatedAt: now,
			})
			.where(eq(databases.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.console.close',
			resource: 'database',
			resourceId: row.id,
			args: { name },
			result: 'ok',
		});
		this.ctx.projects.bump(row.orgId);
		return this.consoleView(this.requireRow(principal, name, { includeDeleted: true }));
	}

	/** Record activity for the idle timeout; writes at most once a minute to keep proxies cheap. */
	touchConsole(principal: Principal, name: string): DatabaseConsoleView {
		requirePermission(principal, 'database:console');
		const row = this.requireRow(principal, name, { includeDeleted: true });
		const now = this.ctx.now();
		if (row.consoleLastUsedAt === null || now - row.consoleLastUsedAt >= 60_000) {
			this.ctx.db
				.update(databases)
				.set({ consoleLastUsedAt: now, updatedAt: now })
				.where(eq(databases.id, row.id))
				.run();
		}
		return this.consoleView(this.requireRow(principal, name, { includeDeleted: true }));
	}

	/**
	 * The values the platform proxy needs to reach one studio. The basic-auth password is opened
	 * here only; desired state, audit and every view stay secret-free.
	 */
	consoleEndpoint(
		principal: Principal,
		name: string,
	): { host: string; authHeader: string; webRoot: string; readOnly: boolean; expiresAt: string | null } {
		requirePermission(principal, 'database:console');
		if (!featureEnabled(this.ctx.config, 'DB_CONSOLE'))
			throw new ConflictError('The database studio is disabled on this control plane.');
		// The studio is a human surface (D60). An API key must not reuse an open session.
		requireInteractiveStudio(principal);
		const row = this.requireRow(principal, name);
		const now = this.ctx.now();
		if (row.consoleRequested && row.consoleExpiresAt !== null && row.consoleExpiresAt <= now) {
			this.closeConsole(principal, name);
			throw new ConflictError('The database studio session has expired. Open it again.');
		}
		if (
			!row.consoleRequested ||
			(row.consoleStatus !== 'starting' && row.consoleStatus !== 'running') ||
			row.consolePort === null ||
			row.consoleSecret === null ||
			row.consoleExpiresAt === null ||
			row.consoleExpiresAt <= now
		)
			throw new ConflictError('The database studio is not running. Open it first.');
		const secret = this.ctx.secrets.open(row.orgId, row.consoleSecret);
		this.touchConsole(principal, name);
		return {
			host: databaseConsoleHost(row.id),
			authHeader: `Basic ${Buffer.from(`skiff:${secret}`).toString('base64')}`,
			webRoot: `/databases/${encodeURIComponent(row.name)}/studio/proxy`,
			readOnly: row.consoleReadOnly,
			expiresAt: new Date(row.consoleExpiresAt).toISOString(),
		};
	}

	/** Start/stop tasks for one node; a row is pending until the node reports its generation. */
	consoleTasksForNode(nodeId: string): DatabaseConsoleTask[] {
		return this.ctx.db
			.select()
			.from(databases)
			.where(and(eq(databases.nodeId, nodeId), isNull(databases.deletedAt)))
			.all()
			.filter((row) => row.consoleGeneration !== row.consoleAppliedGeneration)
			.map((row) => ({
				id: row.id,
				action: row.consoleRequested ? ('start' as const) : ('stop' as const),
				generation: row.consoleGeneration,
			}))
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	/** Node-authenticated activation for a `start` task; never appears in desired state. */
	consoleActivation(nodeId: string, id: string): DatabaseConsoleActivation {
		const row = this.rowById(id);
		if (!row || row.deletedAt) throw new NotFoundError('Database');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This database is placed on another node.', 403);
		if (!row.consoleRequested)
			throw new ConflictError('The database studio is not requested on this node.');
		if (row.consolePort === null || row.consoleSecret === null || row.consoleExpiresAt === null)
			throw new ConflictError('The database studio has no active session.');
		if (row.consoleExpiresAt <= this.ctx.now()) throw new ConflictError('The database studio session has expired.');
		const tls = this.tlsState(row).enabled;
		return {
			databaseId: row.id,
			port: row.consolePort,
			webRoot: `/databases/${encodeURIComponent(row.name)}/studio/proxy`,
			readOnly: row.consoleReadOnly,
			authUser: 'skiff',
			authPassword: this.ctx.secrets.open(row.orgId, row.consoleSecret),
			...(tls ? { tls: true } : {}),
		};
	}

	/** Apply start/stop outcomes from a heartbeat, ignoring stale generations. */
	applyConsoleResults(nodeId: string, results: DatabaseConsoleResult[]): void {
		const now = this.ctx.now();
		let changed = false;
		for (const result of results) {
			const row = this.rowById(result.id);
			if (!row || row.nodeId !== nodeId) continue;
			if (row.consoleGeneration !== result.generation) continue;
			let action: string;
			if (result.action === 'start') {
				if (result.status === 'ok') {
					action = 'database.console.started';
					this.ctx.db
						.update(databases)
						.set({
							consoleStatus: 'running',
							consoleAppliedGeneration: row.consoleGeneration,
							consoleError: null,
							consoleLastUsedAt: now,
							updatedAt: now,
						})
						.where(eq(databases.id, row.id))
						.run();
				} else {
					action = 'database.console.start-failed';
					this.ctx.db
						.update(databases)
						.set({
							consoleStatus: 'failed',
							consoleRequested: false,
							consolePort: null,
							consoleSecret: null,
							consoleAppliedGeneration: row.consoleGeneration,
							consoleError: result.error ?? 'Database studio failed to start on the node.',
							updatedAt: now,
						})
						.where(eq(databases.id, row.id))
						.run();
				}
			} else if (result.status === 'ok') {
				action = 'database.console.stopped';
				this.ctx.db
					.update(databases)
					.set({
						consoleStatus: 'stopped',
						consoleRequested: false,
						consoleAppliedGeneration: row.consoleGeneration,
						consoleError: null,
						updatedAt: now,
					})
					.where(eq(databases.id, row.id))
					.run();
			} else {
				action = 'database.console.stop-failed';
				this.ctx.db
					.update(databases)
					.set({
						consoleStatus: 'failed',
						consoleRequested: false,
						consoleAppliedGeneration: row.consoleGeneration,
						consoleError: result.error ?? 'Database studio failed to stop on the node.',
						updatedAt: now,
					})
					.where(eq(databases.id, row.id))
					.run();
			}
			this.ctx.audit.record({
				orgId: row.orgId,
				action,
				resource: 'database',
				resourceId: row.id,
				args: { name: row.name, generation: row.consoleGeneration },
				result: result.status === 'ok' ? 'ok' : 'error',
				...(result.status === 'ok' ? {} : { error: result.error ?? 'Console task failed on the node.' }),
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	/** Maintenance: close sessions that have expired or gone idle. Returns how many were closed. */
	tickConsoles(now = this.ctx.now()): number {
		const rows = this.ctx.db
			.select()
			.from(databases)
			.where(and(eq(databases.consoleRequested, true), isNull(databases.deletedAt)))
			.all();
		let closed = 0;
		for (const row of rows) {
			const expired = row.consoleExpiresAt !== null && row.consoleExpiresAt <= now;
			const idle =
				row.consoleLastUsedAt !== null && row.consoleLastUsedAt + row.consoleIdleMs <= now;
			if (!expired && !idle) continue;
			this.ctx.db
				.update(databases)
				.set({
					consoleRequested: false,
					consoleStatus: 'stopped',
					consoleGeneration: row.consoleGeneration + 1,
					consolePort: null,
					consoleSecret: null,
					consoleExpiresAt: null,
					consoleError: null,
					updatedAt: now,
				})
				.where(eq(databases.id, row.id))
				.run();
			this.ctx.audit.record({
				orgId: row.orgId,
				action: 'database.console.expired',
				resource: 'database',
				resourceId: row.id,
				args: { name: row.name, reason: expired ? 'expired' : 'idle' },
				result: 'ok',
			});
			closed += 1;
		}
		if (closed > 0) this.ctx.projects.bump();
		return closed;
	}

	/**
	 * Internal studio gateway routes (D60), mirroring the object-browser gateway. Only a requested
	 * session with a port is routable; workers serve their own databases, the edge proxies the rest.
	 */
	gatewayForNode(
		nodeId: string,
		isEdge: boolean,
		publicAddressOf: (nodeId: string) => string | null,
	): { listen: string | null; routes: Array<{ host: string; upstream: string }> } {
		const rows = this.ctx.db
			.select()
			.from(databases)
			.where(and(eq(databases.consoleRequested, true), isNull(databases.deletedAt), isNotNull(databases.consolePort)))
			.all();
		const routes: Array<{ host: string; upstream: string }> = [];
		for (const row of rows) {
			const host = databaseConsoleHost(row.id);
			if (row.nodeId === nodeId) {
				routes.push({ host, upstream: `127.0.0.1:${row.consolePort}` });
				continue;
			}
			if (!isEdge) continue;
			routes.push({
				host,
				upstream: `http://${publicAddressOf(row.nodeId) ?? '127.0.0.1:1'}`,
			});
		}
		routes.sort((a, b) => a.host.localeCompare(b.host));
		const port = this.ctx.config.databaseGatewayPort ?? 8082;
		return { listen: isEdge ? `127.0.0.1:${port}` : null, routes };
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
					// Keep the built-in credential row in step with the live secret.
					this.ctx.db
						.update(databaseCredentials)
						.set({
							secretSealed: row.rotation.secretSealed,
							pendingSecretSealed: null,
							status: 'ready',
							updatedAt: now,
						})
						.where(
							and(
								eq(databaseCredentials.databaseId, row.db.id),
								eq(databaseCredentials.role, result.role),
							),
						)
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

	// ---------------------------------------------------------------- named credentials

	listCredentials(principal: Principal, name: string): DatabaseCredentialView[] {
		requirePermission(principal, 'database:read');
		const db = this.requireRow(principal, name, { includeDeleted: true });
		this.ensureBuiltInCredential(db.id, 'owner');
		this.ensureBuiltInCredential(db.id, 'monitor');
		return this.credentialsOf(db.id).map(toCredentialView);
	}

	createCredential(principal: Principal, name: string, raw: unknown): DatabaseCredentialView {
		requirePermission(principal, 'database:credentials');
		requirePermission(principal, 'database:update');
		const input = databaseCredentialCreateSchema.parse(raw ?? {}) as DatabaseCredentialCreate;
		const db = this.requireRow(principal, name);
		if (input.role !== 'app' && input.role !== 'readonly' && input.role !== 'backup')
			throw new ValidationError('Only app, readonly and backup credentials can be created.');
		const now = this.ctx.now();
		const id = newId('dbc_');
		const username = `skiff_${input.role}_${randomBytes(4).toString('hex')}`;
		this.ctx.db
			.insert(databaseCredentials)
			.values({
				id,
				orgId: db.orgId,
				databaseId: db.id,
				role: input.role,
				username,
				secretSealed: null,
				pendingSecretSealed: this.ctx.secrets.seal(db.orgId, password()),
				purpose: input.purpose ?? null,
				status: 'pending',
				expiresAt: input.expiresAt ? Date.parse(input.expiresAt) : null,
				createdBy: principal.userId,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.credential.create',
			resource: 'database',
			resourceId: db.id,
			args: { name, credentialId: id, role: input.role, username },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return toCredentialView(this.requireCredential(db.id, id));
	}

	rotateNamedCredential(principal: Principal, name: string, credentialId: string): DatabaseCredentialView {
		requirePermission(principal, 'database:credentials');
		requirePermission(principal, 'database:update');
		const db = this.requireRow(principal, name);
		const credential = this.requireCredential(db.id, credentialId);
		if (credential.role === 'owner' || credential.role === 'monitor')
			throw new ValidationError('Rotate the owner or monitor credential with rotate_database_credentials.');
		if (credential.status === 'revoked') throw new ConflictError('This credential is revoked.');
		this.ctx.db
			.update(databaseCredentials)
			.set({
				pendingSecretSealed: this.ctx.secrets.seal(db.orgId, password()),
				status: 'pending',
				updatedAt: this.ctx.now(),
			})
			.where(eq(databaseCredentials.id, credential.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.credential.rotate',
			resource: 'database',
			resourceId: db.id,
			args: { name, credentialId, role: credential.role },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return toCredentialView(this.requireCredential(db.id, credential.id));
	}

	revokeCredential(principal: Principal, name: string, credentialId: string): DatabaseCredentialView {
		requirePermission(principal, 'database:credentials');
		requirePermission(principal, 'database:update');
		const db = this.requireRow(principal, name);
		const credential = this.requireCredential(db.id, credentialId);
		if (credential.role === 'owner' || credential.role === 'monitor')
			throw new ValidationError('The built-in owner and monitor credentials cannot be revoked here.');
		if (credential.status === 'revoked') return toCredentialView(credential);
		const now = this.ctx.now();
		this.ctx.db
			.update(databaseCredentials)
			.set({ status: 'revoking', revokedAt: now, pendingSecretSealed: null, updatedAt: now })
			.where(eq(databaseCredentials.id, credential.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.credential.revoke',
			resource: 'database',
			resourceId: db.id,
			args: { name, credentialId, role: credential.role },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return toCredentialView(this.requireCredential(db.id, credential.id));
	}

	/**
	 * Reveal a named credential. This is an interactive action: an MCP/API-key principal never
	 * receives the secret, and the read is audited. Step-up is enforced by the surface (the
	 * dashboard action re-authenticates before calling this service).
	 */
	revealCredential(principal: Principal, name: string, credentialId: string): DatabaseCredentialView & { password: string } {
		requirePermission(principal, 'database:credentials');
		if (principal.kind !== 'user')
			throw new CoreError('forbidden', 'Credential reveal needs an interactive user session.', 403);
		const db = this.requireRow(principal, name);
		const credential = this.requireCredential(db.id, credentialId);
		if (credential.status !== 'ready' || credential.revokedAt !== null)
			throw new ConflictError('This credential is not active.');
		if (credential.expiresAt !== null && credential.expiresAt <= this.ctx.now())
			throw new ConflictError('This credential has expired.');
		const secret = credential.secretSealed
			? this.ctx.secrets.open(db.orgId, credential.secretSealed)
			: credential.role === 'owner'
				? this.ctx.secrets.open(db.orgId, db.ownerSecret)
				: null;
		if (!secret) throw new ConflictError('This credential has no active secret.');
		this.ctx.db
			.update(databaseCredentials)
			.set({ lastUsedAt: this.ctx.now() })
			.where(eq(databaseCredentials.id, credential.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.credentials.reveal',
			resource: 'database',
			resourceId: db.id,
			args: { name, credentialId, role: credential.role },
			result: 'ok',
		});
		return { ...toCredentialView(credential), password: secret };
	}

	credentialTasksForNode(nodeId: string): DatabaseCredentialTask[] {
		return this.ctx.db
			.select({ credential: databaseCredentials, db: databases })
			.from(databaseCredentials)
			.innerJoin(databases, eq(databases.id, databaseCredentials.databaseId))
			.where(
				and(
					eq(databases.nodeId, nodeId),
					inArray(databaseCredentials.status, ['pending', 'revoking']),
					isNull(databases.deletedAt),
				),
			)
			.all()
			.map(({ credential }) => ({
				id: credential.id,
				databaseId: credential.databaseId,
				action: credential.status === 'revoking' ? ('revoke' as const) : ('grant' as const),
				role: credential.role,
				username: credential.username,
			}));
	}

	credentialActivation(nodeId: string, id: string): DatabaseCredentialActivation {
		const row = this.ctx.db
			.select({ credential: databaseCredentials, db: databases })
			.from(databaseCredentials)
			.innerJoin(databases, eq(databases.id, databaseCredentials.databaseId))
			.where(eq(databaseCredentials.id, id))
			.get();
		if (!row || row.db.nodeId !== nodeId)
			throw new CoreError('forbidden', 'This credential is not on this node.', 403);
		if (row.credential.status !== 'pending' && row.credential.status !== 'revoking')
			throw new ConflictError('This credential task has already finished.');
		const action = row.credential.status === 'revoking' ? ('revoke' as const) : ('grant' as const);
		const password =
			action === 'grant' && row.credential.pendingSecretSealed
				? this.ctx.secrets.open(row.db.orgId, row.credential.pendingSecretSealed)
				: undefined;
		return {
			id: row.credential.id,
			databaseId: row.db.id,
			action,
			role: row.credential.role,
			username: row.credential.username,
			...(password ? { password } : {}),
		};
	}

	applyCredentialResults(nodeId: string, results: DatabaseCredentialResult[]): void {
		const now = this.ctx.now();
		let changed = false;
		for (const result of results) {
			const row = this.ctx.db
				.select({ credential: databaseCredentials, db: databases })
				.from(databaseCredentials)
				.innerJoin(databases, eq(databases.id, databaseCredentials.databaseId))
				.where(eq(databaseCredentials.id, result.taskId))
				.get();
			if (!row || row.db.nodeId !== nodeId) continue;
			if (row.credential.status === 'ready' || row.credential.status === 'revoked') continue;
			const action = row.credential.status === 'revoking' ? ('revoke' as const) : ('grant' as const);
			if (result.status === 'ok') {
				this.ctx.db
					.update(databaseCredentials)
					.set(
						action === 'revoke'
							? {
									status: 'revoked',
									pendingSecretSealed: null,
									revokedAt: now,
									updatedAt: now,
								}
							: {
									status: 'ready',
									secretSealed: row.credential.pendingSecretSealed,
									pendingSecretSealed: null,
									updatedAt: now,
								},
					)
					.where(eq(databaseCredentials.id, row.credential.id))
					.run();
			} else {
				this.ctx.db
					.update(databaseCredentials)
					.set({
						status: action === 'revoke' ? 'revoked' : 'failed',
						pendingSecretSealed: null,
						updatedAt: now,
					})
					.where(eq(databaseCredentials.id, row.credential.id))
					.run();
			}
			this.ctx.audit.record({
				orgId: row.db.orgId,
				action: result.status === 'ok' ? 'database.credential.ready' : 'database.credential.failed',
				resource: 'database',
				resourceId: row.db.id,
				args: { name: row.db.name, credentialId: row.credential.id, action },
				result: result.status === 'ok' ? 'ok' : 'error',
				...(result.status === 'ok' ? {} : { error: result.error ?? 'Credential task failed on the node.' }),
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	private credentialsOf(databaseId: string): Array<typeof databaseCredentials.$inferSelect> {
		return this.ctx.db
			.select()
			.from(databaseCredentials)
			.where(eq(databaseCredentials.databaseId, databaseId))
			.orderBy(desc(databaseCredentials.createdAt))
			.all();
	}

	private requireCredential(databaseId: string, credentialId: string): typeof databaseCredentials.$inferSelect {
		const row = this.ctx.db
			.select()
			.from(databaseCredentials)
			.where(and(eq(databaseCredentials.databaseId, databaseId), eq(databaseCredentials.id, credentialId)))
			.get();
		if (!row) throw new NotFoundError('Database credential');
		return row;
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

	// ---------------------------------------------------------------- point-in-time recovery

	/** PITR state for one database (docs/PITR.md). Readable while the feature flag is off. */
	pitrStatus(principal: Principal, name: string): DatabasePitrStatus {
		requirePermission(principal, 'database:read');
		const row = this.requireRow(principal, name);
		const state = this.ctx.db.select().from(databasePitr).where(eq(databasePitr.databaseId, row.id)).get();
		let repo: DatabasePitrStatus['repo'];
		if (state) {
			try {
				repo = parseJson<DatabasePitrStatus['repo']>(state.repoJson, this.pitrRepoView());
			} catch {
				repo = this.pitrRepoView();
			}
		} else {
			repo = this.pitrRepoView();
		}
		const toIso = (value: number | null | undefined) => (value ? new Date(value).toISOString() : null);
		return {
			databaseId: row.id,
			databaseName: row.name,
			enabled: state?.enabled ?? false,
			stanza: state?.stanza ?? pitrStanzaFor(row.id),
			status: state?.status ?? 'pending',
			repo,
			archiveStatus: state?.archiveStatus ?? null,
			archiveAt: toIso(state?.archiveAt),
			lastBaseBackupAt: toIso(state?.lastBaseBackupAt),
			lastBaseBackupType: state?.lastBaseBackupType ?? null,
			nextFullAt: toIso(state?.nextFullAt),
			nextDiffAt: toIso(state?.nextDiffAt),
			lastRestoreTargetAt: toIso(state?.lastRestoreTargetAt),
			lastRestoreDatabaseId: state?.lastRestoreDatabaseId ?? null,
			verifiedAt: toIso(state?.verifiedAt),
			error: state?.error ?? null,
		};
	}

	/** Enable or disable WAL archiving and the full/diff base-backup schedule. */
	setPitrPolicy(principal: Principal, name: string, raw: unknown): DatabasePitrStatus {
		requirePermission(principal, 'database:update');
		this.requirePitrFeature();
		const input = databasePitrPolicySchema.parse(raw);
		const row = this.requireRow(principal, name);
		const now = this.ctx.now();
		const existing = this.ctx.db
			.select()
			.from(databasePitr)
			.where(eq(databasePitr.databaseId, row.id))
			.get();
		const repo = this.pitrRepoView();
		let nextFullAt: number | null = null;
		let nextDiffAt: number | null = null;
		if (input.enabled) {
			nextFullAt = nextCronTime(PITR_FULL_SCHEDULE, now);
			nextDiffAt = nextCronTime(PITR_DIFF_SCHEDULE, now);
			if (nextFullAt === null || nextDiffAt === null)
				throw new ValidationError('The PITR base-backup schedule never fires; check the cron constants.');
		}
		if (existing) {
			this.ctx.db
				.update(databasePitr)
				.set({
					enabled: input.enabled,
					repoJson: JSON.stringify(repo),
					status: input.enabled ? 'pending' : existing.status,
					nextFullAt,
					nextDiffAt,
					error: input.enabled ? null : existing.error,
					updatedAt: now,
				})
				.where(eq(databasePitr.databaseId, row.id))
				.run();
		} else {
			this.ctx.db
				.insert(databasePitr)
				.values({
					databaseId: row.id,
					orgId: row.orgId,
					enabled: input.enabled,
					stanza: pitrStanzaFor(row.id),
					repoJson: JSON.stringify(repo),
					status: input.enabled ? 'pending' : 'paused',
					nextFullAt,
					nextDiffAt,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		}
		this.ctx.audit.record({
			principal,
			action: 'database.pitr-policy',
			resource: 'database',
			resourceId: row.id,
			args: { name, enabled: input.enabled },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.pitrStatus(principal, name);
	}

	/** Queue a base backup now; the scheduler handles the recurring full/diff pair. */
	pitrBackup(principal: Principal, name: string, raw: unknown = {}): DatabasePitrTask {
		requirePermission(principal, 'database:update');
		this.requirePitrFeature();
		const input = databasePitrBackupSchema.parse(raw);
		const row = this.requireRow(principal, name);
		const state = this.requirePitrEnabled(row);
		const busy = this.ctx.db
			.select({ id: databasePitrTasks.id })
			.from(databasePitrTasks)
			.where(
				and(
					eq(databasePitrTasks.databaseId, row.id),
					eq(databasePitrTasks.action, 'basebackup'),
					inArray(databasePitrTasks.status, ['pending', 'running']),
				),
			)
			.get();
		if (busy) throw new ConflictError(`A PITR base backup for "${name}" is already queued.`);
		const now = this.ctx.now();
		const id = newId('pitr_');
		this.ctx.db
			.insert(databasePitrTasks)
			.values({
				id,
				orgId: row.orgId,
				databaseId: row.id,
				action: 'basebackup',
				status: 'pending',
				baseBackupType: input.type,
				createdBy: principal.userId,
				createdAt: now,
			})
			.run();
		this.ctx.db
			.update(databasePitr)
			.set({ status: 'pending', error: null, updatedAt: now })
			.where(eq(databasePitr.databaseId, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'database.pitr-basebackup',
			resource: 'database',
			resourceId: row.id,
			args: { name, type: input.type, taskId: id },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return {
			id,
			action: 'basebackup',
			databaseId: row.id,
			databaseName: databaseIdentifier(row.name),
			engine: row.engine,
			stanza: state.stanza,
			baseBackupType: input.type,
			targetDatabaseId: null,
			targetTime: null,
		};
	}

	/**
	 * Restore to a timestamp into a NEW database on the source's node. The target is created with
	 * fresh credentials and stays `pending` with scheduled dumps paused until the node verifies it.
	 */
	restoreToTimestamp(principal: Principal, sourceName: string, raw: unknown): DatabaseView {
		requirePermission(principal, 'database:create');
		this.requirePitrFeature();
		const input = databasePitrRestoreSchema.parse(raw);
		const source = this.requireRow(principal, sourceName);
		const state = this.requirePitrEnabled(source);
		const targetTime = Date.parse(input.targetTime);
		const check = validatePitrTargetTime(targetTime, this.ctx.now(), PITR_RETENTION_DAYS);
		if (!check.ok) throw new ValidationError(check.message);
		const target = this.create(principal, {
			name: input.name,
			engine: source.engine,
			version: source.version,
			placement: source.nodeId,
			...(input.memoryMb !== undefined ? { memoryMb: input.memoryMb } : {}),
			...(input.cpus !== undefined ? { cpus: input.cpus } : {}),
			...(input.storageMb !== undefined ? { storageMb: input.storageMb } : {}),
			...(input.volume !== undefined ? { volume: input.volume } : {}),
			extensions: parseJson<string[]>(source.extensionsJson, []) as DatabaseCreate['extensions'],
			pooler: source.poolerEnabled,
		});
		const now = this.ctx.now();
		const id = newId('pitr_');
		this.ctx.sqlite.transaction(() => {
			this.ctx.db
				.update(databases)
				.set({
					status: 'pending',
					message: `Restoring to ${new Date(targetTime).toISOString()}.`,
					backupEnabled: false,
					nextBackupAt: null,
					updatedAt: now,
				})
				.where(eq(databases.id, target.id))
				.run();
			this.ctx.db
				.insert(databasePitrTasks)
				.values({
					id,
					orgId: source.orgId,
					databaseId: source.id,
					targetDatabaseId: target.id,
					action: 'restore',
					status: 'pending',
					targetTime,
					createdBy: principal.userId,
					createdAt: now,
				})
				.run();
			this.ctx.db
				.update(databasePitr)
				.set({
					status: 'pending',
					lastRestoreTargetAt: targetTime,
					lastRestoreDatabaseId: target.id,
					error: null,
					updatedAt: now,
				})
				.where(eq(databasePitr.databaseId, source.id))
				.run();
		})();
		this.ctx.audit.record({
			principal,
			action: 'database.pitr-restore',
			resource: 'database',
			resourceId: target.id,
			args: { source: sourceName, name: input.name, targetTime: new Date(targetTime).toISOString(), taskId: id },
			result: 'ok',
		});
		this.ctx.projects.bump(principal.orgId);
		return this.toView(this.requireRow(principal, input.name));
	}

	/** Pending PITR tasks for one node, additive to the logical backup task list. */
	async pitrTasksForNode(nodeId: string): Promise<DatabasePitrTask[]> {
		if (!featureEnabled(this.ctx.config, 'PITR')) return [];
		const rows = this.ctx.db
			.select({ task: databasePitrTasks, db: databases, state: databasePitr })
			.from(databasePitrTasks)
			.innerJoin(databases, eq(databases.id, databasePitrTasks.databaseId))
			.leftJoin(databasePitr, eq(databasePitr.databaseId, databasePitrTasks.databaseId))
			.where(
				and(
					eq(databasePitrTasks.status, 'pending'),
					eq(databases.nodeId, nodeId),
					isNull(databases.deletedAt),
				),
			)
			.all();
		return rows.map(({ task, db, state }) => ({
			id: task.id,
			action: task.action,
			databaseId: db.id,
			databaseName: databaseIdentifier(db.name),
			engine: db.engine,
			stanza: state?.stanza ?? pitrStanzaFor(db.id),
			baseBackupType: task.baseBackupType ?? null,
			targetDatabaseId: task.targetDatabaseId ?? null,
			targetTime: task.targetTime ?? null,
		}));
	}

	/** Repository credentials for one node task; never reaches desired state or SQLite. */
	pitrActivation(nodeId: string, taskId: string): DatabasePitrActivation {
		this.requirePitrFeature();
		const row = this.ctx.db
			.select({ task: databasePitrTasks, db: databases, state: databasePitr })
			.from(databasePitrTasks)
			.innerJoin(databases, eq(databases.id, databasePitrTasks.databaseId))
			.leftJoin(databasePitr, eq(databasePitr.databaseId, databasePitrTasks.databaseId))
			.where(eq(databasePitrTasks.id, taskId))
			.get();
		if (!row) throw new NotFoundError('PITR task');
		if (row.db.nodeId !== nodeId)
			throw new CoreError('forbidden', 'This PITR task belongs to another node.', 403);
		const repo = this.ctx.config.pitrRepository;
		if (!repo) throw new ValidationError(this.pitrRepoMissingMessage());
		return {
			taskId: row.task.id,
			databaseId: row.db.id,
			action: row.task.action,
			stanza: row.state?.stanza ?? pitrStanzaFor(row.db.id),
			repo,
			archiveTimeoutSeconds: PITR_ARCHIVE_TIMEOUT_SECONDS,
		};
	}

	/** Record base-backup, restore and status outcomes from a node heartbeat. */
	applyPitrResults(nodeId: string, results: DatabasePitrResult[]): void {
		const now = this.ctx.now();
		let changed = false;
		for (const result of results) {
			const row = this.ctx.db
				.select({ task: databasePitrTasks, db: databases })
				.from(databasePitrTasks)
				.innerJoin(databases, eq(databases.id, databasePitrTasks.databaseId))
				.where(eq(databasePitrTasks.id, result.taskId))
				.get();
			if (!row || row.db.nodeId !== nodeId) continue;
			if (row.task.status === 'ok' || row.task.status === 'failed') continue;
			const ok = result.status === 'ok';
			this.ctx.db
				.update(databasePitrTasks)
				.set({
					status: ok ? 'ok' : 'failed',
					startedAt: row.task.startedAt ?? now,
					finishedAt: now,
					error: ok ? null : result.error ?? 'PITR task failed on the node.',
				})
				.where(eq(databasePitrTasks.id, row.task.id))
				.run();

			if (row.task.action === 'basebackup') {
				this.ctx.db
					.update(databasePitr)
					.set({
						status: ok ? 'ok' : 'failed',
						archiveStatus: ok ? 'ok' : 'failing',
						archiveAt: now,
						lastBaseBackupAt: ok ? now : undefined,
						lastBaseBackupType: ok ? (result.baseBackupType ?? row.task.baseBackupType) : undefined,
						error: ok ? null : result.error ?? 'Base backup failed on the node.',
						updatedAt: now,
					})
					.where(eq(databasePitr.databaseId, row.db.id))
					.run();
			} else if (row.task.action === 'restore') {
				const targetId = row.task.targetDatabaseId;
				this.ctx.db
					.update(databasePitr)
					.set({
						status: ok ? 'ok' : 'failed',
						lastRestoreTargetAt: result.targetTime ?? row.task.targetTime ?? null,
						lastRestoreDatabaseId: targetId,
						verifiedAt: ok ? now : undefined,
						error: ok ? null : result.error ?? 'PITR restore failed on the node.',
						updatedAt: now,
					})
					.where(eq(databasePitr.databaseId, row.db.id))
					.run();
				if (targetId) {
					const target = this.ctx.db.select().from(databases).where(eq(databases.id, targetId)).get();
					if (target) {
						this.ctx.db
							.update(databases)
							.set({
								status: ok ? 'running' : 'failed',
								message: ok ? null : `PITR restore failed: ${result.error ?? 'unknown error'}`,
								backupEnabled: ok,
								nextBackupAt: ok ? nextCronTime(target.backupSchedule, now) : null,
								lastVerifiedAt: ok ? now : target.lastVerifiedAt,
								updatedAt: now,
							})
							.where(eq(databases.id, targetId))
							.run();
					}
				}
			} else {
				this.ctx.db
					.update(databasePitr)
					.set({
						archiveStatus: result.archiveStatus ?? 'unknown',
						archiveAt: now,
						updatedAt: now,
					})
					.where(eq(databasePitr.databaseId, row.db.id))
					.run();
			}
			this.ctx.audit.record({
				orgId: row.db.orgId,
				action: ok ? `database.pitr-${row.task.action}-ok` : `database.pitr-${row.task.action}-failed`,
				resource: 'database',
				resourceId: row.task.action === 'restore' && row.task.targetDatabaseId ? row.task.targetDatabaseId : row.db.id,
				args: { name: row.db.name, taskId: row.task.id, targetTime: row.task.targetTime },
				result: ok ? 'ok' : 'error',
				...(ok ? {} : { error: result.error ?? 'PITR task failed on the node.' }),
			});
			changed = true;
		}
		if (changed) this.ctx.projects.bump();
	}

	/**
	 * Maintenance sweep: enqueue due full/diff backups through the F4 scheduler, then claim the
	 * pitr kind only and turn each claim into a node task. `kind + key` prevents duplicate slots.
	 */
	tickPitr(now = this.ctx.now()): number {
		if (!featureEnabled(this.ctx.config, 'PITR')) return 0;
		const rows = this.ctx.db.select().from(databasePitr).where(eq(databasePitr.enabled, true)).all();
		for (const row of rows) {
			for (const [type, dueAt, schedule] of [
				['full', row.nextFullAt, PITR_FULL_SCHEDULE],
				['diff', row.nextDiffAt, PITR_DIFF_SCHEDULE],
			] as const) {
				if (dueAt === null || dueAt > now) continue;
				this.ctx.scheduler.enqueue({
					kind: PITR_SCHEDULER_KIND,
					key: `${row.databaseId}:${type}:${new Date(dueAt).toISOString()}`,
					runAt: dueAt,
					payload: { databaseId: row.databaseId, type },
				});
				const next = nextCronTime(schedule, now);
				this.ctx.db
					.update(databasePitr)
					.set(type === 'full' ? { nextFullAt: next, updatedAt: now } : { nextDiffAt: next, updatedAt: now })
					.where(eq(databasePitr.databaseId, row.databaseId))
					.run();
			}
		}
		let queued = 0;
		for (const claimed of this.ctx.scheduler.claim('maintenance:pitr', 50, now, undefined, PITR_SCHEDULER_KIND)) {
			try {
				const payload = claimed.payloadJson ? (JSON.parse(claimed.payloadJson) as { databaseId?: string; type?: string }) : {};
				const databaseId = payload.databaseId;
				const type =
					payload.type === 'full' || payload.type === 'diff' || payload.type === 'incr'
						? payload.type
						: null;
				if (!databaseId || !type) {
					this.ctx.scheduler.fail(claimed.id, 'PITR scheduler payload is invalid.');
					continue;
				}
				const db = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
				if (!db || db.deletedAt) {
					this.ctx.scheduler.complete(claimed.id, JSON.stringify({ skipped: 'database-gone' }));
					continue;
				}
				const busy = this.ctx.db
					.select({ id: databasePitrTasks.id })
					.from(databasePitrTasks)
					.where(
						and(
							eq(databasePitrTasks.databaseId, db.id),
							eq(databasePitrTasks.action, 'basebackup'),
							inArray(databasePitrTasks.status, ['pending', 'running']),
						),
					)
					.get();
				if (busy) {
					this.ctx.scheduler.complete(claimed.id, JSON.stringify({ skipped: 'busy' }));
					continue;
				}
				this.ctx.db
					.insert(databasePitrTasks)
					.values({
						id: newId('pitr_'),
						orgId: db.orgId,
						databaseId: db.id,
						action: 'basebackup',
						status: 'pending',
						baseBackupType: type,
						createdBy: 'system',
						createdAt: now,
					})
					.run();
				this.ctx.scheduler.complete(claimed.id, JSON.stringify({ task: 'queued' }));
				queued += 1;
			} catch (error) {
				this.ctx.scheduler.fail(claimed.id, error instanceof Error ? error.message : String(error));
			}
		}
		if (queued > 0) this.ctx.projects.bump();
		return queued;
	}

	private requirePitrFeature(): void {
		if (!featureEnabled(this.ctx.config, 'PITR'))
			throw new ValidationError('PITR is disabled on this control plane (SKIFF_FEATURE_PITR).');
	}

	private pitrRepoMissingMessage(): string {
		return 'PITR is enabled but no pgBackRest repository is configured; set SKIFF_PITR_REPO_BUCKET, SKIFF_PITR_ACCESS_KEY_ID and SKIFF_PITR_SECRET_ACCESS_KEY.';
	}

	private pitrRepoView(): DatabasePitrStatus['repo'] {
		const repo = this.ctx.config.pitrRepository;
		if (!repo) throw new ValidationError(this.pitrRepoMissingMessage());
		const { accessKeyId: _accessKeyId, secretAccessKey: _secretAccessKey, ...view } = repo;
		return view;
	}

	private requirePitrEnabled(row: DatabaseRow): typeof databasePitr.$inferSelect {
		const state = this.ctx.db.select().from(databasePitr).where(eq(databasePitr.databaseId, row.id)).get();
		if (!state?.enabled)
			throw new ConflictError(`PITR is not enabled for "${row.name}". Enable it before using base backups or restores.`);
		return state;
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
			const tls = this.tlsState(item.row);
			const direct = databaseConnectionUrl({
				scheme: item.scheme,
				user: item.user,
				pass,
				host: item.host,
				port: item.port,
				database: item.databaseName,
				sslmode: tls.mode,
			});
			env[`${item.prefix}_URL`] = direct;
			env[`${item.prefix}_HOST`] = item.host;
			env[`${item.prefix}_PORT`] = String(item.port);
			env[`${item.prefix}_USER`] = item.user;
			env[`${item.prefix}_PASSWORD`] = pass;
			env[`${item.prefix}_NAME`] = item.databaseName;
			env[`${item.prefix}_SSL_MODE`] = tls.mode;
			// Container env files cannot carry a multi-line PEM; those apps use sslmode=require or
			// fetch the public CA from the credentials endpoint. Process env files escape newlines.
			if (tls.enabled && tls.caPem && runtime === 'process') env[`${item.prefix}_CA_CERT`] = tls.caPem;
			if (item.poolerPort !== null) {
				const poolHost = runtime === 'container' ? `${databaseAlias(item.databaseId)}-pool` : '127.0.0.1';
				const poolPort = runtime === 'container' ? 6432 : item.poolerPort;
				env[`${item.prefix}_POOL_URL`] = databaseConnectionUrl({
					scheme: item.scheme,
					user: item.user,
					pass,
					host: poolHost,
					port: poolPort,
					database: item.databaseName,
					sslmode: tls.mode,
				});
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
		const tls = this.tlsEnabled();
		const items = this.resolveForConsumer(projectId, nodeId, runtime).map((item) => ({
			id: item.databaseId,
			prefix: item.prefix,
			host: item.host,
			port: item.port,
			poolerPort: item.poolerPort,
			tls,
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
				const pitr = featureEnabled(this.ctx.config, 'PITR')
					? this.ctx.db
							.select()
							.from(databasePitr)
							.where(and(eq(databasePitr.databaseId, row.id), eq(databasePitr.enabled, true)))
							.get()
					: undefined;
				const tls = this.tlsEnabled();
				const isolated = featureEnabled(this.ctx.config, 'ORG_NETWORKS');
				return {
					id: row.id,
					projectId: row.id,
					projectSlug: row.name,
					deploymentId: row.id,
					...(isolated ? { orgId: row.orgId, networkName: orgNetworkName(row.orgId) } : {}),
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
					activationVersion: databaseActivationVersion(row, env, pitr?.stanza ?? null, tls),
					env,
					secrets: [],
					dataSizeMb: null,
					...(row.volumeId ? { volumeId: row.volumeId } : {}),
					database: {
						engine: row.engine,
						version: row.version,
						...(pitr
							? {
									pitr: {
										stanza: pitr.stanza,
										archiveTimeoutSeconds: PITR_ARCHIVE_TIMEOUT_SECONDS,
									},
								}
							: {}),
						...(tls ? { tls: true } : {}),
					},
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
		const pitr = featureEnabled(this.ctx.config, 'PITR')
			? this.ctx.db
					.select()
					.from(databasePitr)
					.where(and(eq(databasePitr.databaseId, row.id), eq(databasePitr.enabled, true)))
					.get()
			: undefined;
		return {
			workloadId: row.id,
			activationVersion: databaseActivationVersion(row, env, pitr?.stanza ?? null, this.tlsEnabled()),
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
		let consoleClosed = false;
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
			// A studio is only useful while Postgres is up; clear it and queue the stop task so the
			// sidecar does not keep running (and holding a connection) behind a failed database.
			const closeConsole = status !== 'running' && row.consoleRequested;
			this.ctx.db
				.update(databases)
				.set({
					status,
					message: report.restarts >= 5 ? `Restart loop (${report.restarts} restarts)` : null,
					...(closeConsole
						? {
								consoleRequested: false,
								consoleStatus: 'stopped',
								consolePort: null,
								consoleSecret: null,
								consoleExpiresAt: null,
								consoleError: null,
								consoleGeneration: row.consoleGeneration + 1
							}
						: {}),
					updatedAt: this.ctx.now(),
				})
				.where(eq(databases.id, row.id))
				.run();
			if (closeConsole) consoleClosed = true;
		}
		// The stop task is part of desired state; push it now instead of waiting for the next bump.
		if (consoleClosed) this.ctx.projects.bump();
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

	/** TLS is a control-plane feature flag; the node only renders it when desired state asks. */
	private tlsEnabled(): boolean {
		return featureEnabled(this.ctx.config, 'DB_TLS');
	}

	private tlsState(row: DatabaseRow): {
		enabled: boolean;
		mode: DatabaseSslMode;
		caPem: string | null;
		error: string | null;
	} {
		if (!this.tlsEnabled()) return { enabled: false, mode: 'disable', caPem: null, error: null };
		const report = this.tlsReports.get(row.id);
		// A generation failure means the node started Postgres without TLS; report that honestly
		// rather than handing out an sslmode=require URL that cannot work.
		if (report?.error)
			return { enabled: false, mode: 'disable', caPem: null, error: report.error };
		return {
			enabled: true,
			mode: 'require',
			caPem: report?.caPem ?? null,
			error: null,
		};
	}

	/**
	 * Record the node's certificate state from a heartbeat. The private key never leaves the
	 * node; only the public CA PEM is kept in memory for the credentials response.
	 */
	applyTlsReport(
		nodeId: string,
		reports: Array<{ id: string; enabled: boolean; caPem?: string | null; error?: string | null }>,
	): void {
		let changed = false;
		for (const report of reports) {
			const row = this.rowById(report.id);
			if (!row || row.nodeId !== nodeId || row.deletedAt) continue;
			const previous = this.tlsReports.get(report.id);
			if (report.enabled) {
				const caPem = report.caPem ?? null;
				if (previous?.caPem !== caPem || previous?.error !== null) {
					this.tlsReports.set(report.id, { caPem, error: null });
					changed = true;
				}
			} else if (report.error) {
				if (previous?.error !== report.error || previous?.caPem !== null) {
					this.tlsReports.set(report.id, { caPem: null, error: report.error });
					changed = true;
				}
			} else if (this.tlsReports.delete(report.id)) {
				changed = true;
			}
		}
		if (changed) this.ctx.projects.bump();
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

	private allocateConsolePort(nodeId: string): number {
		const used = new Set(
			this.ctx.db
				.select({ port: databases.consolePort })
				.from(databases)
				.where(and(eq(databases.nodeId, nodeId), isNotNull(databases.consolePort)))
				.all()
				.flatMap((row) => (row.port === null ? [] : [row.port])),
		);
		for (let port = DATABASE_CONSOLE_PORT_MIN; port <= DATABASE_CONSOLE_PORT_MAX; port++)
			if (!used.has(port)) return port;
		throw new ValidationError('This node has no free database studio ports left.');
	}

	private insertAttachment(principal: Principal, databaseId: string, project: ProjectRow, envPrefix: string): void {
		const credential = this.ensureBuiltInCredential(databaseId, 'owner');
		this.ctx.db
			.insert(databaseAttachments)
			.values({
				id: newId('dba_'),
				orgId: project.orgId,
				databaseId,
				projectId: project.id,
				envPrefix,
				credentialId: credential?.id ?? null,
				createdBy: principal.userId,
				createdAt: this.ctx.now(),
			})
			.run();
	}

	private insertBuiltInCredentials(
		principal: Principal,
		databaseId: string,
		name: string,
		ownerSecret: string,
		monitorSecret: string,
	): void {
		const now = this.ctx.now();
		const username = databaseIdentifier(name);
		this.ctx.db
			.insert(databaseCredentials)
			.values([
				{
					id: newId('dbc_'),
					orgId: principal.orgId,
					databaseId,
					role: 'owner',
					username,
					secretSealed: ownerSecret,
					purpose: 'Database owner (built in)',
					status: 'ready',
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				},
				{
					id: newId('dbc_'),
					orgId: principal.orgId,
					databaseId,
					role: 'monitor',
					username: DATABASE_MONITOR_USER,
					secretSealed: monitorSecret,
					purpose: 'Stats sampler (built in)',
					status: 'ready',
					createdBy: principal.userId,
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
	}

	/** Old databases predate credential rows; materialise the built-in row on first use. */
	private ensureBuiltInCredential(
		databaseId: string,
		role: 'owner' | 'monitor',
	): typeof databaseCredentials.$inferSelect | undefined {
		const existing = this.ctx.db
			.select()
			.from(databaseCredentials)
			.where(and(eq(databaseCredentials.databaseId, databaseId), eq(databaseCredentials.role, role)))
			.get();
		if (existing) return existing;
		const db = this.ctx.db.select().from(databases).where(eq(databases.id, databaseId)).get();
		if (!db) return undefined;
		const row = {
			id: newId('dbc_'),
			orgId: db.orgId,
			databaseId,
			role,
			username: role === 'owner' ? databaseIdentifier(db.name) : DATABASE_MONITOR_USER,
			secretSealed: role === 'owner' ? db.ownerSecret : db.monitorSecret,
			pendingSecretSealed: null,
			purpose: role === 'owner' ? 'Database owner (built in)' : 'Stats sampler (built in)',
			status: 'ready' as const,
			lastUsedAt: null,
			expiresAt: null,
			revokedAt: null,
			createdBy: db.createdBy,
			createdAt: db.createdAt,
			updatedAt: this.ctx.now(),
		};
		this.ctx.db.insert(databaseCredentials).values(row).run();
		return row;
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
				envNames: databaseEnvNames(attachment.envPrefix, {
					pooler: db.poolerEnabled && db.poolerPort !== null,
					tls: this.tlsEnabled(),
				}),
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

	/** Studio view. An expired request reads as stopped; the password is deliberately absent. */
	private publicUrlView(row: DatabaseRow): DatabasePublicUrlView {
		return {
			configured: row.publicUrlSealed !== null,
			updatedAt: row.publicUrlUpdatedAt ? new Date(row.publicUrlUpdatedAt).toISOString() : null,
			updatedBy: row.publicUrlUpdatedBy,
		};
	}

	private consoleView(row: DatabaseRow, now = this.ctx.now()): DatabaseConsoleView {
		const expired = row.consoleRequested && row.consoleExpiresAt !== null && row.consoleExpiresAt <= now;
		const active = row.consoleRequested && !expired;
		const status: DatabaseConsoleStatus = expired ? 'stopped' : row.consoleStatus;
		return {
			status,
			active,
			readOnly: row.consoleReadOnly,
			port: active ? row.consolePort : null,
			expiresAt: active && row.consoleExpiresAt !== null ? new Date(row.consoleExpiresAt).toISOString() : null,
			idleMinutes: Math.max(1, Math.round(row.consoleIdleMs / 60_000)),
			lastUsedAt: row.consoleLastUsedAt ? new Date(row.consoleLastUsedAt).toISOString() : null,
			error: expired ? null : row.consoleError,
			path: `/databases/${encodeURIComponent(row.name)}/studio/proxy/`,
		};
	}

	private toView(row: DatabaseRow): DatabaseView {
		const info = databaseEngineRegistry[row.engine];
		const node = this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
		const user = databaseIdentifier(row.name);
		const tls = this.tlsState(row);
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
				mode: 'transaction',
				urlTemplate:
					row.poolerEnabled && row.poolerPort !== null
						? `postgres://{user}:{pass}@{host}:{port}/{database}${tls.enabled ? '?sslmode=require' : ''}`
						: null,
			},
			tls,
			volume: this.ctx.volumes.summary(row.volumeId),
			attachments: this.attachmentsOf(row.id),
			tables: parseJson<DatabaseTableStat[]>(row.statsJson, []),
			statsAt: row.statsAt ? new Date(row.statsAt).toISOString() : null,
			extensions: parseJson(row.extensionsJson, []),
			slowQueries: parseJson(row.slowQueriesJson, []),
			slowQueriesAt: row.slowQueriesAt ? new Date(row.slowQueriesAt).toISOString() : null,
			backup: this.backupSummary(row),
			console: this.consoleView(row),
			publicUrl: this.publicUrlView(row),
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
			deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
			purgeAt: row.purgeAt ? new Date(row.purgeAt).toISOString() : null,
		};
	}
}

/** The studio is an interactive, audited human surface (D60); agents and API keys cannot use it. */
function requireInteractiveStudio(principal: Principal): void {
	if (principal.kind !== 'user')
		throw new CoreError('forbidden', 'The database studio needs an interactive user session.', 403);
}

function password(): string {
	return Buffer.from(randomBytes(24)).toString('base64url');
}

function connectionUrl(scheme: string, user: string, pass: string, host: string, port: number, db: string): string {
	return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${encodeURIComponent(db)}`;
}

function toCredentialView(row: typeof databaseCredentials.$inferSelect): DatabaseCredentialView {
	return {
		id: row.id,
		databaseId: row.databaseId,
		role: row.role,
		username: row.username,
		purpose: row.purpose,
		status: row.status,
		lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
		expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
		createdAt: new Date(row.createdAt).toISOString(),
		revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
	};
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

function databaseActivationVersion(
	row: DatabaseRow,
	env: Record<string, string>,
	pitrStanza: string | null = null,
	tls = false,
): string {
	return sha256Hex(
		JSON.stringify({
			id: row.id,
			// Bump when the fixed helper profile changes and existing units must be re-rendered.
			profile: 4,
			engine: row.engine,
			version: row.version,
			port: row.hostPort,
			poolerPort: row.poolerPort,
			restartGeneration: row.restartGeneration,
			// Omitted when off so enabling the flag is the only change that restarts databases.
			...(tls ? { tls: true } : {}),
			env,
			extensions: row.extensionsJson,
			pitrStanza,
			// A rotated secret must re-activate consumers even though the public spec is unchanged.
			secret: sha256Hex(`${row.ownerSecret}:${row.monitorSecret}`),
		}),
	);
}
