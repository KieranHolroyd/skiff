import { and, eq, isNull } from 'drizzle-orm';
import { deployments, nodes, projects, releases, workloads } from '@skiff/db';
import {
	canViewPlatform,
	githubRunnerSecretNames,
	githubRunnerTarget,
	orgNetworkName,
	parseWorkloadReplicaId,
	requirePermission,
	workloadEnvIssues,
	workloadReplicaId,
	workloadSpecSchema,
	workloadVariablesSchema,
	type GithubRunnerPoolView,
	type NodeCapacityView,
	type Principal,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadRuntime,
	type WorkloadSpec,
	type WorkloadSpecInput,
	type WorkloadStatus,
	type WorkloadVariables,
	type WorkloadView,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
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
		if (this.ctx.moves.quiescedProjectIds().has(project.id))
			throw new ConflictError(
				`"${project.slug}" is stopped while a database it uses moves to another node. Deploy again once the move finishes.`,
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
			memoryMb: reservedMemoryMb(spec),
			edgeNodeId: this.edgeNodeId(),
			candidates: this.candidates(),
		});
		if (!decision.ok) throw new ValidationError(decision.message, decision.freeByNode);
		const current = this.ctx.db
			.select({ memoryMb: workloads.memoryMb })
			.from(workloads)
			.where(eq(workloads.projectId, project.id))
			.get();
		this.ctx.quota.assertCanAdmitMemory(
			project.orgId,
			project.id,
			Math.max(0, reservedMemoryMb(spec) - (current?.memoryMb ?? 0)),
		);
		this.assertRunnerResolvable(project, spec);
		const upstream = upstreamFor(project.id, spec);
		return {
			spec,
			nodeId: decision.nodeId,
			upstream,
			activationVersion: activationVersion(spec, this.attachmentsVersion(project.id, decision.nodeId, spec.runtime, project.orgId, spec)),
		};
	}

	/** Persist the project-level spec (validated); placement is still resolved at deploy time. */
	setSpec(principal: Principal, project: ProjectRow, input: WorkloadSpecInput): WorkloadView | null {
		requirePermission(principal, 'project:update');
		if (project.runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process" or "container" to run a workload.`,
			);
		const spec = workloadSpecSchema.parse({ ...input, runtime: project.runtime });
		this.assertEnvResolvable(project, spec);
		this.assertRunnerResolvable(project, spec);
		const existing = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		this.ctx.quota.assertCanAdmitMemory(
			project.orgId,
			project.id,
			Math.max(0, reservedMemoryMb(spec) - (existing?.memoryMb ?? 0)),
		);
		this.ctx.db
			.update(projects)
			.set({ workloadJson: JSON.stringify(spec), updatedAt: this.ctx.now() })
			.where(eq(projects.id, project.id))
			.run();
		if (existing)
			this.ctx.db
				.update(workloads)
				.set({
					specJson: JSON.stringify(spec),
					runtime: spec.runtime,
					memoryMb: reservedMemoryMb(spec),
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

	/**
	 * Replace a project's environment in one step: write any new secret values as project secrets,
	 * then save the plain env and references into the spec. Everything is validated before the
	 * first write, so a refused save creates no secret versions. A running workload restarts with
	 * the result on its next reconcile.
	 */
	async setVariables(principal: Principal, project: ProjectRow, input: WorkloadVariables): Promise<WorkloadView | null> {
		requirePermission(principal, 'project:update');
		const variables = workloadVariablesSchema.parse(input);
		if (variables.newSecrets.length > 0) requirePermission(principal, 'secret:create');
		if (project.runtime === 'static')
			throw new ValidationError(`Project "${project.slug}" is static and has no environment variables.`);
		const current = this.projectSpec(project);
		if (!current && project.runtime === 'container')
			throw new ValidationError('Set the container image under Runtime before adding variables.');
		const spec = workloadSpecSchema.parse({
			...(current ?? this.defaultSpec(project)),
			env: variables.env,
			secrets: variables.secrets,
		});
		const pending = new Set<string>();
		for (const secret of variables.newSecrets) {
			if (pending.has(secret.name)) throw new ValidationError(`Secret ${secret.name} is set more than once.`);
			pending.add(secret.name);
		}
		this.assertEnvResolvable(project, spec, pending);
		for (const secret of variables.newSecrets) {
			await this.ctx.secrets.set(principal, { name: secret.name, value: secret.value, projectId: project.id });
		}
		return this.setSpec(principal, project, spec);
	}

	/**
	 * Refuse a spec whose variables clash or whose secret references cannot resolve for this
	 * project. Activation skips a missing secret, so without this the app would start without it.
	 */
	private assertEnvResolvable(project: ProjectRow, spec: WorkloadSpec, pending: Set<string> = new Set()): void {
		const issues = workloadEnvIssues(spec);
		for (const ref of spec.secrets) {
			if (pending.has(ref.name) && ref.version === undefined) continue;
			const resolved = this.ctx.secrets.resolve(project.orgId, project.id, ref.name);
			if (!resolved) issues.push(`Secret ${ref.name} does not exist for this project or the organisation.`);
			else if (ref.version !== undefined && !resolved.versions.includes(ref.version))
				issues.push(`Secret ${ref.name} has no version ${ref.version}.`);
		}
		if (issues.length > 0) throw new ValidationError(issues.join(' '), issues);
	}

	/**
	 * A runner's GitHub credential is read by the control plane only, so it is not in
	 * `spec.secrets`; check it resolves here or the pool would fail at its first activation.
	 */
	private assertRunnerResolvable(project: ProjectRow, spec: WorkloadSpec): void {
		if (!spec.runner) return;
		const missing = githubRunnerSecretNames(spec.runner).filter(
			(name) => !this.ctx.secrets.resolve(project.orgId, project.id, name),
		);
		if (missing.length > 0)
			throw new ValidationError(
				`Runner credential secret ${missing.join(', ')} does not exist. Create it before deploying.`,
				missing.map((name) => `Secret ${name} does not exist.`),
			);
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
				this.attachmentsVersion(project.id, deployment.nodeId, parsed.data.runtime, project.orgId, parsed.data),
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
			memoryMb: reservedMemoryMb(resolved.spec),
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
		const runner = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data?.runner;
		this.ctx.db.delete(workloads).where(eq(workloads.id, row.id)).run();
		// Registrations are removed from GitHub in the background; the units stop on reconcile.
		void this.ctx.githubRunners.deregisterProject(project, runner);
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

		// Apps whose database is moving stay listed but stopped, so the agent keeps their state (D97).
		const quiesced = this.ctx.moves.quiescedProjectIds();
		return rows.flatMap(({ workload, project, deployment }) => {
			const spec = this.specOf(project, workload);
			const release = this.ctx.db
				.select({ sha256: releases.sha256 })
				.from(releases)
				.where(eq(releases.id, deployment.releaseId))
				.get();
			const isolated = featureEnabled(this.ctx.config, 'ORG_NETWORKS');
			const volumes = this.ctx.appVolumes.mountsForWorkload(workload.id);
			const worker = spec.ingress === 'none';
			const base: WorkloadDesired = {
				id: workload.id,
				projectId: project.id,
				projectSlug: project.slug,
				deploymentId: deployment.id,
				...(isolated ? { orgId: project.orgId, networkName: orgNetworkName(project.orgId) } : {}),
				runtime: workload.runtime,
				status: quiesced.has(project.id) ? 'stopped' : workload.status,
				release: release?.sha256 ?? null,
				...(spec.command ? { command: spec.command } : {}),
				...(spec.image ? { image: spec.image } : {}),
				upstream: workload.upstream ?? upstreamFor(project.id, spec),
				// The row holds the whole reservation (D90); each unit is capped at one replica's share.
				memoryMb: spec.memoryMb,
				cpus: workload.cpus,
				port: spec.port,
				healthPath: spec.healthPath,
				socketActivation: worker ? false : spec.socketActivation,
				activationVersion: activationVersion(spec, this.attachmentsVersion(project.id, workload.nodeId, spec.runtime, project.orgId, spec)),
				env: spec.env,
				secrets: spec.secrets,
				dataSizeMb: spec.data?.sizeMb ?? null,
				...(volumes.length > 0 ? { volumes } : {}),
				...(worker ? { ingress: 'none' as const } : {}),
				...(spec.runner ? { runner: { provider: 'github' as const } } : {}),
			};
			// Plain single-copy workloads keep exactly the desired state they had before plan 21.
			if (spec.replicas === 1 && !spec.runner) return [base];
			return Array.from({ length: spec.replicas }, (_, index) => ({
				...base,
				id: workloadReplicaId(workload.id, index),
				replica: { index },
			}));
		});
	}

	/**
	 * Decrypted values for one workload. The node token must own the workload's node; the payload
	 * is never cached on disk by the agent.
	 */
	activation(nodeId: string, desiredId: string): WorkloadActivation {
		if (this.ctx.databases.isDatabaseId(desiredId)) return this.ctx.databases.activation(nodeId, desiredId);
		if (this.ctx.storage.isStorageId(desiredId)) return this.ctx.storage.activation(nodeId, desiredId);
		const { workloadId, replica } = parseWorkloadReplicaId(desiredId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) throw new NotFoundError('Workload');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This workload is placed on another node.', 403);
		const spec = this.specOf(this.requireProject(row.projectId), row);
		if (replica >= spec.replicas) throw new NotFoundError('Workload replica');
		// Attached database and storage connection values sit under the spec's own env and secrets (D56, S4).
		const env: Record<string, string> = {
			...this.ctx.storage.consumerEnv(row.projectId, row.nodeId, spec.runtime),
			...this.ctx.databases.consumerEnv(row.projectId, row.nodeId, spec.runtime),
			...spec.env,
		};
		const files: Record<string, string> = {};
		for (const ref of spec.secrets) {
			const value = this.ctx.secrets.getValue(row.orgId, ref.name, ref.version, row.projectId);
			if (!value) continue;
			if (ref.delivery === 'file') files[ref.name] = value.value;
			else env[ref.name] = value.value;
		}
		return {
			workloadId: desiredId,
			activationVersion: activationVersion(spec, this.attachmentsVersion(row.projectId, row.nodeId, spec.runtime, row.orgId, spec)),
			env,
			files,
		};
	}

	/**
	 * The activation the agent endpoint serves. A runner replica additionally gets a fresh,
	 * single-use JIT config on every call (D91): the agent only asks again after the replica's
	 * container exited, so each job runs on a newly registered runner.
	 */
	async activationFor(nodeId: string, desiredId: string): Promise<WorkloadActivation> {
		const activation = this.activation(nodeId, desiredId);
		const { workloadId, replica } = parseWorkloadReplicaId(desiredId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) return activation;
		const project = this.requireProject(row.projectId);
		const spec = this.specOf(project, row);
		if (!spec.runner) return activation;
		try {
			const env = await this.ctx.githubRunners.mintJitConfig({
				orgId: row.orgId,
				projectId: row.projectId,
				projectSlug: project.slug,
				workloadId: row.id,
				replica,
				runner: spec.runner,
			});
			if (row.message?.startsWith(RUNNER_MESSAGE_PREFIX)) this.ctx.githubRunners.noteFailure(row.id, null);
			return { ...activation, env: { ...activation.env, ...env } };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx.githubRunners.noteFailure(row.id, `${RUNNER_MESSAGE_PREFIX}${message}`.slice(0, 500));
			throw error;
		}
	}

	/** Apply the agent's actual-state report from a heartbeat. */
	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		for (const report of aggregateReplicaReports(reports)) {
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

	/** The runner pool as GitHub reports it, for the dashboard and `GET .../runners`. */
	async runnerPool(principal: Principal, project: ProjectRow): Promise<GithubRunnerPoolView | null> {
		requirePermission(principal, 'deployment:read');
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		const spec = row ? this.specOf(project, row) : this.projectSpec(project);
		if (!spec?.runner) return null;
		return this.ctx.githubRunners.pool(principal, project, spec);
	}

	private requireProject(projectId: string): ProjectRow {
		const row = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!row) throw new NotFoundError('Project');
		return row as ProjectRow;
	}

	private toView(project: ProjectRow, row: WorkloadRow): WorkloadView {
		const spec = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data;
		return {
			ingress: spec?.ingress ?? 'http',
			replicas: spec?.replicas ?? 1,
			runner: spec?.runner ? { provider: 'github', target: githubRunnerTarget(spec.runner) } : null,
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
	 * Secret references add the version each one resolves to, so saving a new secret value restarts
	 * the app with it; a spec without secret references keeps its hash.
	 */
	private attachmentsVersion(
		projectId: string,
		nodeId: string | null,
		runtime: WorkloadRuntime,
		orgId: string,
		spec: WorkloadSpec,
	): string {
		return [
			this.ctx.databases.consumerVersion(projectId, nodeId, runtime),
			this.ctx.storage.consumerVersion(projectId, nodeId, runtime),
			this.ctx.appVolumes.projectVersion(projectId),
			this.secretsVersion(orgId, projectId, spec),
		]
			.filter(Boolean)
			.join(':');
	}

	private secretsVersion(orgId: string, projectId: string, spec: WorkloadSpec): string {
		if (spec.secrets.length === 0) return '';
		const resolved = spec.secrets.map((ref) => {
			const found = this.ctx.secrets.resolve(orgId, projectId, ref.name);
			const version = ref.version ?? found?.versions[0] ?? 0;
			return `${ref.name}=${found?.scope ?? 'missing'}@${version}`;
		});
		return `secrets:${sha256Hex(resolved.join(','))}`;
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

const RUNNER_MESSAGE_PREFIX = 'Runner: ';

/** Slice budget a workload reserves: one share per replica (D90). */
export function reservedMemoryMb(spec: Pick<WorkloadSpec, 'memoryMb' | 'replicas'>): number {
	return spec.memoryMb * (spec.replicas ?? 1);
}

const STATUS_RANK: Record<WorkloadStatus, number> = { failed: 4, pending: 3, starting: 2, stopped: 1, running: 0 };

/**
 * Fold replica reports (`<id>-r<n>`) into one report per workload: the worst status wins and
 * restarts is the largest count, so one crash-looping copy marks the pool failed.
 */
export function aggregateReplicaReports(
	reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>,
): Array<{ id: string; status: WorkloadStatus; restarts: number }> {
	const merged = new Map<string, { id: string; status: WorkloadStatus; restarts: number }>();
	for (const report of reports) {
		const { workloadId } = parseWorkloadReplicaId(report.id);
		const current = merged.get(workloadId);
		if (!current) {
			merged.set(workloadId, { id: workloadId, status: report.status, restarts: report.restarts });
			continue;
		}
		if (STATUS_RANK[report.status] > STATUS_RANK[current.status]) current.status = report.status;
		current.restarts = Math.max(current.restarts, report.restarts);
	}
	return [...merged.values()];
}

/** The upstream Caddy proxies to on the workload's node. Socket activation is the default. */
export function upstreamFor(projectId: string, spec: WorkloadSpec): string {
	// Workers have no route; the value is never dialled and marks the row in listings.
	if (spec.ingress === 'none') return 'none';
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
			// Only present when set, so existing workloads keep their version (no restart on upgrade).
			// `replicas` is left out on purpose: scaling adds or removes copies without restarting any.
			...(spec.ingress === 'none' ? { ingress: 'none' } : {}),
			...(spec.runner ? { runner: spec.runner } : {}),
		}),
	);
}
