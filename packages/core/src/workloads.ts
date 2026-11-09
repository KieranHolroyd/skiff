import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { deployments, nodes, projects, releases, workloadReplicas, workloads } from '@skiff/db';
import {
	githubRunnerSecretNames,
	githubRunnerTarget,
	orgNetworkName,
	parseWorkloadReplicaId,
	pinnedImageReference,
	processIdleStopIssue,
	functionIsPython,
	FUNCTIONS_PYTHON_CAPABILITY,
	BUN_DEFAULT_COMMAND,
	PROCESS_NODE_CAPABILITY,
	STORAGE_STS_CAPABILITY,
	WORKLOAD_IDENTITY_AUDIENCE,
	WORKLOAD_IDENTITY_CAPABILITY,
	WORKLOAD_IDENTITY_MOUNT_PATH,
	WORKLOAD_IDENTITY_TOKEN_ENV,
	WORKLOAD_IDENTITY_URL_ENV,
	workloadEnvIssues,
	workloadIdentityUrl,
	composeSpecSchema,
	type ComposeRoute,
	type ComposeSpec,
	type GithubRunnerPoolView,
	workloadReplicaId,
	workloadSpecSchema,
	placementSpecSchema,
	workloadVariablesSchema,
	type NodeCapacityView,
	type Principal,
	type WorkloadActivation,
	type WorkloadDesired,
	type WorkloadIdentityResponse,
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
import { workloadGetsIdentity } from './iam/workload-identity.ts';
import { parseJson, newId, sha256Hex } from './util.ts';
import { nodeDiskFreeBytes } from './app-volumes.ts';
import type { ProjectRow } from './projects.ts';

export type WorkloadRow = typeof workloads.$inferSelect;

/** One spread replica copy as the failover controller sees it (CLUSTERING §8.3). */
export interface ReplicaCopy {
	id: string;
	workloadId: string;
	projectId: string;
	orgId: string;
	projectSlug: string;
	nodeId: string;
	replicaIndex: number;
	status: string;
	/** HTTP copies move before workers (§8.3 step 3). */
	ingress: 'http' | 'none';
	updatedAt: number;
}

const ACTIVE_STATUSES: WorkloadStatus[] = ['pending', 'starting', 'running'];

/**
 * Loopback ports Skiff assigns to compose services (Caddy dials one per exposed service). The
 * range is deliberately above the managed-service ranges so a stack never steals a database,
 * broker or storage port. Ports are stable for a service until the stack changes.
 */
const COMPOSE_PORT_MIN = 30_000;
const COMPOSE_PORT_MAX = 39_999;

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
		if (runtime === 'compose')
			throw new ValidationError(
				`Project "${project.slug}" needs a docker-compose file before it can deploy.`,
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
		this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
		const runtime = effectiveRuntime(project);
		let spec = withEngineCommand(
			workloadSpecSchema.parse({
				...(this.projectSpec(project) ?? this.defaultSpec(project)),
				...input,
				runtime: runtime === 'static' ? (input?.runtime ?? 'process') : runtime,
			}),
		);
		if (runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process", "container", "function" or "compose" to run a workload.`,
			);
		if (runtime === 'function' && !featureEnabled(this.ctx.config, 'FUNCTIONS'))
			throw new ValidationError('Functions are not enabled on this platform (SKIFF_FEATURE_FUNCTIONS).');
		if (runtime === 'compose') {
			if (!featureEnabled(this.ctx.config, 'COMPOSE'))
				throw new ValidationError('Compose stacks are not enabled on this platform (SKIFF_FEATURE_COMPOSE).');
			if (!spec.compose) throw new ValidationError('A compose project needs a parsed compose spec.');
			// Admission is the whole stack: every service reserves its own memory and CPU share.
			spec = {
				...spec,
				memoryMb: composeMemoryMb(spec.compose),
				cpus: composeCpus(spec.compose),
				// Set after placement assigns the loopback ports; a stale stored value is replaced.
				port: spec.port,
				healthPath: primaryComposeRoute(spec.compose)?.healthPath ?? '/',
				// Services are containers; the helper rejects socket activation for a stack.
				socketActivation: false,
				// A stack with no exposed port is a worker: no route and no health probe.
				ingress: spec.compose.routes.length === 0 ? ('none' as const) : ('http' as const),
			};
		}
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
		if (spec.runtime === 'process' && spec.engine === 'node')
			for (const nodeId of new Set([decision.nodeId, ...(replicas ?? []).map((replica) => replica.nodeId)]))
				this.assertNodeEngineTarget(nodeId);
		if (spec.compose) spec = { ...spec, compose: this.assignComposePorts(project, spec.compose, decision.nodeId) };
		if (spec.compose) {
			const primary = primaryComposeRoute(spec.compose);
			spec = { ...spec, port: primary?.hostPort ?? spec.port, healthPath: primary?.healthPath ?? spec.healthPath };
		}
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

	/**
	 * Give every exposed compose service a stable loopback port on its node. Skiff assigns these
	 * (never the compose file): a host port is host-global, so two stacks on one node must not
	 * collide. An existing port is kept when it is still free, which keeps redeploys quiet.
	 */
	private assignComposePorts(project: ProjectRow, spec: ComposeSpec, nodeId: string): ComposeSpec {
		const used = new Set<number>();
		for (const row of this.ctx.db.select().from(workloads).where(eq(workloads.nodeId, nodeId)).all()) {
			if (row.projectId === project.id) continue;
			const other = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data;
			if (!other) continue;
			if (other.compose) {
				for (const route of other.compose.routes) if (route.hostPort) used.add(route.hostPort);
			} else if (other.runtime === 'container') used.add(other.port);
		}
		const next = { ...spec, routes: spec.routes.map((route) => ({ ...route })) };
		for (const route of next.routes) {
			let port = route.hostPort;
			if (!port || used.has(port)) {
				port = undefined;
				for (let candidate = COMPOSE_PORT_MIN; candidate <= COMPOSE_PORT_MAX; candidate++)
					if (!used.has(candidate)) {
						port = candidate;
						break;
					}
				if (port === undefined) throw new ValidationError('This node has no free ports left for compose services.');
			}
			route.hostPort = port;
			used.add(port);
		}
		return next;
	}

	/** Persist the project-level spec (validated); placement is still resolved at deploy time. */
	setSpec(principal: Principal, project: ProjectRow, input: WorkloadSpecInput): WorkloadView | null {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const runtime = effectiveRuntime(project);
		if (runtime === 'static')
			throw new ValidationError(
				`Project "${project.slug}" is static. Create it with runtime "process", "container", "function" or "compose" to run a workload.`,
			);
		if (runtime === 'compose' && !featureEnabled(this.ctx.config, 'COMPOSE'))
			throw new ValidationError('Compose stacks are not enabled on this platform (SKIFF_FEATURE_COMPOSE).');
		// The digest is Skiff's to set at deploy time (R1); an input never carries one.
		const { imageDigest: _ignored, ...specInput } = input as WorkloadSpecInput & { imageDigest?: string };
		let spec = workloadSpecSchema.parse({ ...specInput, runtime });
		if (spec.compose)
			spec = {
				...spec,
				memoryMb: composeMemoryMb(spec.compose),
				cpus: composeCpus(spec.compose),
				socketActivation: false,
			};
		this.assertEnvResolvable(project, spec);
		this.assertRunnerResolvable(project, spec);
		const existing = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		// The running workload keeps its pinned digest while the image is unchanged, so saving other
		// fields neither restarts it on a moved tag nor drops the pin. A new image runs by tag until
		// the next deploy pins it.
		const runningDigest = existing
			? workloadSpecSchema.safeParse(parseJson<unknown>(existing.specJson, null)).data
			: undefined;
		const liveSpec: WorkloadSpec =
			runningDigest?.imageDigest && runningDigest.image === spec.image
				? { ...spec, imageDigest: runningDigest.imageDigest }
				: spec;
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
					specJson: JSON.stringify(liveSpec),
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
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		const variables = workloadVariablesSchema.parse(input);
		// Adding a name needs `secret:create`, a new value for a live one `secret:update`; all are
		// checked before anything is written.
		for (const secret of variables.newSecrets) this.ctx.secrets.requireWrite(principal, { name: secret.name, projectId: project.id });
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
		const check = (name: string) => {
			const resolved = this.ctx.secrets.resolve(project.orgId, project.id, name);
			if (!resolved) issues.push(`Secret ${name} does not exist for this project or the organisation.`);
		};
		for (const ref of spec.secrets) {
			if (pending.has(ref.name) && ref.version === undefined) continue;
			const resolved = this.ctx.secrets.resolve(project.orgId, project.id, ref.name);
			if (!resolved) issues.push(`Secret ${ref.name} does not exist for this project or the organisation.`);
			else if (ref.version !== undefined && !resolved.versions.includes(ref.version))
				issues.push(`Secret ${ref.name} has no version ${ref.version}.`);
		}
		// Compose services name their own secrets; the value is shared at the project level.
		for (const service of spec.compose?.services ?? [])
			for (const name of service.secrets) if (!pending.has(name)) check(name);
		if (issues.length > 0) throw new ValidationError(issues.join(' '), issues);
	}

	/**
	 * A runner's GitHub credential is read by the control plane only, so it is not in
	 * `spec.secrets`; check it resolves here or the pool would fail at its first activation.
	 */
	private assertRunnerResolvable(project: ProjectRow, spec: WorkloadSpec): void {
		if (!spec.runner) return;
		if (spec.runner.auth.method === 'installation') {
			if (!this.ctx.githubApp.hasInstallationFor(project.orgId, spec.runner.owner))
				throw new ValidationError(
					`Skiff's GitHub App is not installed on ${spec.runner.owner} for this organisation. Install it from Settings → GitHub, or use a token.`,
				);
			return;
		}
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

	/**
	 * A Node.js process app runs on the node's pinned Node (D125), which the agent advertises as
	 * `process-node`. Refuse the deploy instead of crash-looping a unit with no `node` on its PATH.
	 */
	private assertNodeEngineTarget(nodeId: string): void {
		const node = this.ctx.db
			.select({ name: nodes.name, capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		if (node && nodeCapabilities(node.capabilitiesJson).includes(PROCESS_NODE_CAPABILITY)) return;
		throw new ValidationError(
			`Node "${node?.name ?? nodeId}" cannot run Node.js apps yet: its pinned Node.js is not installed. Run \`sudo bun /opt/skiff/current/repo/scripts/install/node.ts\` on the node (or upgrade it), then deploy again.`,
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
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
		return this.view(project);
	}

	remove(principal: Principal, project: ProjectRow): void {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
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
		if (!this.ctx.platformIam.canView(principal)) throw new CoreError('forbidden', 'Platform admin permission required.', 403);
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
		const identityNode = this.nodeHasCapability(nodeId, WORKLOAD_IDENTITY_CAPABILITY);
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
				// Node apps only (D125): every Bun workload's desired state stays byte-for-byte the same.
				...(spec.runtime === 'process' && spec.engine === 'node' ? { engine: 'node' as const } : {}),
				...(spec.image ? { image: desiredImage(spec) } : {}),
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
				socketActivation: worker || spec.runtime === 'compose' ? false : spec.socketActivation,
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
				// Compose services, volumes and routes. Host ports were assigned at deploy time.
				...(spec.compose ? { compose: spec.compose } : {}),
				// A marker only; the token arrives through activation. Old agents never see it.
				...(identityNode && workloadGetsIdentity(spec) ? { identity: true as const } : {}),
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

	/**
	 * Every spread replica copy, for the failover controller (docs/CLUSTERING.md §8.3). Empty when
	 * multi-node replicas are off, because then no copy has a node of its own to lose.
	 */
	replicaCopies(): ReplicaCopy[] {
		if (!featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS')) return [];
		const rows = this.ctx.db
			.select({ replica: workloadReplicas, workload: workloads, project: projects })
			.from(workloadReplicas)
			.innerJoin(workloads, eq(workloads.id, workloadReplicas.workloadId))
			.innerJoin(projects, eq(projects.id, workloadReplicas.projectId))
			.all();
		return rows.map(({ replica, workload, project }) => ({
			id: replica.id,
			workloadId: replica.workloadId,
			projectId: replica.projectId,
			orgId: project.orgId,
			projectSlug: project.slug,
			nodeId: replica.nodeId,
			replicaIndex: replica.replicaIndex,
			status: replica.status,
			ingress: this.specOf(project as ProjectRow, workload).ingress === 'none' ? 'none' : 'http',
			updatedAt: replica.updatedAt,
		}));
	}

	/**
	 * Admission for moving one copy (§8.2 steps 1–4): an online non-edge node with room, not one
	 * that already holds a copy of this workload (nor its zone under `spread: zone`), and not in
	 * `exclude` (the controller's flapping and rate-limit filter). Writes nothing.
	 */
	planReplicaMove(
		replicaId: string,
		exclude: ReadonlySet<string> = new Set(),
	): { ok: true; nodeId: string; nodeName: string } | { ok: false; message: string } {
		const row = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.id, replicaId)).get();
		if (!row) return { ok: false, message: 'The copy no longer exists.' };
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.id, row.workloadId)).get();
		if (!workload) return { ok: false, message: 'The workload no longer exists.' };
		const spec = this.specOf(this.requireProject(workload.projectId), workload);
		const siblings = this.ctx.db
			.select()
			.from(workloadReplicas)
			.where(eq(workloadReplicas.workloadId, row.workloadId))
			.all()
			.filter((other) => other.id !== row.id);
		const all = this.candidates();
		const zoneOf = new Map(all.map((candidate) => [candidate.id, candidate.zone ?? 'default']));
		const spread = this.ctx.cluster.get().replicas.spread;
		const keptNodes = new Set(siblings.map((other) => other.nodeId));
		const keptZones = new Set(siblings.map((other) => zoneOf.get(other.nodeId) ?? 'default'));
		const candidates = all
			.filter((candidate) => candidate.mode !== 'edge' && candidate.id !== row.nodeId && !exclude.has(candidate.id))
			.filter((candidate) => !keptNodes.has(candidate.id))
			.filter((candidate) => spread !== 'zone' || !keptZones.has(candidate.zone ?? 'default'))
			.map((candidate) => ({
				id: candidate.id,
				name: candidate.name,
				zone: candidate.zone ?? 'default',
				status: candidate.status,
				freeMemoryMb: candidate.sliceMemoryMb - candidate.reservedMemoryMb,
			}));
		if (candidates.length === 0)
			return { ok: false, message: 'placement_blocked: no other online node can take this copy.' };
		const planned = planReplicas({ count: 1, memoryMb: spec.memoryMb, spread, candidates });
		if (!planned.ok) return { ok: false, message: `placement_blocked: ${planned.message}` };
		const target = planned.plan.assignments[0]!;
		return { ok: true, nodeId: target.nodeId, nodeName: candidates.find((c) => c.id === target.nodeId)?.name ?? target.nodeId };
	}

	/**
	 * Re-place one copy (§8.3 step 6): the row keeps its index, records why it moved and goes
	 * `pending` until the new node reports it. Desired state for both nodes and the ingress
	 * upstreams follow from the bump. The caller (the failover controller) holds the lease.
	 */
	moveReplica(replicaId: string, nodeId: string, reason: 'failover' | 'drain'): void {
		const row = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.id, replicaId)).get();
		if (!row) throw new NotFoundError('Workload replica');
		const workload = this.ctx.db.select().from(workloads).where(eq(workloads.id, row.workloadId)).get();
		if (!workload) throw new NotFoundError('Workload');
		const now = this.ctx.now();
		this.ctx.db
			.update(workloadReplicas)
			.set({ nodeId, status: 'pending', placementReason: reason, updatedAt: now })
			.where(eq(workloadReplicas.id, row.id))
			.run();
		if (row.replicaIndex === 0)
			this.ctx.db
				.update(workloads)
				.set({ nodeId, status: 'pending', updatedAt: now })
				.where(eq(workloads.id, workload.id))
				.run();
		this.ctx.projects.bump(this.requireProject(workload.projectId).orgId);
	}

	/**
	 * Decrypted values for one workload. The node token must own the workload's node; the payload
	 * is never cached on disk by the agent.
	 */
	activation(nodeId: string, desiredId: string): WorkloadActivation {
		// Read replicas (`db_dbr_…`) carry the database prefix too, so route them first (C7).
		if (this.ctx.databaseReplicas.isReplicaWorkloadId(desiredId))
			return this.ctx.databaseReplicas.activation(nodeId, desiredId);
		if (this.ctx.databases.isDatabaseId(desiredId)) return this.ctx.databases.activation(nodeId, desiredId);
		if (this.ctx.storage.isStorageId(desiredId)) return this.ctx.storage.activation(nodeId, desiredId);
		if (this.ctx.brokers.isBrokerId(desiredId)) return this.ctx.brokers.activation(nodeId, desiredId);
		if (this.ctx.registry.isRegistryId(desiredId)) return this.ctx.registry.activation(nodeId, desiredId);
		const { workloadId, replica } = parseWorkloadReplicaId(desiredId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) throw new NotFoundError('Workload');
		this.assertWorkloadOnNode(row, workloadId, replica, nodeId);
		const spec = this.specOf(this.requireProject(row.projectId), row);
		if (replica >= spec.replicas) throw new NotFoundError('Workload replica');
		// Attached database, storage and broker connection values sit under the spec's own env and secrets (D56, S4, D111).
		const env: Record<string, string> = {
			...this.ctx.email.consumerEnv(row.projectId),
			...this.ctx.brokers.consumerEnv(row.projectId, row.nodeId, spec.runtime),
			...this.ctx.storage.consumerEnv(row.projectId, row.nodeId, spec.runtime),
			...this.ctx.databases.consumerEnv(row.projectId, row.nodeId, spec.runtime),
			...this.ctx.userPools.consumerEnv(row.projectId),
			...spec.env,
		};
		const files: Record<string, string> = {};
		// A compose service may name secrets the top-level workload does not; resolve the union.
		const secretNames = new Set(spec.secrets.map((ref) => ref.name));
		for (const service of spec.compose?.services ?? []) for (const name of service.secrets) secretNames.add(name);
		for (const ref of spec.secrets) {
			const value = this.ctx.secrets.getValue(row.orgId, ref.name, ref.version, row.projectId);
			if (!value) continue;
			if (ref.delivery === 'file') files[ref.name] = value.value;
			else env[ref.name] = value.value;
		}
		// Compose services declare names only (secrets are delivered as env for containers).
		for (const name of secretNames) {
			if (Object.hasOwn(env, name)) continue;
			const value = this.ctx.secrets.getValue(row.orgId, name, undefined, row.projectId);
			if (value) env[name] = value.value;
		}
		// Containers pull with the org's credential for the image's registry (R2), if it has one.
		const registryAuth =
			spec.runtime === 'container'
				? this.ctx.registryCredentials.authForImage(row.orgId, spec.image, desiredId)
				: spec.compose
					? [
							...new Map(
								spec.compose.services.flatMap((service) =>
									this.ctx.registryCredentials
										.authForImage(row.orgId, service.image, `${desiredId}--${service.name}`)
										.map((entry) => [`${entry.registry}:${entry.username}`, entry] as const),
								),
							).values(),
						]
					: [];
		return {
			workloadId: desiredId,
			activationVersion: activationVersion(spec, this.attachmentsVersion(row.projectId, row.nodeId, spec.runtime, row.orgId, spec)),
			env,
			files,
			...(registryAuth.length > 0 ? { registryAuth } : {}),
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
		if (spec.runner) {
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
		if (!workloadGetsIdentity(spec) || !this.nodeHasCapability(nodeId, WORKLOAD_IDENTITY_CAPABILITY))
			return activation;
		const identity = await this.ctx.workloadIdentity.activation(row.id, WORKLOAD_IDENTITY_AUDIENCE);
		// Identity is only for process and container workloads; compose returns before this.
		const identityUrl = workloadIdentityUrl(spec.runtime === 'process' ? 'process' : 'container');
		// Attached storage gets short-lived STS credentials when the node understands them. Any
		// failure keeps the sealed attachment key already present in `activation.env` (IAM.md §7.4).
		const storage = await this.ctx.storage.workloadConsumerEnv(
			{ kind: 'workload', userId: row.id, orgId: row.orgId, role: 'viewer', permissions: new Set() },
			row.projectId,
			row.nodeId,
			spec.runtime,
			{ sts: this.nodeHasCapability(nodeId, STORAGE_STS_CAPABILITY) },
		);
		return {
			...activation,
			env: {
				...activation.env,
				...storage.env,
				// Platform values win over the user's environment: the token file is the workload's,
				// and the metadata endpoint is how it refreshes it.
				[WORKLOAD_IDENTITY_TOKEN_ENV]: WORKLOAD_IDENTITY_MOUNT_PATH,
				...(identityUrl ? { [WORKLOAD_IDENTITY_URL_ENV]: identityUrl } : {}),
			},
			identity,
			...(storage.sts.length > 0 ? { storageSts: storage.sts } : {}),
		};
	}

	/**
	 * Mint a token for one workload on this node, for the agent's metadata endpoint. The node token
	 * has already proved which node is asking, and this checks the workload is placed there.
	 */
	async identityFor(
		nodeId: string,
		desiredId: string,
		audience: string = WORKLOAD_IDENTITY_AUDIENCE,
	): Promise<WorkloadIdentityResponse> {
		const { workloadId, replica } = parseWorkloadReplicaId(desiredId);
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.id, workloadId)).get();
		if (!row) throw new NotFoundError('Workload');
		this.assertWorkloadOnNode(row, workloadId, replica, nodeId);
		const project = this.requireProject(row.projectId);
		const spec = this.specOf(project, row);
		if (replica >= spec.replicas) throw new NotFoundError('Workload replica');
		if (!workloadGetsIdentity(spec) || !this.nodeHasCapability(nodeId, WORKLOAD_IDENTITY_CAPABILITY))
			throw new ValidationError('This workload does not use workload identity.');
		return this.ctx.workloadIdentity.response(row.id, audience);
	}

	/** A spread copy (C4) lives on its own node; a copy re-placed by failover keeps its index. */
	private assertWorkloadOnNode(
		row: WorkloadRow,
		workloadId: string,
		replica: number,
		nodeId: string,
	): void {
		if (row.nodeId === nodeId) return;
		const spreadCopy = this.ctx.db
			.select({ id: workloadReplicas.id })
			.from(workloadReplicas)
			.where(
				and(
					eq(workloadReplicas.workloadId, workloadId),
					eq(workloadReplicas.replicaIndex, replica),
					eq(workloadReplicas.nodeId, nodeId),
				),
			)
			.get();
		if (!spreadCopy) throw new CoreError('forbidden', 'This workload is placed on another node.', 403);
	}

	/** Does this node's agent advertise a capability? An agent that predates capabilities has none. */
	private nodeHasCapability(nodeId: string, capability: string): boolean {
		const row = this.ctx.db
			.select({ capabilitiesJson: nodes.capabilitiesJson })
			.from(nodes)
			.where(eq(nodes.id, nodeId))
			.get();
		return nodeCapabilities(row?.capabilitiesJson ?? null).includes(capability);
	}

	/** Apply the agent's actual-state report from a heartbeat. */
	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		this.applyReplicaReports(nodeId, reports);
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

	/**
	 * Per-copy status for spread replicas (C4): the failover controller completes a move when the
	 * copy reports `running` from its new node. Only rows placed on the reporting node change.
	 */
	private applyReplicaReports(nodeId: string, reports: Array<{ id: string; status: WorkloadStatus; restarts: number }>): void {
		if (!featureEnabled(this.ctx.config, 'MULTI_NODE_REPLICAS')) return;
		const rows = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.nodeId, nodeId)).all();
		if (rows.length === 0) return;
		const byCopy = new Map(rows.map((row) => [workloadReplicaId(row.workloadId, row.replicaIndex), row]));
		const now = this.ctx.now();
		for (const report of reports) {
			const row = byCopy.get(report.id);
			if (!row) continue;
			const status = report.status === 'running' && report.restarts >= 5 ? 'failed' : report.status;
			if (status === row.status) continue;
			this.ctx.db
				.update(workloadReplicas)
				.set({ status, updatedAt: now })
				.where(eq(workloadReplicas.id, row.id))
				.run();
		}
	}

	/** The runner pool as GitHub reports it, for the dashboard and `GET .../runners`. */
	async runnerPool(principal: Principal, project: ProjectRow): Promise<GithubRunnerPoolView | null> {
		this.ctx.iam.require(principal, 'deployment:read', { type: 'project', id: project.id });
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
			// Containers (R1): the image as configured and the digest the running deployment pinned.
			image: spec?.image ?? null,
			imageDigest: spec?.imageDigest ?? null,
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
			this.ctx.userPools.consumerVersion(projectId),
			this.ctx.email.consumerVersion(projectId),
			this.ctx.appVolumes.projectVersion(projectId),
			this.secretsVersion(orgId, projectId, spec),
			this.restartVersion(projectId),
		]
			.filter(Boolean)
			.join(':');
	}

	/** A console restart (D127) bumps this; zero adds nothing, so existing hashes stay put. */
	private restartVersion(projectId: string): string {
		const generation =
			this.ctx.db
				.select({ generation: workloads.restartGeneration })
				.from(workloads)
				.where(eq(workloads.projectId, projectId))
				.get()?.generation ?? 0;
		return generation > 0 ? `restart:${generation}` : '';
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
		// Disk tiers (plus `remote`) answer the `volumeClass` / `volumeId` placement constraints (D169).
		const volumeFacts = this.ctx.disks.placementFacts();
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
	// A compose stack's primary route is the project's own host; other routes carry their own
	// loopback port in the desired-state route list.
	if (spec.runtime === 'compose') {
		const route = spec.compose ? primaryComposeRoute(spec.compose) : null;
		return `127.0.0.1:${route?.hostPort ?? spec.port}`;
	}
	// Functions are socket-activated like a process app (D110): workerd takes the listener.
	if ((spec.runtime === 'process' || spec.runtime === 'function') && spec.socketActivation)
		return `unix//run/skiff-workloads/${id}.sock`;
	return `127.0.0.1:${spec.port}`;
}

/** The route the project's own host serves (the first one when the file marked none). */
/** The route the project's own host serves; null for a fully private stack. */
export function primaryComposeRoute(spec: Pick<ComposeSpec, 'routes'>): ComposeRoute | null {
	return spec.routes.find((route) => route.primary) ?? spec.routes[0] ?? null;
}

/** Whole-stack admission: every service reserves its own memory. */
export function composeMemoryMb(spec: Pick<ComposeSpec, 'services'>): number {
	return spec.services.reduce((total, service) => total + service.memoryMb, 0);
}

/** Whole-stack CPU reservation, rounded like a single workload's. */
export function composeCpus(spec: Pick<ComposeSpec, 'services'>): number {
	return spec.services.reduce((total, service) => total + service.cpus, 0);
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
			// Only pinned deployments carry it (R1), so every existing workload keeps its version.
			...(spec.imageDigest ? { imageDigest: spec.imageDigest } : {}),
			port: spec.port,
			...(databases ? { databases } : {}),
			// Only present when set, so existing workloads keep their version (no restart on upgrade).
			// `replicas` is left out on purpose: scaling adds or removes copies without restarting any.
			...(spec.ingress === 'none' ? { ingress: 'none' } : {}),
			...(spec.runner ? { runner: spec.runner } : {}),
			// A binding or compatibility change must restart the host, so the function spec is part of
			// the activation hash (D110). Omitted for every other tier, keeping existing versions.
			...(spec.function ? { function: spec.function } : {}),
			// An override changes the service account the token names, so it must re-apply. The token
			// itself is never hashed: a refresh must not restart the workload.
			...(spec.identity ? { identity: spec.identity } : {}),
			// Services, images, commands and routes are the compose program; any change re-renders.
			...(spec.compose ? { compose: spec.compose } : {}),
		}),
	);
}

/**
 * The image reference a node runs: `<registry>/<repository>@<digest>` once a deploy pinned it (R1),
 * else the image as configured (local images, runners, deployments from before pinning).
 */
export function desiredImage(spec: Pick<WorkloadSpec, 'image' | 'imageDigest'>): string | undefined {
	if (!spec.image) return undefined;
	return spec.imageDigest ? pinnedImageReference(spec.image, spec.imageDigest) : spec.image;
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

/**
 * Clear the Bun default from a Node.js process app (D125), so the node runs its package.json
 * `start` script instead. A spec still carrying `bun run start` (the starting value of a new
 * process project, or one saved before the engine was switched) gets no command; any other
 * explicit command is the user's and is left alone.
 */
export function withEngineCommand(spec: WorkloadSpec): WorkloadSpec {
	if (spec.runtime !== 'process' || spec.engine !== 'node' || !spec.command) return spec;
	const bun = BUN_DEFAULT_COMMAND;
	const isBunDefault = spec.command.length === bun.length && spec.command.every((arg, index) => arg === bun[index]);
	if (!isBunDefault) return spec;
	const { command: _bun, ...rest } = spec;
	return rest as WorkloadSpec;
}
