import { and, eq, isNull } from 'drizzle-orm';
import { deployments, nodes, projects, releases, workloads } from '@skiff/db';
import {
	canViewPlatform,
	orgNetworkName,
	requirePermission,
	workloadSpecSchema,
	type NodeCapacityView,
	type Principal,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadRuntime,
	type WorkloadSpec,
	type WorkloadStatus,
	type WorkloadView,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, ValidationError } from './errors.ts';
import { resolvePlacement, type PlacementCandidate } from './placement.ts';
import { parseJson, newId, sha256Hex } from './util.ts';
import { nodeDiskFreeBytes } from './app-volumes.ts';
import type { ProjectRow } from './projects.ts';

export type WorkloadRow = typeof workloads.$inferSelect;

const ACTIVE_STATUSES: WorkloadStatus[] = ['pending', 'starting', 'running'];

export interface ResolvedWorkload {
	spec: WorkloadSpec;
	nodeId: string;
	upstream: string;
	activationVersion: string;
}

/**
 * Tier 2/3 runtime state (DESIGN §3.4). Placement is resolved once per deploy, admission is
 * checked against the target node's `skiff-workloads.slice` budget, and the agent receives only
 * public spec fields plus secret *references*. Values are fetched at activation time.
 */
export class WorkloadService {
	constructor(private readonly ctx: CoreContext) {}

	/** Load the project's configured spec; `runtime` projects must have one. */
	projectSpec(project: ProjectRow): WorkloadSpec | null {
		const raw = parseJson<unknown>(project.workloadJson, null);
		if (raw) return workloadSpecSchema.parse(raw);
		return null;
	}

	defaultSpec(project: ProjectRow): WorkloadSpec {
		if (project.runtime === 'static') throw new ValidationError('Static projects have no workload spec.');
		if (project.runtime === 'container')
			throw new ValidationError(
				`Project "${project.slug}" needs a workload spec with an image before it can deploy.`,
			);
		return workloadSpecSchema.parse({ runtime: project.runtime, command: ['bun', 'run', 'start'] });
	}

	private specOf(project: ProjectRow, row: WorkloadRow): WorkloadSpec {
		const parsed = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null));
		if (!parsed.success) throw new ValidationError(`Workload spec for "${project.slug}" is invalid.`);
		return parsed.data;
	}

	plan(principal: Principal, project: ProjectRow, input?: Partial<WorkloadSpec>): ResolvedWorkload {
		requirePermission(principal, 'deployment:create');
		const spec = workloadSpecSchema.parse({
			...(this.projectSpec(project) ?? this.defaultSpec(project)),
			...input,
			runtime: project.runtime === 'static' ? (input?.runtime ?? 'process') : project.runtime,
		});
		if (project.runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process" or "container" to run a workload.`,
			);
		// A project with attached databases or private storage runs next to them (D56, S5).
		const pinned = this.attachmentNode(project.id);
		if (pinned) {
			const conflict =
				this.ctx.databases.placementConflict(project, pinned) ?? this.ctx.storage.placementConflict(project, pinned);
			if (conflict) throw new ValidationError(conflict);
		}
		const decision = resolvePlacement({
			runtime: project.runtime,
			requested: pinned ?? project.placement,
			memoryMb: spec.memoryMb,
			edgeNodeId: this.edgeNodeId(),
			candidates: this.candidates(),
		});
		if (!decision.ok) throw new ValidationError(decision.message, decision.freeByNode);
		const upstream = upstreamFor(project.id, spec);
		return {
			spec,
			nodeId: decision.nodeId,
			upstream,
			activationVersion: activationVersion(spec, this.attachmentsVersion(project.id, decision.nodeId, spec.runtime)),
		};
	}

	/** Persist the project-level spec (validated); placement is still resolved at deploy time. */
	setSpec(principal: Principal, project: ProjectRow, input: WorkloadSpec): WorkloadView | null {
		requirePermission(principal, 'project:update');
		if (project.runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process" or "container" to run a workload.`,
			);
		const spec = workloadSpecSchema.parse({ ...input, runtime: project.runtime });
		this.ctx.db
			.update(projects)
			.set({ workloadJson: JSON.stringify(spec), updatedAt: this.ctx.now() })
			.where(eq(projects.id, project.id))
			.run();
		const existing = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (existing)
			this.ctx.db
				.update(workloads)
				.set({
					specJson: JSON.stringify(spec),
					runtime: spec.runtime,
					memoryMb: spec.memoryMb,
					cpus: Math.round(spec.cpus),
					upstream: upstreamFor(project.id, spec),
					status: 'pending',
					updatedAt: this.ctx.now(),
				})
				.where(eq(workloads.id, existing.id))
				.run();
		this.ctx.projects.bump(project.orgId);
		return this.view(project);
	}

	/** Re-point the workload at an existing deployment (promote/rollback); placement is preserved. */
	syncDeployment(project: ProjectRow, deploymentId: string): void {
		const deployment = this.ctx.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
		if (!deployment || !deployment.workloadJson || !deployment.nodeId) return;
		const parsed = workloadSpecSchema.safeParse(parseJson<unknown>(deployment.workloadJson, null));
		if (!parsed.success) return;
		this.record(project, deploymentId, {
			spec: parsed.data,
			nodeId: deployment.nodeId,
			upstream: upstreamFor(project.id, parsed.data),
			activationVersion: activationVersion(
				parsed.data,
				this.attachmentsVersion(project.id, deployment.nodeId, parsed.data.runtime),
			),
		});
	}

	/** Record the resolved workload for a new deployment (called from DeploymentService). */
	record(project: ProjectRow, deploymentId: string, resolved: ResolvedWorkload): void {
		const now = this.ctx.now();
		const existing = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		const values = {
			orgId: project.orgId,
			projectId: project.id,
			deploymentId,
			nodeId: resolved.nodeId,
			runtime: resolved.spec.runtime,
			status: 'pending' as const,
			specJson: JSON.stringify(resolved.spec),
			memoryMb: resolved.spec.memoryMb,
			cpus: Math.round(resolved.spec.cpus),
			upstream: resolved.upstream,
			message: null,
			updatedAt: now,
		};
		if (existing) this.ctx.db.update(workloads).set(values).where(eq(workloads.id, existing.id)).run();
		else
			this.ctx.db
				.insert(workloads)
				.values({ ...values, id: newId('wld_'), createdAt: now })
				.run();
	}

	view(project: ProjectRow): WorkloadView | null {
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		return row ? this.toView(project, row) : null;
	}

	get(principal: Principal, project: ProjectRow): WorkloadView | null {
		requirePermission(principal, 'deployment:read');
		return this.view(project);
	}

	remove(principal: Principal, project: ProjectRow): void {
		requirePermission(principal, 'project:update');
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!row) throw new NotFoundError('Workload');
		this.ctx.db.delete(workloads).where(eq(workloads.id, row.id)).run();
		this.ctx.db.update(projects).set({ workloadJson: null, updatedAt: this.ctx.now() }).where(eq(projects.id, project.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'workload.remove',
			resource: 'workload',
			resourceId: row.id,
			args: { project: project.slug },
			result: 'ok',
		});
		this.ctx.projects.bump(project.orgId);
	}

	capacity(principal: Principal): NodeCapacityView[] {
		if (!canViewPlatform(principal)) throw new CoreError('forbidden', 'Platform admin required.', 403);
		return this.capacityInternal();
	}

	capacityInternal(): NodeCapacityView[] {
		const reserved = this.reservedByNode();
		const reservedDisk = this.ctx.appVolumes.reservedDiskByNode();
		const databaseCounts = this.ctx.databases.countByNode();
		const storageCounts = this.ctx.storage.countByNode();
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((node) => {
				const stats = parseJson<Record<string, unknown> | null>(node.statsJson, null);
				const total = stats?.diskTotalBytes;
				return {
					nodeId: node.id,
					name: node.name,
					mode: node.mode,
					status: node.status,
					sliceMemoryMb: node.sliceMemoryMb,
					reservedMemoryMb: reserved.get(node.id) ?? 0,
					freeMemoryMb: node.sliceMemoryMb - (reserved.get(node.id) ?? 0),
					workloadCount:
						(this.countByNode().get(node.id) ?? 0) +
						(databaseCounts.get(node.id) ?? 0) +
						(storageCounts.get(node.id) ?? 0),
					diskFreeBytes: nodeDiskFreeBytes(stats),
					diskTotalBytes:
						typeof total === 'number' && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : null,
					reservedDiskBytes: reservedDisk.get(node.id) ?? 0,
				};
			});
	}

	/** Desired state for one node, including only public spec fields and secret references. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		const rows = this.ctx.db
			.select({ workload: workloads, project: projects, deployment: deployments })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.innerJoin(deployments, eq(deployments.id, workloads.deploymentId))
			.where(and(eq(workloads.nodeId, nodeId), isNull(projects.deletedAt), eq(deployments.status, 'active')))
			.all();

		return rows.map(({ workload, project, deployment }) => {
			const spec = this.specOf(project, workload);
			const release = this.ctx.db
				.select({ sha256: releases.sha256 })
				.from(releases)
				.where(eq(releases.id, deployment.releaseId))
				.get();
			const isolated = featureEnabled(this.ctx.config, 'ORG_NETWORKS');
			const volumes = this.ctx.appVolumes.mountsForWorkload(workload.id);
			return {
				id: workload.id,
				projectId: project.id,
				projectSlug: project.slug,
				deploymentId: deployment.id,
				...(isolated ? { orgId: project.orgId, networkName: orgNetworkName(project.orgId) } : {}),
				runtime: workload.runtime,
				status: workload.status,
				release: release?.sha256 ?? null,
				...(spec.command ? { command: spec.command } : {}),
				...(spec.image ? { image: spec.image } : {}),
				upstream: workload.upstream ?? upstreamFor(project.id, spec),
				memoryMb: workload.memoryMb,
				cpus: workload.cpus,
				port: spec.port,
				healthPath: spec.healthPath,
				socketActivation: spec.socketActivation,
				activationVersion: activationVersion(spec, this.attachmentsVersion(project.id, workload.nodeId, spec.runtime)),
				env: spec.env,
				secrets: spec.secrets,
				dataSizeMb: spec.data?.sizeMb ?? null,
				...(volumes.length > 0 ? { volumes } : {}),
			};
		});
	}

	/**
	 * Decrypted values for one workload. The node token must own the workload's node; the payload
	 * is never cached on disk by the agent.
	 */
	activation(nodeId: string, workloadId: string): WorkloadActivation {
		if (this.ctx.databases.isDatabaseId(workloadId)) return this.ctx.databases.activation(nodeId, workloadId);
		if (this.ctx.storage.isStorageId(workloadId)) return this.ctx.storage.activation(nodeId, workloadId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) throw new NotFoundError('Workload');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This workload is placed on another node.', 403);
		const spec = this.specOf(this.requireProject(row.projectId), row);
		// Attached database and storage connection values sit under the spec's own env and secrets (D56, S4).
		const env: Record<string, string> = {
			...this.ctx.storage.consumerEnv(row.projectId, row.nodeId, spec.runtime),
			...this.ctx.databases.consumerEnv(row.projectId, row.nodeId, spec.runtime),
			...spec.env,
		};
		const files: Record<string, string> = {};
		for (const ref of spec.secrets) {
			const value = this.ctx.secrets.getValue(row.orgId, ref.name, ref.version);
			if (!value) continue;
			if (ref.delivery === 'file') files[ref.name] = value.value;
			else env[ref.name] = value.value;
		}
		return {
			workloadId: row.id,
			activationVersion: activationVersion(spec, this.attachmentsVersion(row.projectId, row.nodeId, spec.runtime)),
			env,
			files,
		};
	}

	/** Apply the agent's actual-state report from a heartbeat. */
	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		for (const report of reports) {
			const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, report.id)).get();
			if (!row || row.nodeId !== nodeId) continue;
			const status: WorkloadStatus =
				report.status === 'running' && report.restarts >= 5 ? 'failed' : report.status;
			if (status === row.status) continue;
			this.ctx.db
				.update(workloads)
				.set({
					status,
					message: report.restarts >= 5 ? `Restart loop (${report.restarts} restarts)` : row.message,
					updatedAt: this.ctx.now(),
				})
				.where(eq(workloads.id, row.id))
				.run();
		}
	}

	private requireProject(projectId: string): ProjectRow {
		const row = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!row) throw new NotFoundError('Project');
		return row as ProjectRow;
	}

	private toView(project: ProjectRow, row: WorkloadRow): WorkloadView {
		return {
			id: row.id,
			projectId: project.id,
			projectSlug: project.slug,
			deploymentId: row.deploymentId,
			nodeId: row.nodeId,
			runtime: row.runtime,
			status: row.status,
			memoryMb: row.memoryMb,
			cpus: row.cpus,
			upstream: row.upstream,
			message: row.message,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	/**
	 * The node a project must run on because of its attached databases and private storage, or
	 * null when nothing pins it. Throws when they live on different nodes.
	 */
	attachmentNode(projectId: string): string | null {
		const nodeIds = [
			...new Set(
				[this.ctx.databases.requiredNode(projectId), this.ctx.storage.requiredNode(projectId)].filter(
					(id): id is string => id !== null,
				),
			),
		];
		if (nodeIds.length > 1)
			throw new ValidationError(
				'Attached databases and private storage live on different nodes; detach one, or make the storage public.',
			);
		return nodeIds[0] ?? null;
	}

	/**
	 * Attachment fingerprint for the activation version. Databases alone keep their existing
	 * fingerprint, and projects with no attachments keep the plain spec hash (no restart on upgrade).
	 */
	private attachmentsVersion(projectId: string, nodeId: string | null, runtime: WorkloadRuntime): string {
		return [
			this.ctx.databases.consumerVersion(projectId, nodeId, runtime),
			this.ctx.storage.consumerVersion(projectId, nodeId, runtime),
			this.ctx.appVolumes.projectVersion(projectId),
		]
			.filter(Boolean)
			.join(':');
	}

	/** Edge node id (config or first edge), for placement by other services. */
	edgeNode(): string | null {
		return this.edgeNodeId();
	}

	/** Placement candidates with current reservations (workloads + databases). */
	placementCandidates(): PlacementCandidate[] {
		return this.candidates();
	}

	private edgeNodeId(): string | null {
		if (this.ctx.config.edgeNodeId) return this.ctx.config.edgeNodeId;
		return (
			this.ctx.sqlite
				.query<{ id: string }, []>("SELECT id FROM nodes WHERE mode = 'edge' ORDER BY created_at ASC LIMIT 1")
				.get()?.id ?? null
		);
	}

	private candidates(): PlacementCandidate[] {
		const reserved = this.reservedByNode();
		const reservedDisk = this.ctx.appVolumes.reservedDiskByNode();
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((node) => ({
				id: node.id,
				name: node.name,
				mode: node.mode,
				status: node.status,
				sliceMemoryMb: node.sliceMemoryMb,
				reservedMemoryMb: reserved.get(node.id) ?? 0,
				diskFreeBytes: nodeDiskFreeBytes(parseJson<Record<string, unknown> | null>(node.statsJson, null)),
				reservedDiskBytes: reservedDisk.get(node.id) ?? 0,
			}));
	}

	private reservedByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; total: number | null }, [string, string, string]>(
				// Only live projects reserve budget: a trashed project's workload is no longer in desired
				// state, so its agent stops it and never reports it again (docs/OPERATIONS.md L5).
				`SELECT w.node_id AS nodeId, SUM(w.memory_mb) AS total FROM workloads w
				 JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
				 WHERE w.node_id IS NOT NULL AND w.status IN (?, ?, ?) GROUP BY w.node_id`,
			)
			.all('pending', 'starting', 'running');
		const reserved = new Map(rows.map((row) => [row.nodeId, row.total ?? 0]));
		// Managed databases and storage share the same slice budget (D55, S1).
		for (const [nodeId, total] of this.ctx.databases.reservedByNode())
			reserved.set(nodeId, (reserved.get(nodeId) ?? 0) + total);
		for (const [nodeId, total] of this.ctx.storage.reservedByNode())
			reserved.set(nodeId, (reserved.get(nodeId) ?? 0) + total);
		return reserved;
	}

	private countByNode(): Map<string, number> {
		const rows = this.ctx.sqlite
			.query<{ nodeId: string; n: number }, []>(
				'SELECT node_id AS nodeId, COUNT(*) AS n FROM workloads WHERE node_id IS NOT NULL GROUP BY node_id',
			)
			.all();
		return new Map(rows.map((row) => [row.nodeId, row.n]));
	}
}

/** The upstream Caddy proxies to on the workload's node. Socket activation is the default. */
export function upstreamFor(projectId: string, spec: WorkloadSpec): string {
	if (spec.runtime === 'process' && spec.socketActivation) return `unix//run/skiff-workloads/${projectId}.sock`;
	return `127.0.0.1:${spec.port}`;
}

/**
 * Stable hash of the parts that affect activation, so the agent knows when to re-fetch values.
 * `databases` is the attachment fingerprint; it is left out when empty so projects without
 * databases keep their existing version (no restart on upgrade).
 */
export function activationVersion(spec: WorkloadSpec, databases = ''): string {
	return sha256Hex(
		JSON.stringify({
			env: spec.env,
			secrets: spec.secrets,
			command: spec.command,
			image: spec.image,
			port: spec.port,
			...(databases ? { databases } : {}),
		}),
	);
}
