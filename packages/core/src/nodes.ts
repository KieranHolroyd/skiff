import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
	deployments,
	environments,
	nodeJoinTokens,
	nodes,
	projects,
	releases,
	slugRedirects,
	workloads,
	type nodes as nodesTable,
} from '@skiff/db';
import {
	canAdministerPlatform,
	canViewPlatform,
	contentUrl,
	type DesiredState,
	type Heartbeat,
	type Principal,
	type RouteSpec,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, UnauthorizedError } from './errors.ts';
import { siteKeyFor } from './config.ts';
import { newId, randomToken, sha256Hex, parseJson } from './util.ts';
import type { ParsedConfig } from '@skiff/site-config';

const JOIN_TTL_MS = 60 * 60 * 1000;
/** An agent is offline after 30 s without a heartbeat; alerts fire at 2 min (DESIGN §9). */
export const OFFLINE_AFTER_MS = 30_000;
export const ALERT_AFTER_MS = 120_000;

export interface UnhealthyNode {
	nodeId: string;
	name: string;
	reason: 'no_heartbeat' | 'caddy_down';
	/** Known for `no_heartbeat`; `caddy_down` nodes still heartbeat, so the caller tracks it. */
	offlineForMs: number | null;
}

export interface NodeView {
	id: string;
	name: string;
	mode: string;
	status: string;
	publicAddress: string | null;
	version: string | null;
	agentVersion: string | null;
	lastHeartbeatAt: string | null;
	stats: unknown;
	/** True when this node polls for git-build jobs (D3). */
	canBuild: boolean;
	createdAt: string;
}

/** Desired-state reconciliation for nodes (DESIGN §3.3, D23). Agents pull; the control plane never pushes. */
export class NodeService {
	constructor(private readonly ctx: CoreContext) {}

	view(row: typeof nodesTable.$inferSelect): NodeView {
		return {
			id: row.id,
			name: row.name,
			mode: row.mode,
			status: row.status,
			publicAddress: row.publicAddress,
			version: row.version,
			agentVersion: row.agentVersion,
			lastHeartbeatAt: row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).toISOString() : null,
			stats: parseJson(row.statsJson, null),
			canBuild: row.canBuild,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	/**
	 * Platform-admin only: nodes and Caddy are global (DESIGN §6.2). This is the admin plugin's
	 * `user.role`, never an org role, and mutations need the admin's own session (no API keys or
	 * OAuth tokens), so a scoped key can't mint node credentials.
	 */
	private assertPlatformAdmin(principal: Principal, access: 'read' | 'write' = 'write'): void {
		const allowed = access === 'read' ? canViewPlatform(principal) : canAdministerPlatform(principal);
		if (!allowed)
			throw new CoreError(
				'forbidden',
				principal.platformAdmin
					? 'Fleet changes need a platform admin signed in to the dashboard (not an API key or MCP token).'
					: 'Platform admin required.',
				403,
			);
	}

	list(principal: Principal): NodeView[] {
		this.assertPlatformAdmin(principal, 'read');
		return this.ctx.db
			.select()
			.from(nodes)
			.orderBy(desc(nodes.createdAt))
			.all()
			.map((row) => this.view(row));
	}

	get(nodeId: string): NodeView {
		const row = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!row) throw new NotFoundError('Node');
		return this.view(row);
	}

	/** Single-use join token, valid for one hour. Returned in clear exactly once. */
	createJoinToken(principal: Principal, nodeName?: string): { token: string; expiresAt: string } {
		this.assertPlatformAdmin(principal);
		const token = randomToken(32);
		const now = this.ctx.now();
		const expiresAt = now + JOIN_TTL_MS;
		this.ctx.db
			.insert(nodeJoinTokens)
			.values({
				id: newId('njt_'),
				tokenHash: sha256Hex(token),
				nodeName: nodeName ?? null,
				createdBy: principal.userId,
				expiresAt,
				createdAt: now,
			})
			.run();
		this.ctx.audit.record({
			principal,
			action: 'node.join_token',
			resource: 'node',
			args: { nodeName },
			result: 'ok',
		});
		return { token, expiresAt: new Date(expiresAt).toISOString() };
	}

	/**
	 * `skif agent join` consumes a one-time token and receives the node's long-lived token.
	 * The first node becomes the edge; later nodes are workers.
	 */
	join(input: { token: string; name: string; publicAddress?: string; version?: string }): {
		nodeId: string;
		token: string;
		controlUrl: string;
		mode: 'edge' | 'worker';
	} {
		const tokenHash = sha256Hex(input.token);
		const join = this.ctx.sqlite
			.query<{ id: string; expiresAt: number; usedAt: number | null }, [string]>(
				'SELECT id, expires_at AS expiresAt, used_at AS usedAt FROM node_join_tokens WHERE token_hash = ?',
			)
			.get(tokenHash);
		if (!join || join.usedAt || join.expiresAt < this.ctx.now())
			throw new UnauthorizedError('Invalid or expired join token.');
		const edgeCount = this.ctx.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM nodes WHERE mode = 'edge'").get();
		const mode: 'edge' | 'worker' = (edgeCount?.n ?? 0) === 0 ? 'edge' : 'worker';
		const nodeId = newId('nod_');
		const nodeToken = randomToken(32);
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(
				'INSERT INTO nodes (id, name, mode, status, public_address, version, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
				[
					nodeId,
					input.name,
					mode,
					'online',
					input.publicAddress ?? null,
					input.version ?? null,
					sha256Hex(nodeToken),
					now,
					now,
				],
			);
			this.ctx.sqlite.run('UPDATE node_join_tokens SET used_at = ?, used_by_node_id = ? WHERE id = ?', [now, nodeId, join.id]);
		})();
		this.ctx.audit.record({
			action: 'node.join',
			resource: 'node',
			resourceId: nodeId,
			args: { name: input.name, mode },
			result: 'ok',
		});
		this.bump();
		return { nodeId, token: nodeToken, controlUrl: this.ctx.config.platformOrigin, mode };
	}

	authenticate(token: string): typeof nodesTable.$inferSelect {
		const row = this.ctx.db.select().from(nodes).where(eq(nodes.tokenHash, sha256Hex(token))).get();
		if (!row) throw new UnauthorizedError('Unknown node token');
		return row;
	}

	heartbeat(token: string, input: Heartbeat): { ok: true; desiredStateVersion: number } {
		const node = this.authenticate(token);
		if (node.id !== input.nodeId) throw new UnauthorizedError('Node id does not match token');
		const now = this.ctx.now();
		this.ctx.db
			.update(nodes)
			.set({
				// Draining is an operator decision; the agent's liveness report must not undo it.
				status: node.status === 'draining' ? 'draining' : input.status,
				agentVersion: input.agentVersion,
				lastHeartbeatAt: now,
				statsJson: input.stats ? JSON.stringify(input.stats) : node.statsJson,
				updatedAt: now,
			})
			.where(eq(nodes.id, node.id))
			.run();
		if (input.workloads?.length) this.ctx.workloads.applyHeartbeat(node.id, input.workloads);
		return { ok: true, desiredStateVersion: this.stateVersion() };
	}

	/** Called by the maintenance sweep; returns nodes that just went offline. */
	markStale(): Array<{ nodeId: string; offlineForMs: number }> {
		const now = this.ctx.now();
		const stale = this.ctx.db
			.select()
			.from(nodes)
			.where(and(eq(nodes.status, 'online'), sql`coalesce(${nodes.lastHeartbeatAt}, 0) < ${now - OFFLINE_AFTER_MS}`))
			.all();
		for (const node of stale)
			this.ctx.db.update(nodes).set({ status: 'offline', updatedAt: now }).where(eq(nodes.id, node.id)).run();
		return stale.map((node) => ({ nodeId: node.id, offlineForMs: now - (node.lastHeartbeatAt ?? 0) }));
	}

	/**
	 * Every node that is currently unhealthy, for alerting (DESIGN §8: node offline > 2 min).
	 * `no_heartbeat` nodes carry how long they have been silent; `caddy_down` nodes still
	 * heartbeat but report that their proxy is not serving, so the caller tracks the duration.
	 */
	unhealthy(): UnhealthyNode[] {
		const now = this.ctx.now();
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.flatMap((node): UnhealthyNode[] => {
				const last = node.lastHeartbeatAt ?? node.createdAt;
				if (last < now - OFFLINE_AFTER_MS)
					return [{ nodeId: node.id, name: node.name, reason: 'no_heartbeat' as const, offlineForMs: now - last }];
				if (node.status === 'offline')
					return [{ nodeId: node.id, name: node.name, reason: 'caddy_down' as const, offlineForMs: null }];
				return [];
			});
	}

	setDraining(principal: Principal, nodeId: string, draining: boolean): NodeView {
		this.assertPlatformAdmin(principal);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		this.ctx.db
			.update(nodes)
			.set({ status: draining ? 'draining' : 'online', updatedAt: this.ctx.now() })
			.where(eq(nodes.id, nodeId))
			.run();
		this.bump();
		return this.view({ ...node, status: draining ? 'draining' : 'online' });
	}

	/** Mark a node as a git Builder (D3). Only a platform admin may change fleet-wide roles. */
	setBuilder(principal: Principal, nodeId: string, builder: boolean): NodeView {
		this.assertPlatformAdmin(principal);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		this.ctx.db
			.update(nodes)
			.set({ canBuild: builder, updatedAt: this.ctx.now() })
			.where(eq(nodes.id, nodeId))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'node.set_builder',
			resource: 'node',
			resourceId: nodeId,
			args: { builder },
			result: 'ok',
		});
		return this.view({ ...node, canBuild: builder });
	}

	rotateToken(principal: Principal, nodeId: string): { token: string } {
		this.assertPlatformAdmin(principal);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		const token = randomToken(32);
		this.ctx.db.update(nodes).set({ tokenHash: sha256Hex(token), updatedAt: this.ctx.now() }).where(eq(nodes.id, nodeId)).run();
		this.ctx.audit.record({ principal, action: 'node.rotate_token', resource: 'node', resourceId: nodeId, result: 'ok' });
		return { token };
	}

	stateVersion(): number {
		return this.ctx.projects.stateVersion();
	}

	bump(): void {
		this.ctx.projects.bump();
	}

	/**
	 * Everything this node must converge to: releases, production and preview routes, redirects,
	 * revocations. Built fresh on every pull and cached by the agent.
	 */
	async desiredState(token: string): Promise<DesiredState> {
		const node = this.authenticate(token);
		const now = this.ctx.now();
		const allNodes = this.ctx.db
			.select({ id: nodes.id, mode: nodes.mode, publicAddress: nodes.publicAddress, status: nodes.status })
			.from(nodes)
			.all();
		const edgeId = this.ctx.config.edgeNodeId ?? allNodes.find((row) => row.mode === 'edge')?.id ?? null;
		const isEdge = node.id === edgeId || node.mode === 'edge';
		const nodeById = new Map(allNodes.map((row) => [row.id, row]));

		const projectRows = this.ctx.db
			.select()
			.from(projects)
			.where(isNull(projects.deletedAt))
			.all()
			.filter((project) => {
				const target = project.placement === 'edge' || project.placement === 'auto' ? edgeId : project.placement;
				// Edge serves edge-placed projects locally and proxies worker-placed ones; a worker
				// only serves the projects placed on it.
				return isEdge || target === node.id;
			});

		const routes: RouteSpec[] = [];
		const releaseShas = new Set<string>();
		/** Route body per deployment, reused for that deployment's preview and environment routes. */
		const baseByDeployment = new Map<string, Omit<RouteSpec, 'host' | 'access' | 'accessMode'>>();
		const workloadByProject = new Map(
			this.ctx.db
				.select()
				.from(workloads)
				.where(eq(workloads.nodeId, node.id))
				.all()
				.map((row) => [row.projectId, row]),
		);

		for (const project of projectRows) {
			const target =
				project.placement === 'edge' || project.placement === 'auto' ? (edgeId ?? node.id) : project.placement;
			const local = target === node.id;
			const workload = workloadByProject.get(project.id);
			// Apps proxy to the workload on their node; the edge reaches a worker's Caddy over WireGuard.
			const upstream =
				project.runtime !== 'static' && local
					? (workload?.upstream ?? null)
					: local
						? null
						: `http://${nodeById.get(target)?.publicAddress ?? '127.0.0.1:1'}`;
			const rows = this.ctx.db
				.select()
				.from(deployments)
				.where(and(eq(deployments.projectId, project.id), eq(deployments.status, 'active')))
				.all();
			for (const deployment of rows) {
				const release = this.ctx.db.select().from(releases).where(eq(releases.id, deployment.releaseId)).get();
				if (!release) continue;
				if (local) releaseShas.add(release.sha256);
				const config = this.configFor(deployment.configSnapshotId);
				const base = {
					projectId: project.id,
					slug: project.slug,
					deploymentId: deployment.id,
					release: release.sha256,
					spa: config.config.spa,
					cleanUrls: config.config.cleanUrls,
					trailingSlash: config.config.trailingSlash,
					notFound: config.config.notFound,
					redirects: config.redirects,
					headers: config.headers,
					upstream,
				} satisfies Omit<RouteSpec, 'host' | 'access' | 'accessMode'>;
				baseByDeployment.set(deployment.id, base);

				// Every deployment always gets its immutable preview URL, whatever its environment.
				const previewAccessMode = project.previewAccess;
				routes.push({
					...base,
					host: deployment.previewHost,
					production: false,
					accessMode: previewAccessMode,
					access: {
						mode: previewAccessMode,
						siteKey: siteKeyFor(this.ctx.config.siteCookieSecret, project.id),
						loginUrl: `${this.ctx.config.platformOrigin}/_skiff/site-login?project=${project.id}`,
					},
				});
			}
		}

		// Every environment with a pointer gets its own production route at the environment host
		// (`<slug>.<domain>` for production, `<slug>--<env>.<domain>` otherwise, D13/D14). The v1
		// flow is the production-only case of this, so behaviour there is unchanged.
		const environmentRows =
			projectRows.length > 0
				? this.ctx.db
						.select()
						.from(environments)
						.where(inArray(environments.projectId, projectRows.map((project) => project.id)))
						.all()
				: [];
		const environmentsByProject = new Map<string, typeof environmentRows>();
		for (const row of environmentRows) {
			const list = environmentsByProject.get(row.projectId) ?? [];
			list.push(row);
			environmentsByProject.set(row.projectId, list);
		}
		const productionProjectIds = new Set<string>();
		for (const project of projectRows) {
			const rows = environmentsByProject.get(project.id) ?? [];
			const seen = new Set(rows.map((row) => row.slug));
			const candidates = [...rows];
			// A project predating the environments table (or one whose production row was never
			// materialised) still serves from the project pointer.
			if (!seen.has('production') && project.productionDeploymentId)
				candidates.push({
					id: `implicit_${project.id}`,
					orgId: project.orgId,
					projectId: project.id,
					name: 'Production',
					slug: 'production',
					isProduction: true,
					access: project.productionAccess,
					deploymentId: project.productionDeploymentId,
					createdAt: project.createdAt,
					updatedAt: project.updatedAt,
				});
			for (const environment of candidates) {
				const deploymentId =
					environment.isProduction && !environment.deploymentId
						? project.productionDeploymentId
						: environment.deploymentId;
				if (!deploymentId) continue;
				const base = baseByDeployment.get(deploymentId);
				if (!base) continue;
				const accessMode = environment.isProduction ? project.productionAccess : environment.access;
				routes.push({
					...base,
					host: this.ctx.environments.hostFor(project, environment),
					production: true,
					accessMode,
					access: {
						mode: accessMode,
						siteKey: siteKeyFor(this.ctx.config.siteCookieSecret, project.id),
						loginUrl: `${this.ctx.config.platformOrigin}/_skiff/site-login?project=${project.id}`,
					},
				});
				if (environment.isProduction) productionProjectIds.add(project.id);
			}
		}

		const releaseRows = this.ctx.db.select().from(releases).all().filter((row) => releaseShas.has(row.sha256));
		const releaseSpecs = await Promise.all(
			releaseRows.map(async (release) => ({
				sha256: release.sha256,
				sizeBytes: release.sizeBytes,
				fileCount: release.fileCount,
				precompressed: release.precompressed,
				url: await this.ctx.objectStore.presignGet(release.objectKey, 3600),
			})),
		);
		const productionUrl = (slug: string) =>
			contentUrl(this.ctx.config.platformOrigin, `${slug}.${this.ctx.config.contentDomain}`);

		const hostRedirects = this.ctx.db
			.select({ fromSlug: slugRedirects.fromSlug, projectId: slugRedirects.projectId })
			.from(slugRedirects)
			.where(sql`${slugRedirects.expiresAt} > ${now}`)
			.all()
			.flatMap((row) => {
				const target = projectRows.find((project) => project.id === row.projectId);
				return target
					? [
							{
								host: `${row.fromSlug}.${this.ctx.config.contentDomain}`,
								to: productionUrl(target.slug),
							},
						]
					: [];
			});

		const workloadRows = this.ctx.workloads.desiredForNode(node.id);
		// Custom domains always clone the production route (stream B), so only projects with a
		// production pointer are candidates; staging-only projects must not serve them.
		const servedProjectIds = productionProjectIds;

		return {
			version: this.stateVersion(),
			nodeId: node.id,
			agentVersion: this.ctx.config.desiredAgentVersion ?? '0.1.0',
			generatedAt: new Date(now).toISOString(),
			contentDomain: this.ctx.config.contentDomain,
			platformOrigin: this.ctx.config.platformOrigin,
			sliceMemoryMb: node.sliceMemoryMb,
			releases: releaseSpecs,
			routes,
			// Kept until every session a revocation affects has expired (share sessions last up to
			// 30 days), not for a fixed window.
			revocations: this.ctx.access.revocations(),
			hostRedirects,
			workloads: workloadRows,
			domains: this.ctx.domains.desiredForProjects(servedProjectIds),
		};
	}

	private configFor(snapshotId: string): ParsedConfig {
		const row = this.ctx.sqlite
			.query<{ site_config_json: string }, [string]>('SELECT site_config_json FROM config_snapshots WHERE id = ?')
			.get(snapshotId);
		return parseJson<ParsedConfig>(row?.site_config_json, {
			config: { spa: false, cleanUrls: false, trailingSlash: 'ignore', notFound: null },
			redirects: [],
			headers: [],
		});
	}
}
