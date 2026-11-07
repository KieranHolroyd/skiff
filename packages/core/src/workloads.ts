import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { deployments, nodeVolumes, nodes, projects, releases, workloadReplicas, workloads } from '@skiff/db';
import {
	canViewPlatform,
	githubRunnerSecretNames,
	githubRunnerTarget,
	orgNetworkName,
	parseWorkloadReplicaId,
	processIdleStopIssue,
	functionIsPython,
	FUNCTIONS_PYTHON_CAPABILITY,
	requirePermission,
	workloadEnvIssues,
	workloadReplicaId,
	workloadSpecSchema,
	placementSpecSchema,
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
	type WorkloadReplica,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { resolvePlacement, type PlacementCandidate } from './placement.ts';
import { planReplicas } from './replicas.ts';
import { effectiveRuntime, storedRuntime, workloadRuntimeOf } from './runtime-tier.ts';
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
	/** Multi-node replica assignments when the feature flag is on (C4). */
	replicas?: WorkloadReplica[];
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
		const runtime = effectiveRuntime(project);
		if (runtime === 'static') throw new ValidationError('Static projects have no workload spec.');
		// A function has no sensible default: the manifest is the program (D110).
		if (runtime === 'function')
			throw new ValidationError(
				`Project "${project.slug}" needs a skiff-function.json bundle before it can deploy.`,
			);
		if (runtime === 'container')
			throw new ValidationError(
				`Project "${project.slug}" needs a workload spec with an image before it can deploy.`,
			);
		return workloadSpecSchema.parse({ runtime, command: ['bun', 'run', 'start'] });
	}

	private specOf(project: ProjectRow, row: WorkloadRow): WorkloadSpec {
		const parsed = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null));
		if (!parsed.success) throw new ValidationError(`Workload spec for "${project.slug}" is invalid.`);
		return parsed.data;
	}

	plan(principal: Principal, project: ProjectRow, input?: Partial<WorkloadSpec>): ResolvedWorkload {
		requirePermission(principal, 'deployment:create');
		const runtime = effectiveRuntime(project);
		const spec = workloadSpecSchema.parse({
			...(this.projectSpec(project) ?? this.defaultSpec(project)),
			...input,
			runtime: runtime === 'static' ? (input?.runtime ?? 'process') : runtime,
		});
		if (runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process", "container" or "function" to run a workload.`,
			);
		if (runtime === 'function' && !featureEnabled(this.ctx.config, 'FUNCTIONS'))
			throw new ValidationError('Functions are not enabled on this platform (SKIFF_FEATURE_FUNCTIONS).');
		if (this.ctx.moves.quiescedProjectIds().has(project.id))
			throw new ConflictError(
				`"${project.slug}" is stopped while a database it uses moves to another node. Deploy again once the move finishes.`,
			);
		// A project with attached databases or private storage normally runs next to them (D56, S5).
		// With C2 endpoints enabled, a process app may run elsewhere: the consumer gets a loopback
		// endpoint and the provider listens on the overlay. Private storage still pins for now.
		const crossNode = featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS') && runtime === 'process';
		// Brokers have no cross-node endpoint yet (D111), so an attached broker pins even then.
		const pinned = crossNode ? this.ctx.brokers.requiredNode(project.id) : this.attachmentNode(project.id);
		if (pinned) {
			const conflict = crossNode
				? this.ctx.brokers.placementConflict(project, pinned)
				: (this.ctx.databases.placementConflict(project, pinned) ??
					this.ctx.storage.placementConflict(project, pinned) ??
					this.ctx.brokers.placementConflict(project, pinned));
			if (conflict) throw new ValidationError(conflict);
		}
		const placementSpec = placementSpecFor(project);
		const clusterConfig = this.ctx.cluster.get().replicas;
		if (featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS') && spec.replicas > clusterConfig.max)
			throw new ValidationError(`This install allows at most ${clusterConfig.max} replicas per workload.`);
		const multiNode =
			featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS') &&
			!crossNode &&
			!pinned &&
			spec.replicas > 1 &&
			spec.ingress !== 'none';
		let replicas: WorkloadReplica[] | undefined;
		let decision: ReturnType<typeof resolvePlacement>;
		if (multiNode) {
			const planned = planReplicas({
				count: spec.replicas,
				memoryMb: spec.memoryMb,
				spread: clusterConfig.spread,
				candidates: this.candidates().filter((candidate) => candidate.mode !== 'edge').map((candidate) => ({
					id: candidate.id,
					name: candidate.name,
					zone: candidate.zone ?? 'default',
					status: candidate.status,
					freeMemoryMb: candidate.sliceMemoryMb - candidate.reservedMemoryMb,
				})),
			});
			if (!planned.ok) throw new ValidationError(planned.message, planned.refusals);
			replicas = planned.plan.assignments;
			decision = { ok: true, nodeId: replicas[0]!.nodeId, mode: 'worker', reason: 'Spread replica placement.' };
		} else {
			decision = resolvePlacement({
				runtime,
				requested: pinned ?? project.placement,
				memoryMb: reservedMemoryMb(spec),
				cpuMillis: (spec.cpus ?? 1) * 1000 * (spec.replicas ?? 1),
				edgeNodeId: this.edgeNodeId(),
				candidates: this.candidates(),
				spec: placementSpec,
				nearNodeIds: placementSpec?.near ? this.nearNodeIds(placementSpec.near) : undefined,
			});
			if (!decision.ok) throw new ValidationError(decision.message, decision.rejections?.length ? decision.rejections : decision.freeByNode);
		}
		if (crossNode) this.ctx.endpoints.reconcile(project.id, decision.nodeId);
		if (runtime === 'function') this.assertFunctionTarget(decision.nodeId, Boolean(spec.function && functionIsPython(spec.function)));
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
			...(replicas ? { replicas } : {}),
		};
	}

	/** Persist the project-level spec (validated); placement is still resolved at deploy time. */
	setSpec(principal: Principal, project: ProjectRow, input: WorkloadSpecInput): WorkloadView | null {
		requirePermission(principal, 'project:update');
		const runtime = effectiveRuntime(project);
		if (runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process", "container" or "function" to run a workload.`,
			);
		const spec = workloadSpecSchema.parse({ ...input, runtime });
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
					runtime: storedWorkloadRuntime(spec.runtime),
					runtimeName: spec.runtime,
					memoryMb: reservedMemoryMb(spec),
					cpus: Math.round(spec.cpus),
					// A function's socket is named after the workload id (phase 4), not the project.
					upstream: spec.runtime === 'function' ? upstreamFor(existing.id, spec) : upstreamFor(project.id, spec),
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
		const runtime = effectiveRuntime(project);
		if (runtime === 'static')
			throw new ValidationError(`Project "${project.slug}" is static and has no environment variables.`);
		const current = this.projectSpec(project);
		if (!current && runtime === 'container')
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

	/**
	 * A function runs on workerd, which only an agent that advertised `functions` in its heartbeat
	 * can render (D110). Refuse the deploy instead of leaving the app pending forever.
	 */
	private assertFunctionTarget(nodeId: string, python = false): void {
		const node = this.ctx.db
			.select({ name: nodes.name, capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		const capabilities = nodeCapabilities(node?.capabilitiesJson ?? null);
		if (!node || !capabilities.includes('functions'))
			throw new ValidationError(
				`Node "${node?.name ?? nodeId}" does not support functions; update the node's agent first.`,
			);
		// A Python host loads Pyodide from the node's warmed cache, never from the internet (D121).
		if (python && !capabilities.includes(FUNCTIONS_PYTHON_CAPABILITY))
			throw new ValidationError(
				`Node "${node.name}" cannot run Python functions yet: its Pyodide cache is not installed. Run \`sudo bun /opt/skiff/current/repo/scripts/install/pyodide.ts\` on the node (or upgrade it), then deploy again.`,
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
		const id = existing?.id ?? newId('wld_');
		const values = {
			orgId: project.orgId,
			projectId: project.id,
			deploymentId,
			nodeId: resolved.nodeId,
			runtime: storedWorkloadRuntime(resolved.spec.runtime),
			runtimeName: resolved.spec.runtime,
			status: 'pending' as const,
			specJson: JSON.stringify(resolved.spec),
			memoryMb: reservedMemoryMb(resolved.spec),
			cpus: Math.round(resolved.spec.cpus),
			// A function dials a socket named after its workload (phase 4), not after the project, so
			// recompute it once the row id exists. Every other tier keeps the project socket.
			upstream: resolved.spec.runtime === 'function' ? upstreamFor(id, resolved.spec) : resolved.upstream,
			message: null,
			updatedAt: now,
		};
		if (existing) this.ctx.db.update(workloads).set(values).where(eq(workloads.id, existing.id)).run();
		else
			this.ctx.db
				.insert(workloads)
				.values({ ...values, id, createdAt: now })
				.run();
		if (resolved.replicas) {
			this.ctx.db.delete(workloadReplicas).where(eq(workloadReplicas.workloadId, id)).run();
			for (const replica of resolved.replicas)
				this.ctx.db
					.insert(workloadReplicas)
					.values({
						id: newId('wrl_'),
						workloadId: id,
						projectId: project.id,
						nodeId: replica.nodeId,
						replicaIndex: replica.index,
						status: 'pending',
						placementReason: replica.reason,
						createdAt: now,
						updatedAt: now,
					})
					.run();
		}
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
		const reservedCpu = this.reservedCpuByNode();
		const databaseCounts = this.ctx.databases.countByNode();
		const storageCounts = this.ctx.storage.countByNode();
		const brokerCounts = this.ctx.brokers.countByNode();
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
						(storageCounts.get(node.id) ?? 0) +
						(brokerCounts.get(node.id) ?? 0),
					diskFreeBytes: nodeDiskFreeBytes(stats),
					diskTotalBytes:
						typeof total === 'number' && Number.isFinite(total) ? Math.max(0, Math.floor(total)) : null,
					reservedDiskBytes: reservedDisk.get(node.id) ?? 0,
				};
			});
	}

	/** Desired state for one node, including only public spec fields and secret references. */
	desiredForNode(nodeId: string): WorkloadDesired[] {
		const replicaRows = this.ctx.db
			.select()
			.from(workloadReplicas)
			.where(eq(workloadReplicas.nodeId, nodeId))
			.all();
		const replicaWorkloadIds = [...new Set(replicaRows.map((row) => row.workloadId))];
		const rows = this.ctx.db
			.select({ workload: workloads, project: projects, deployment: deployments })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.innerJoin(deployments, eq(deployments.id, workloads.deploymentId))
			.where(
				and(
					or(eq(workloads.nodeId, nodeId), replicaWorkloadIds.length > 0 ? inArray(workloads.id, replicaWorkloadIds) : sql`0`),
					isNull(projects.deletedAt),
					eq(deployments.status, 'active'),
				),
			)
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
				runtime: spec.runtime,
				// Desired, not observed. The row's status is the agent's last report; echoing a
				// reported `stopped` back (an idle-stopped function, a crashed unit) makes the agent
				// remove the units, so the socket stops listening and the app never cold-starts again.
				status: quiesced.has(project.id) ? 'stopped' : 'running',
				release: release?.sha256 ?? null,
				...(spec.command ? { command: spec.command } : {}),
				...(spec.image ? { image: spec.image } : {}),
				// A function owns a socket per replica (phase 4). Replica 0 keeps the workload id, so
				// a single-host function dials `<workload-id>.sock`, matching the helper's socket unit.
				upstream:
					spec.runtime === 'function'
						? upstreamFor(workload.id, spec)
						: (workload.upstream ?? upstreamFor(project.id, spec)),
				// The row holds the whole reservation (D90); each unit is capped at one replica's share.
				memoryMb: spec.memoryMb,
				cpus: workload.cpus,
				port: spec.port,
				healthPath: spec.healthPath,
				socketActivation: worker ? false : spec.socketActivation,
				// Scale to zero for process apps (D121); only sent when it applies, so every other
				// workload's desired state is byte-for-byte what it was.
				...(spec.idleStopSeconds && processIdleStopIssue(spec) === null
					? { idleStopSeconds: spec.idleStopSeconds }
					: {}),
				activationVersion: activationVersion(spec, this.attachmentsVersion(project.id, workload.nodeId, spec.runtime, project.orgId, spec)),
				env: spec.env,
				secrets: spec.secrets,
				dataSizeMb: spec.data?.sizeMb ?? null,
				...(volumes.length > 0 ? { volumes } : {}),
				...(worker ? { ingress: 'none' as const } : {}),
				...(spec.runner ? { runner: { provider: 'github' as const } } : {}),
				...(spec.function ? { function: spec.function } : {}),
			};
			// A spread workload carries only the copies assigned to this node (C4).
			const assigned = replicaRows.filter((row) => row.workloadId === workload.id);
			if (assigned.length > 0) {
				return assigned.map((row) => {
					const id = workloadReplicaId(workload.id, row.replicaIndex);
					return {
						...base,
						id,
						...(spec.runtime === 'function' ? { upstream: upstreamFor(id, spec) } : {}),
						replica: { index: row.replicaIndex },
					};
				});
			}
			// Plain single-copy workloads keep exactly the desired state they had before plan 21.
			if (spec.replicas === 1 && !spec.runner) return [base];
			return Array.from({ length: spec.replicas }, (_, index) => {
				const id = workloadReplicaId(workload.id, index);
				return {
					...base,
					id,
					// Each replica gets its own socket and therefore its own workerd host.
					...(spec.runtime === 'function' ? { upstream: upstreamFor(id, spec) } : {}),
					replica: { index },
				};
			});
		});
	}

	/** Move replicas off offline/draining nodes onto healthy workers (C4). */
	rebalanceReplicas(): number {
		if (!featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS')) return 0;
		const rows = this.ctx.db.select().from(workloadReplicas).all();
		if (rows.length === 0) return 0;
		const statuses = new Map(this.ctx.db.select().from(nodes).all().map((node) => [node.id, node.status]));
		const byWorkload = new Map<string, typeof rows>();
		for (const row of rows) {
			const list = byWorkload.get(row.workloadId) ?? [];
			list.push(row);
			byWorkload.set(row.workloadId, list);
		}
		let moved = 0;
		for (const [workloadId, copies] of byWorkload) {
			const bad = copies.filter((row) => statuses.get(row.nodeId) !== 'online');
			if (bad.length === 0) continue;
			const workload = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
			if (!workload) continue;
			const project = this.requireProject(workload.projectId);
			const spec = this.specOf(project, workload);
			const keep = new Set(copies.filter((row) => !bad.includes(row)).map((row) => row.nodeId));
			const candidates = this.candidates()
				.filter((candidate) => candidate.status === 'online' && candidate.mode !== 'edge' && !keep.has(candidate.id))
				.map((candidate) => ({
					id: candidate.id,
					name: candidate.name,
					zone: candidate.zone ?? 'default',
					status: candidate.status,
					freeMemoryMb: candidate.sliceMemoryMb - candidate.reservedMemoryMb,
				}));
			const planned = planReplicas({
				count: bad.length,
				memoryMb: spec.memoryMb,
				spread: this.ctx.cluster.get().replicas.spread,
				candidates,
			});
			if (!planned.ok) continue;
			const now = this.ctx.now();
			planned.plan.assignments.forEach((assignment, index) => {
				const row = bad[index];
				if (!row) return;
				this.ctx.db
					.update(workloadReplicas)
					.set({
						nodeId: assignment.nodeId,
						status: 'pending',
						placementReason: 'failover',
						updatedAt: now,
					})
					.where(eq(workloadReplicas.id, row.id))
					.run();
				if (row.replicaIndex === 0)
					this.ctx.db
						.update(workloads)
						.set({ nodeId: assignment.nodeId, status: 'pending', updatedAt: now })
						.where(eq(workloads.id, workloadId))
						.run();
				moved += 1;
			});
			this.ctx.projects.bump(project.orgId);
		}
		return moved;
	}

	/**
	 * Decrypted values for one workload. The node token must own the workload's node; the payload
	 * is never cached on disk by the agent.
	 */
	activation(nodeId: string, desiredId: string): WorkloadActivation {
		if (this.ctx.databases.isDatabaseId(desiredId)) return this.ctx.databases.activation(nodeId, desiredId);
		if (this.ctx.storage.isStorageId(desiredId)) return this.ctx.storage.activation(nodeId, desiredId);
		if (this.ctx.brokers.isBrokerId(desiredId)) return this.ctx.brokers.activation(nodeId, desiredId);
		const { workloadId, replica } = parseWorkloadReplicaId(desiredId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) throw new NotFoundError('Workload');
		if (row.nodeId !== nodeId) throw new CoreError('forbidden', 'This workload is placed on another node.', 403);
		const spec = this.specOf(this.requireProject(row.projectId), row);
		if (replica >= spec.replicas) throw new NotFoundError('Workload replica');
		// Attached database, storage and broker connection values sit under the spec's own env and secrets (D56, S4, D111).
		const env: Record<string, string> = {
			...this.ctx.email.consumerEnv(row.projectId),
			...this.ctx.brokers.consumerEnv(row.projectId, row.nodeId, spec.runtime),
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
			runtime: workloadRuntimeOf(row),
			status: row.status,
			memoryMb: row.memoryMb,
			cpus: row.cpus,
			// A function's socket follows the workload id (phase 4). Recomputed from the row id so a
			// row written before this change still reports the socket the helper now creates.
			upstream: (spec?.runtime === 'function' ? upstreamFor(row.id, spec) : null) ?? row.upstream,
			message: row.message,
			createdAt: new Date(row.createdAt).toISOString(),
			updatedAt: new Date(row.updatedAt).toISOString(),
		};
	}

	/**
	 * The node a project must run on because of its attached databases, private storage and
	 * brokers, or null when nothing pins it. Throws when they live on different nodes.
	 */
	attachmentNode(projectId: string): string | null {
		const nodeIds = [
			...new Set(
				[
					this.ctx.databases.requiredNode(projectId),
					this.ctx.storage.requiredNode(projectId),
					this.ctx.brokers.requiredNode(projectId),
				].filter((id): id is string => id !== null),
			),
		];
		if (nodeIds.length > 1)
			throw new ValidationError(
				'Attached databases, private storage and brokers live on different nodes; detach one, or make the storage public.',
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
			this.ctx.brokers.consumerVersion(projectId, nodeId, runtime),
			this.ctx.email.consumerVersion(projectId),
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

	/** Resolve a `near` reference to the node running that database or storage instance. */
	private nearNodeIds(reference: string): string[] {
		const database = this.ctx.sqlite
			.query<{ nodeId: string }, [string, string]>(
				'SELECT node_id AS nodeId FROM databases WHERE (id = ? OR name = ?) AND deleted_at IS NULL LIMIT 1',
			)
			.get(reference, reference);
		if (database) return [database.nodeId];
		const storage = this.ctx.sqlite
			.query<{ nodeId: string }, [string, string]>(
				'SELECT node_id AS nodeId FROM storage_instances WHERE (id = ? OR name = ?) AND deleted_at IS NULL LIMIT 1',
			)
			.get(reference, reference);
		return storage ? [storage.nodeId] : [];
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
		const reservedCpu = this.reservedCpuByNode();
		const volumes = this.ctx.db
			.select({
				nodeId: nodeVolumes.nodeId,
				id: nodeVolumes.id,
				class: nodeVolumes.class,
				classOverride: nodeVolumes.classOverride,
			})
			.from(nodeVolumes)
			.all();
		const volumeFacts = new Map<string, { classes: string[]; ids: string[] }>();
		for (const volume of volumes) {
			const fact = volumeFacts.get(volume.nodeId) ?? { classes: [], ids: [] };
			fact.classes.push(volume.classOverride ?? volume.class);
			fact.ids.push(volume.id);
			volumeFacts.set(volume.nodeId, fact);
		}
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((node) => {
				const facts = this.ctx.nodes.view(node);
				const volume = volumeFacts.get(node.id);
				return {
					id: node.id,
					name: node.name,
					mode: node.mode,
					status: node.status,
					sliceMemoryMb: node.sliceMemoryMb,
					reservedMemoryMb: reserved.get(node.id) ?? 0,
					diskFreeBytes: nodeDiskFreeBytes(parseJson<Record<string, unknown> | null>(node.statsJson, null)),
					reservedDiskBytes: reservedDisk.get(node.id) ?? 0,
					zone: facts.zone,
					roles: facts.roles,
					labels: facts.derivedLabels,
					volumeClasses: volume?.classes ?? [],
					volumeIds: volume?.ids ?? [],
					cpuBudgetMillis: facts.cpuBudgetMillis,
					reservedCpuMillis: reservedCpu.get(node.id) ?? 0,
				};
			});
	}

	/** CPU already reserved by workloads, databases and storage instances, in millis. */
	private reservedCpuByNode(): Map<string, number> {
		const reserved = new Map<string, number>();
		const add = (rows: Array<{ nodeId: string | null; total: number | null }>) => {
			for (const row of rows)
				if (row.nodeId) reserved.set(row.nodeId, (reserved.get(row.nodeId) ?? 0) + Math.round(row.total ?? 0));
		};
		add(
			this.ctx.sqlite
				.query<{ nodeId: string | null; total: number | null }, [string, string, string]>(
					`SELECT w.node_id AS nodeId, SUM(w.cpus * 1000) AS total FROM workloads w
					 JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
					 WHERE w.node_id IS NOT NULL AND w.status IN (?, ?, ?) GROUP BY w.node_id`,
				)
				.all('pending', 'starting', 'running'),
		);
		add(
			this.ctx.sqlite
				.query<{ nodeId: string | null; total: number | null }, []>(
					'SELECT node_id AS nodeId, SUM(cpus * 1000) AS total FROM databases WHERE deleted_at IS NULL GROUP BY node_id',
				)
				.all(),
		);
		add(
			this.ctx.sqlite
				.query<{ nodeId: string | null; total: number | null }, []>(
					'SELECT node_id AS nodeId, SUM(cpus * 1000) AS total FROM storage_instances WHERE deleted_at IS NULL GROUP BY node_id',
				)
				.all(),
		);
		return reserved;
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
		for (const [nodeId, total] of this.ctx.brokers.reservedByNode())
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

/**
 * The upstream Caddy proxies to on the workload's node. Socket activation is the default.
 *
 * `id` is the socket id: a function passes its desired-state id — the workload id for replica 0
 * and `<id>-r<n>` for the rest (phase 4, `workloadReplicaId`) — so every host has its own socket.
 * Processes and containers pass the project id, which is the socket the helper has always created.
 */
export function upstreamFor(id: string, spec: WorkloadSpec): string {
	// Workers have no route; the value is never dialled and marks the row in listings.
	if (spec.ingress === 'none') return 'none';
	// Functions are socket-activated like a process app (D110): workerd takes the listener.
	if ((spec.runtime === 'process' || spec.runtime === 'function') && spec.socketActivation)
		return `unix//run/skiff-workloads/${id}.sock`;
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
			// A binding or compatibility change must restart the host, so the function spec is part of
			// the activation hash (D110). Omitted for every other tier, keeping existing versions.
			...(spec.function ? { function: spec.function } : {}),
		}),
	);
}

/** Capabilities a node reported in its last heartbeat; empty for agents that predate them. */
function nodeCapabilities(json: string | null): string[] {
	const parsed = parseJson<unknown>(json, []);
	return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}

/** `storedRuntime` narrowed for a workload row, whose CHECK only allows process/container. */
function storedWorkloadRuntime(runtime: WorkloadRuntime): 'process' | 'container' {
	return storedRuntime(runtime) as 'process' | 'container';
}

function placementSpecFor(project: ProjectRow): import('@skiff/contracts').PlacementSpec | null {
	if (!project.placementJson) return null;
	try {
		const parsed = placementSpecSchema.safeParse(JSON.parse(project.placementJson));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
