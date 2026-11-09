import { eq } from 'drizzle-orm';
import { nodes, projects, workloadReplicas, workloads } from '@yoal/db';
import {
	CONTAINER_CONSOLE_CAPABILITY,
	CONTAINER_CONSOLE_DEFAULT_PORT,
	CONTAINER_CONSOLE_PROTOCOL_VERSION,
	CONTAINER_CONSOLE_TOKEN_TTL_MS,
	containerConsoleHost,
	parseWorkloadReplicaId,
	workloadReplicaId,
	workloadSpecSchema,
	type ContainerConsoleActivation,
	type ContainerConsoleScope,
	type ContainerTarget,
	type NodeContainerConsoleDesired,
	type Principal,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError } from './errors.ts';
import type { ProjectRow } from './projects.ts';
import { effectiveRuntime } from './runtime-tier.ts';
import { hmac, parseJson, safeEqual } from './util.ts';

/** What the control-plane proxy needs to reach one container through the gateway. */
export interface ContainerConsoleEndpoint {
	token: string;
	host: string;
	nodeId: string;
	desiredId: string;
	projectId: string;
	scopes: ContainerConsoleScope[];
	expiresAt: number;
}

interface TokenClaims {
	/** Desired workload id on the node. */
	w: string;
	n: string;
	o: string;
	p: string;
	u: string;
	s: ContainerConsoleScope[];
	e: number;
}

const SCOPE_PERMISSION = {
	inspect: 'container:inspect',
	files: 'container:files',
	exec: 'container:exec',
} as const;

/** Audit action names; listings and inspects are reads and stay out of the audit log. */
export type ContainerConsoleActivity =
	| { op: 'exec.open'; shell: string; user: string; replica: number | null }
	| { op: 'exec.close'; replica: number | null }
	| { op: 'files.read'; path: string; replica: number | null }
	| { op: 'files.download'; path: string; sizeBytes: number | null; replica: number | null };

/**
 * Container console (D127). The control plane decides who may inspect, read files in or open a
 * shell in which container, and mints a short-lived HMAC token naming exactly that container and
 * user. The token never reaches the browser: the proxy adds it on the gateway hop, and the node's
 * console front proves it by pulling `activation` with its node bearer. No session table: a token
 * expires in minutes and is minted again from the user's own (permission-checked) request.
 */
export class ContainerConsoleService {
	constructor(private readonly ctx: CoreContext) {}

	enabled(): boolean {
		return featureEnabled(this.ctx.config, 'CONTAINER_CONSOLE');
	}

	/** The containers a project runs, one per replica, with the node each one is on. */
	targets(principal: Principal, slug: string): ContainerTarget[] {
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'container:inspect', { type: 'project', id: project.id });
		return this.targetsOf(project);
	}

	/**
	 * Mint a console token for one container. Which surfaces may use a scope is `scopeAllowed`:
	 * MCP clients never get a shell (an agent could run something irreversible, D29).
	 */
	endpoint(
		principal: Principal,
		slug: string,
		scope: ContainerConsoleScope,
		replica: number | null = null,
	): ContainerConsoleEndpoint {
		this.requireEnabled();
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.iam.require(principal, SCOPE_PERMISSION[scope], { type: 'project', id: project.id });
		if (!scopeAllowed(principal, scope))
			throw new CoreError(
				'forbidden',
				'MCP clients cannot open container shells. Use the dashboard or `yoal container shell`.',
				403,
			);
		const targets = this.targetsOf(project);
		if (targets.length === 0) throw new ConflictError('This project has no running container yet. Deploy it first.');
		const target = replica === null ? targets[0]! : targets.find((item) => item.replica === replica);
		if (!target) throw new NotFoundError('Container replica');
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, target.nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		if (!capabilities(node.capabilitiesJson).includes(CONTAINER_CONSOLE_CAPABILITY))
			throw new ConflictError(`Node ${node.name} runs an agent without the container console. Update the node first.`);

		// Every scope the caller holds rides along, so one token serves a page's calls.
		const scopes = (Object.keys(SCOPE_PERMISSION) as ContainerConsoleScope[]).filter(
			(item) => principal.permissions.has(SCOPE_PERMISSION[item]) && scopeAllowed(principal, item),
		);
		const expiresAt = this.ctx.now() + CONTAINER_CONSOLE_TOKEN_TTL_MS;
		const claims: TokenClaims = {
			w: target.desiredId,
			n: target.nodeId,
			o: project.orgId,
			p: project.id,
			u: principal.userId,
			s: scopes,
			e: expiresAt,
		};
		return {
			token: this.sign(claims),
			host: containerConsoleHost(target.nodeId),
			nodeId: target.nodeId,
			desiredId: target.desiredId,
			projectId: project.id,
			scopes,
			expiresAt,
		};
	}

	/**
	 * Node-authenticated activation (`GET /api/agent/container-console`). Answers only for a valid,
	 * unexpired token naming a container that is still placed on the calling node.
	 */
	activation(nodeId: string, token: string): ContainerConsoleActivation {
		const claims = this.verify(token);
		if (!claims) throw new CoreError('forbidden', 'The console token does not verify.', 403);
		if (claims.n !== nodeId) throw new CoreError('forbidden', 'This console token is for another node.', 403);
		if (claims.e <= this.ctx.now()) throw new CoreError('forbidden', 'The console token has expired.', 403);
		if (!this.enabled()) throw new ConflictError('The container console is disabled on this control plane.');
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, claims.p)).get() as ProjectRow | undefined;
		if (!project || project.deletedAt || project.orgId !== claims.o) throw new NotFoundError('Project');
		const target = this.targetsOf(project).find((item) => item.desiredId === claims.w);
		if (!target || target.nodeId !== nodeId)
			throw new ConflictError('That container is no longer placed on this node.');
		return {
			v: CONTAINER_CONSOLE_PROTOCOL_VERSION,
			workloadId: claims.w,
			projectId: claims.p,
			userId: claims.u,
			scopes: claims.s,
			expiresAt: new Date(claims.e).toISOString(),
		};
	}

	/** Run the console front on nodes whose agent can, while the feature is on. */
	desiredForNode(node: { capabilitiesJson: string | null }): NodeContainerConsoleDesired | null {
		if (!this.enabled()) return null;
		if (!capabilities(node.capabilitiesJson).includes(CONTAINER_CONSOLE_CAPABILITY)) return null;
		return { port: this.port() };
	}

	/**
	 * One gateway route per node that runs a project container, mirroring the studio's (D96): a
	 * node serves its own front on loopback, the edge proxies the rest to the node's address.
	 */
	gatewayRoutes(
		nodeId: string,
		isEdge: boolean,
		publicAddressOf: (nodeId: string) => string | null,
	): Array<{ host: string; upstream: string }> {
		if (!this.enabled()) return [];
		const targets = new Set<string>();
		for (const row of this.ctx.db
			.select({ nodeId: workloads.nodeId, runtime: workloads.runtime, runtimeName: workloads.runtimeName, id: workloads.id })
			.from(workloads)
			.all()) {
			if (effectiveRuntime(row) !== 'container') continue;
			if (row.nodeId) targets.add(row.nodeId);
			for (const replica of this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.workloadId, row.id)).all())
				targets.add(replica.nodeId);
		}
		const routes: Array<{ host: string; upstream: string }> = [];
		for (const target of targets) {
			const host = containerConsoleHost(target);
			if (target === nodeId) routes.push({ host, upstream: `127.0.0.1:${this.port()}` });
			else if (isEdge) routes.push({ host, upstream: `http://${publicAddressOf(target) ?? '127.0.0.1:1'}` });
		}
		return routes.sort((a, b) => a.host.localeCompare(b.host));
	}

	/** Audit a shell or file read. Paths are recorded; file contents and keystrokes never are. */
	record(principal: Principal, slug: string, activity: ContainerConsoleActivity, result: 'ok' | 'error' = 'ok', error?: string): void {
		const project = this.ctx.projects.requireRow(principal, slug);
		const { op, ...args } = activity;
		this.ctx.audit.record({
			principal,
			action: `container.${op}`,
			resource: 'project',
			resourceId: project.id,
			args: { slug, ...args, ...('path' in args ? { path: String(args.path).slice(0, 500) } : {}) },
			result,
			...(error ? { error: error.slice(0, 300) } : {}),
		});
	}

	/**
	 * Restart the container (and every replica) through desired state, as D87 restarts a
	 * database: the generation is folded into the activation version, so the agent re-applies the
	 * unit and systemd restarts it. Idempotent per request; needs `project:update`.
	 */
	restart(principal: Principal, slug: string): { generation: number } {
		const project = this.ctx.projects.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		if (effectiveRuntime(project) !== 'container')
			throw new ConflictError('Only container projects can be restarted from the console.');
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!row) throw new ConflictError('This project has no workload yet. Deploy it first.');
		const generation = (row.restartGeneration ?? 0) + 1;
		this.ctx.db
			.update(workloads)
			.set({ restartGeneration: generation, updatedAt: this.ctx.now() })
			.where(eq(workloads.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'container.restart',
			resource: 'project',
			resourceId: project.id,
			args: { slug, generation },
			result: 'ok',
		});
		this.ctx.projects.bump(project.orgId);
		return { generation };
	}

	// --- internals ---------------------------------------------------------------------------

	private targetsOf(project: ProjectRow): ContainerTarget[] {
		if (effectiveRuntime(project) !== 'container') return [];
		const row = this.ctx.db.select().from(workloads).where(eq(workloads.projectId, project.id)).get();
		if (!row || !row.nodeId) return [];
		const spec = workloadSpecSchema.safeParse(parseJson<unknown>(row.specJson, null)).data;
		const count = spec?.replicas ?? 1;
		const nodeName = (id: string) => this.ctx.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, id)).get()?.name ?? id;
		const spread = this.ctx.db.select().from(workloadReplicas).where(eq(workloadReplicas.workloadId, row.id)).all();
		if (spread.length > 0)
			return spread
				.sort((a, b) => a.replicaIndex - b.replicaIndex)
				.map((replica) => ({
					replica: replica.replicaIndex,
					nodeId: replica.nodeId,
					nodeName: nodeName(replica.nodeId),
					desiredId: workloadReplicaId(row.id, replica.replicaIndex),
				}));
		// Plain single-copy workloads keep the bare id on the node (see WorkloadService.desiredForNode).
		if (count === 1 && !spec?.runner) return [{ replica: null, nodeId: row.nodeId, nodeName: nodeName(row.nodeId), desiredId: row.id }];
		return Array.from({ length: count }, (_, index) => ({
			replica: index,
			nodeId: row.nodeId!,
			nodeName: nodeName(row.nodeId!),
			desiredId: workloadReplicaId(row.id, index),
		}));
	}

	private requireEnabled(): void {
		if (!this.enabled()) throw new ConflictError('The container console is disabled on this control plane.');
	}

	private port(): number {
		return this.ctx.config.containerConsolePort ?? CONTAINER_CONSOLE_DEFAULT_PORT;
	}

	private sign(claims: TokenClaims): string {
		const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
		return `cc1.${payload}.${hmac(this.ctx.config.masterKey, `container-console:${payload}`)}`;
	}

	private verify(token: string): TokenClaims | null {
		const [version, payload, signature] = token.split('.');
		if (version !== 'cc1' || !payload || !signature || token.length > 2_048) return null;
		if (!safeEqual(hmac(this.ctx.config.masterKey, `container-console:${payload}`), signature)) return null;
		try {
			const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
			if (typeof claims.w !== 'string' || typeof claims.n !== 'string' || typeof claims.e !== 'number') return null;
			// The workload id must parse; anything else was never minted here.
			parseWorkloadReplicaId(claims.w);
			return claims;
		} catch {
			return null;
		}
	}
}

/**
 * Surfaces per scope (D127): inspect and files everywhere the permission is held; shells for
 * people and API keys (the CLI), never MCP clients. The permissions themselves are never default
 * agent scopes, so a key or token holds `container:files`/`container:exec` only by explicit grant.
 */
export function scopeAllowed(principal: Pick<Principal, 'credential'>, scope: ContainerConsoleScope): boolean {
	if (principal.credential === 'system') return false;
	if (scope === 'exec') return principal.credential === 'session' || principal.credential === 'apiKey';
	return true;
}

function capabilities(json: string | null): string[] {
	const parsed = parseJson<unknown>(json, []);
	return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}
