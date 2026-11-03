import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
	deployments,
	nodeJoinTokens,
	nodes,
	projects,
	releases,
	shareLinks,
	shareRedemptions,
	slugRedirects,
	type nodes as nodesTable,
} from '@skiff/db';
import {
	limits,
	type DesiredState,
	type Heartbeat,
	type Principal,
	type RouteSpec,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { NotFoundError, UnauthorizedError } from './errors.ts';
import { siteKeyFor } from './config.ts';
import { newId, randomToken, sha256Hex, parseJson } from './util.ts';
import type { ParsedConfig } from '@skiff/site-config';

const JOIN_TTL_MS = 60 * 60 * 1000;
/** An agent is offline after 30 s without a heartbeat; alerts fire at 2 min (DESIGN §9). */
export const OFFLINE_AFTER_MS = 30_000;
export const ALERT_AFTER_MS = 120_000;

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
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	/** Platform-admin only: nodes and Caddy are global (DESIGN §6.2). */
	private assertPlatformAdmin(principal: Principal): void {
		if (principal.role !== 'owner' && principal.role !== 'admin')
			throw new UnauthorizedError('Platform admin required.');
	}

	list(principal: Principal): NodeView[] {
		this.assertPlatformAdmin(principal);
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
				status: input.status,
				agentVersion: input.agentVersion,
				lastHeartbeatAt: now,
				statsJson: input.stats ? JSON.stringify(input.stats) : node.statsJson,
				updatedAt: now,
			})
			.where(eq(nodes.id, node.id))
			.run();
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

		for (const project of projectRows) {
			const target =
				project.placement === 'edge' || project.placement === 'auto' ? (edgeId ?? node.id) : project.placement;
			const local = target === node.id;
			const upstream = local
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
				const isProduction = project.productionDeploymentId === deployment.id;
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

				// Every deployment always gets its immutable preview URL.
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

				if (isProduction) {
					const productionAccessMode = project.productionAccess;
					routes.push({
						...base,
						host: `${project.slug}.${this.ctx.config.contentDomain}`,
						accessMode: productionAccessMode,
						access: {
							mode: productionAccessMode,
							siteKey: siteKeyFor(this.ctx.config.siteCookieSecret, project.id),
							loginUrl: `${this.ctx.config.platformOrigin}/_skiff/site-login?project=${project.id}`,
						},
					});
				}
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

		const since = now - limits.redirectDays * 86_400_000;
		const revokedLinks = this.ctx.db
			.select({ id: shareLinks.id, revokedAt: shareLinks.revokedAt })
			.from(shareLinks)
			.where(and(sql`${shareLinks.revokedAt} IS NOT NULL`, sql`${shareLinks.revokedAt} > ${since}`))
			.all();
		const revokedSessions = this.ctx.db
			.select({ id: shareRedemptions.id, revokedAt: shareRedemptions.revokedAt })
			.from(shareRedemptions)
			.where(and(sql`${shareRedemptions.revokedAt} IS NOT NULL`, sql`${shareRedemptions.revokedAt} > ${since}`))
			.all();

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
								to: `https://${target.slug}.${this.ctx.config.contentDomain}`,
							},
						]
					: [];
			});

		return {
			version: this.stateVersion(),
			nodeId: node.id,
			agentVersion: this.ctx.config.desiredAgentVersion ?? '0.1.0',
			generatedAt: new Date(now).toISOString(),
			contentDomain: this.ctx.config.contentDomain,
			releases: releaseSpecs,
			routes,
			revocations: [
				...revokedLinks.flatMap((row) =>
					row.revokedAt
						? [{ id: row.id, kind: 'shareLink' as const, revokedAt: new Date(row.revokedAt).toISOString() }]
						: [],
				),
				...revokedSessions.flatMap((row) =>
					row.revokedAt
						? [{ id: row.id, kind: 'session' as const, revokedAt: new Date(row.revokedAt).toISOString() }]
						: [],
				),
			],
			hostRedirects,
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
