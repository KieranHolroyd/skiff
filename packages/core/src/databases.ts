import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { databaseAttachments, databases, nodes, projects, workloads } from '@skiff/db';
import {
	DATABASE_MONITOR_USER,
	DATABASE_PORT_MAX,
	DATABASE_PORT_MIN,
	databaseAlias,
	databaseAttachSchema,
	databaseCreateSchema,
	databaseEngineRegistry,
	databaseEnvNames,
	databaseIdentifier,
	databaseImage,
	databaseUpdateSchema,
	limits,
	requirePermission,
	type DatabaseAttach,
	type DatabaseAttachmentView,
	type DatabaseCreate,
	type DatabaseCredentials,
	type DatabaseMetricBucket,
	type DatabaseMetricPoint,
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
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { resolvePlacement } from './placement.ts';
import type { ProjectRow } from './projects.ts';
import { newId, parseJson, randomBytes, sha256Hex } from './util.ts';

export type DatabaseRow = typeof databases.$inferSelect;

const ACTIVE: DatabaseStatus[] = ['pending', 'starting', 'running'];
const DAY_MS = 86_400_000;

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

		const decision = resolvePlacement({
			runtime: 'container',
			requested,
			memoryMb,
			edgeNodeId: this.ctx.workloads.edgeNode(),
			candidates: this.ctx.workloads.placementCandidates(),
		});
		if (!decision.ok)
			throw new ValidationError(decision.message.replace('this app reserves', 'this database reserves'), decision.freeByNode);

		const id = newId('db_');
		const now = this.ctx.now();
		const hostPort = this.allocatePort(decision.nodeId);
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
					status: 'pending',
					ownerSecret: this.ctx.secrets.seal(principal.orgId, password()),
					monitorSecret: this.ctx.secrets.seal(principal.orgId, password()),
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
		this.ctx.db
			.update(databases)
			.set({ ...patch, updatedAt: this.ctx.now() })
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
					database: { engine: row.engine, version: row.version },
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
			if (status === row.status) continue;
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
			this.ctx.sqlite.transaction(() => {
				this.ctx.db.delete(databaseAttachments).where(eq(databaseAttachments.databaseId, id)).run();
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
			this.ctx.db
				.update(databases)
				.set({ statsJson: JSON.stringify(snapshot.tables), statsAt: Number.isFinite(at) ? at : this.ctx.now() })
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
			attachments: this.attachmentsOf(row.id),
			tables: parseJson<DatabaseTableStat[]>(row.statsJson, []),
			statsAt: row.statsAt ? new Date(row.statsAt).toISOString() : null,
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

function databaseActivationVersion(row: DatabaseRow, env: Record<string, string>): string {
	return sha256Hex(
		JSON.stringify({ id: row.id, engine: row.engine, version: row.version, port: row.hostPort, env }),
	);
}
