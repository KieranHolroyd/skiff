import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
	appVolumes,
	databaseStudioSessions,
	databases,
	deployments,
	environments,
	nodeJoinTokens,
	shareMounts,
	nodes,
	projects,
	releases,
	slugRedirects,
	storageInstances,
	serviceEndpoints,
	nodeCertificates,
	workloadReplicas,
	workloads,
	type nodes as nodesTable,
} from '@skiff/db';
import {
	compareSemver,
	contentUrl,
	parseSemver,
	nodeHardwareSchema,
	nodeLabelsSchema,
	nodeRoleSchema,
	nodeStorageStatusSchema,
	nodeUpdateSchema,
	nodeZoneSchema,
	workloadReplicaId,
	workloadSpecSchema,
	type DesiredState,
	type NodeHardware,
	type NodeNetworkMode,
	type ServiceEndpoint,
	type ServiceProvider,
	type NodeIdentityCertificate,
	type NodeRole,
	type WireguardState,
	DEFAULT_OVERLAY_CIDR,
	DEFAULT_WG_MTU,
	DEFAULT_WG_PORT,
	wireguardPublicKeySchema,
	wireguardStatusSchema,
	type WireguardStatus,
	type NodeStorage,
	type NodeStorageStatus,
	type Heartbeat,
	type NodeUpdate,
	type NodeUpdateTask,
	type Principal,
	type PlatformPermission,
	type RouteSpec,
	type WorkloadSpec,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, CoreError, NotFoundError, UnauthorizedError, ValidationError } from './errors.ts';
import { effectiveRuntime } from './runtime-tier.ts';
import { upstreamFor } from './workloads.ts';
import { allocateOverlayAddress, buildWireguardState, type OverlayNode } from './overlay.ts';
import { siteKeyFor } from './config.ts';
import { effectiveAccessMode } from './access.ts';
import { newId, randomToken, sha256Hex, parseJson } from './util.ts';
import type { ParsedConfig } from '@skiff/site-config';

const JOIN_TTL_MS = 60 * 60 * 1000;

/**
 * Where an unauthenticated visitor goes. Skiff Access has its own platform endpoint because it must
 * evaluate a policy and may redirect to an IdP or user pool before handing back a host-bound code.
 */
function loginUrlFor(platformOrigin: string, mode: string, projectId: string): string {
	return mode === 'access'
		? `${platformOrigin}/api/v1/access/authorize?project=${projectId}`
		: `${platformOrigin}/_skiff/site-login?project=${projectId}`;
}
/**
 * An agent is offline after 30 s without a heartbeat (DESIGN §9). The alert delay is a platform
 * policy (`nodeAlertMinutes`, Settings → Policies).
 */
export const OFFLINE_AFTER_MS = 30_000;

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
	/** True when this node's Builder may claim git-build jobs (D45, D47). */
	canBuild: boolean;
	/** `skiff-workloads.slice` memory budget, in MB (D42). */
	sliceMemoryMb: number;
	/** `skiff-workloads.slice` CPUWeight. */
	sliceCpuWeight: number;
	/** Requested storage locations (`null` = install default) and what the node last reported (D48). */
	storage: NodeStorage & { status: NodeStorageStatus | null };
	/** Failure domain (CLUSTERING §3.2). */
	zone: string;
	/** What the node may run; derived from mode/can_build when roles_json is null. */
	roles: NodeRole[];
	/** Operator labels. */
	labels: Record<string, string>;
	/** Operator labels plus derived `skiff.io/*` facts. */
	derivedLabels: Record<string, string>;
	/** Hardware facts plus the labels derived from them. */
	hardware: NodeHardware | null;
	hardwareAt: string | null;
	hardwareError: string | null;
	/** LAN address for direct peering inside one zone (C1). */
	lanEndpoint: string | null;
	/** CPU reservation budget in millis; null means no explicit cap. */
	cpuBudgetMillis: number | null;
	/** Managed overlay address (C1); null on external nodes. */
	privateAddress: string | null;
	networkMode: NodeNetworkMode;
	/** Public key only; the private key never leaves the node. */
	wgPublicKey: string | null;
	wgEndpoint: string | null;
	wgListenPort: number | null;
	wireguardStatus: WireguardStatus | null;
	wireguardStatusAt: string | null;
	certificateFingerprint: string | null;
	certificateExpiresAt: string | null;
	/** Capabilities from the last heartbeat (`nodeCapabilities`); empty for older agents. */
	capabilities: string[];
	/** Outstanding or failed dashboard update (D99); null when none. */
	update: NodeUpdateView | null;
	createdAt: string;
}

export interface NodeUpdateView {
	version: string;
	requestedAt: string | null;
	/** `pending` until the agent reports `version`; `failed` once the node reported an error. */
	status: 'pending' | 'failed';
	error: string | null;
}

/** A requested node update counts as stale (shown as "no response") after this long. */
export const NODE_UPDATE_STALE_MS = 15 * 60 * 1000;

/** Desired-state reconciliation for nodes (DESIGN §3.3, D23). Agents pull; the control plane never pushes. */
export class NodeService {
	constructor(private readonly ctx: CoreContext) {}

	view(row: typeof nodesTable.$inferSelect): NodeView {
		const hardware = hardwareFor(row.hardwareJson);
		const labels = labelsFor(row.labelsJson);
		const certificate = this.ctx.db.select().from(nodeCertificates).where(eq(nodeCertificates.nodeId, row.id)).get();
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
			sliceMemoryMb: row.sliceMemoryMb,
			sliceCpuWeight: row.sliceCpuWeight,
			storage: {
				dataDir: row.storageDataDir,
				buildDir: row.storageBuildDir,
				status: storageStatus(row.storageStatusJson),
			},
			zone: row.zone,
			roles: rolesFor(row),
			labels,
			derivedLabels: { ...labels, ...derivedLabelsFor(hardware) },
			hardware,
			hardwareAt: row.hardwareAt ? new Date(row.hardwareAt).toISOString() : null,
			hardwareError: row.hardwareError,
			lanEndpoint: row.lanEndpoint,
			cpuBudgetMillis: row.cpuBudgetMillis,
			privateAddress: row.privateAddress,
			networkMode: row.networkMode,
			wgPublicKey: row.wgPublicKey,
			wgEndpoint: row.wgEndpoint,
			wgListenPort: row.wgListenPort,
			wireguardStatus: wireguardStatusFor(row.wgStatusJson),
			wireguardStatusAt: row.wgStatusAt ? new Date(row.wgStatusAt).toISOString() : null,
			certificateFingerprint: certificate?.serial ?? null,
			certificateExpiresAt: certificate ? new Date(certificate.expiresAt).toISOString() : null,
			capabilities: capabilities(row.capabilitiesJson),
			update: row.updateVersion
				? {
						version: row.updateVersion,
						requestedAt: row.updateRequestedAt ? new Date(row.updateRequestedAt).toISOString() : null,
						status: row.updateFailedGeneration >= row.updateGeneration ? 'failed' : 'pending',
						error: row.updateError,
					}
				: null,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	/**
	 * Ask a node to install the control plane's own signed release (D99). This only records desired
	 * state: the agent picks it up on its next pull and hands the version to the helper's fixed
	 * `node/update` verb, which verifies the release signature before it replaces anything. Asking
	 * again after a failure is a retry (a new generation).
	 */
	requestUpdate(principal: Principal, nodeId: string): NodeView {
		this.assertPlatformAdmin(principal, 'platform:updates');
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		const target = parseSemver(this.ctx.config.desiredAgentVersion)?.version;
		if (!target)
			throw new ConflictError(
				`The control plane's version (${this.ctx.config.desiredAgentVersion ?? 'unknown'}) is not a release version, so there is no signed release to install.`,
			);
		const running = parseSemver(node.agentVersion);
		if (running && compareSemver(running, target) >= 0)
			throw new ConflictError(`"${node.name}" already runs ${running.version}.`);
		if (!capabilities(node.capabilitiesJson).includes('node-update'))
			throw new ConflictError(
				`"${node.name}" runs an agent (${node.agentVersion ?? 'unknown version'}) that cannot update itself yet. Update it by hand once (docs/OPS.md "Updating worker nodes"); later updates work from here.`,
			);
		const now = this.ctx.now();
		const generation = node.updateGeneration + 1;
		this.ctx.db
			.update(nodes)
			.set({
				updateVersion: target,
				updateGeneration: generation,
				updateRequestedAt: now,
				updateError: null,
				updatedAt: now,
			})
			.where(eq(nodes.id, nodeId))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'node.update_agent',
			resource: 'node',
			resourceId: nodeId,
			args: { from: node.agentVersion, to: target, generation },
			result: 'ok',
		});
		this.bump();
		return this.view({
			...node,
			updateVersion: target,
			updateGeneration: generation,
			updateRequestedAt: now,
			updateError: null,
			updatedAt: now,
		});
	}

	/** The update this node should run now, or null (none requested, done, or already failed). */
	private updateTaskFor(node: typeof nodesTable.$inferSelect): NodeUpdateTask | null {
		if (!node.updateVersion || node.updateFailedGeneration >= node.updateGeneration) return null;
		return {
			generation: node.updateGeneration,
			version: node.updateVersion,
			repo: this.ctx.config.releaseRepo ?? 'KieranHolroyd/skiff',
		};
	}

	/**
	 * Settle an outstanding update from a heartbeat: the reported version proves success; a failure
	 * report for the current generation stops the task until an operator retries.
	 */
	private settleUpdate(
		node: typeof nodesTable.$inferSelect,
		agentVersion: string,
		result: Heartbeat['nodeUpdateResult'],
	): Partial<typeof nodesTable.$inferInsert> {
		if (!node.updateVersion) return {};
		const running = parseSemver(agentVersion);
		if (running && compareSemver(running, node.updateVersion) >= 0) {
			this.ctx.audit.record({
				action: 'node.update_agent.done',
				resource: 'node',
				resourceId: node.id,
				args: { version: running.version, generation: node.updateGeneration },
				result: 'ok',
			});
			return { updateVersion: null, updateError: null, updateRequestedAt: null };
		}
		if (
			result &&
			result.generation === node.updateGeneration &&
			node.updateFailedGeneration < node.updateGeneration
		) {
			this.ctx.audit.record({
				action: 'node.update_agent.done',
				resource: 'node',
				resourceId: node.id,
				args: { version: node.updateVersion, generation: result.generation },
				result: 'error',
				error: result.error,
			});
			return { updateFailedGeneration: result.generation, updateError: result.error };
		}
		return {};
	}

	/**
	 * Platform-only: nodes and Caddy are global (DESIGN §6.2). Platform IAM decides the
	 * `platform:*` permission (IAM.md I24); the service keeps the pre-I8 admin flag as the fallback
	 * until bindings are seeded, and D129's session-only rule for `platform-admin`.
	 */
	private assertPlatformAdmin(
		principal: Principal,
		permission: PlatformPermission = 'platform:nodes',
	): void {
		if (this.ctx.platformIam.allows(principal, permission)) return;
		throw new CoreError(
			'forbidden',
			principal.platformAdmin
				? 'Fleet changes need a platform admin role signed in to the dashboard (not an API key or MCP token).'
				: 'Platform admin permission required.',
			403,
		);
	}

	list(principal: Principal): NodeView[] {
		this.assertPlatformAdmin(principal, 'platform:read');
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
	join(input: {
		token: string;
		name: string;
		publicAddress?: string;
		version?: string;
		networkMode?: 'skiff' | 'external';
		wireguardPublicKey?: string;
	}): {
		nodeId: string;
		token: string;
		controlUrl: string;
		mode: 'edge' | 'worker';
		wireguard?: WireguardState;
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
		const managed = input.networkMode === 'skiff';
		if (managed) {
			const key = input.wireguardPublicKey;
			if (!key || !wireguardPublicKeySchema.safeParse(key).success)
				throw new ValidationError('A managed overlay join needs the node\'s WireGuard public key.');
		}
		const used = new Set(
			this.ctx.sqlite
				.query<{ address: string }, []>('SELECT private_address AS address FROM nodes WHERE private_address IS NOT NULL')
				.all()
				.map((row) => row.address),
		);
		const privateAddress = managed ? allocateOverlayAddress(this.ctx.cluster.get().overlay.cidr, used) : null;
		if (managed && !privateAddress)
			throw new ConflictError('The overlay CIDR has no free address. Widen it before adding another node.');
		const publicAddress = input.publicAddress ?? (managed && privateAddress ? `${privateAddress}:8080` : null);
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(
				`INSERT INTO nodes (
					id, name, mode, status, public_address, version, token_hash, created_at, updated_at,
					private_address, private_cidr, wg_public_key, network_mode, wg_endpoint, wg_listen_port
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					nodeId,
					input.name,
					mode,
					'online',
					publicAddress,
					input.version ?? null,
					sha256Hex(nodeToken),
					now,
					now,
					privateAddress,
					managed ? this.ctx.cluster.get().overlay.cidr : null,
					managed ? input.wireguardPublicKey ?? null : null,
					managed ? 'skiff' : 'external',
					managed ? input.publicAddress ?? null : null,
					managed ? this.ctx.cluster.get().overlay.listenPort : null,
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
		return {
			nodeId,
			token: nodeToken,
			controlUrl: this.ctx.config.platformOrigin,
			mode,
			...(managed
				? {
						wireguard: (() => {
							const cfg = this.ctx.cluster.get().overlay;
							return buildWireguardState(nodeId, this.overlayNodes(), cfg.cidr, cfg);
						})(),
					}
				: {}),
		};
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
		this.storeCertificate(node.id, input.nodeCertificate, now);
		this.ctx.db
			.update(nodes)
			.set({
				// Draining is an operator decision; the agent's liveness report must not undo it.
				status: node.status === 'draining' ? 'draining' : input.status,
				agentVersion: input.agentVersion,
				// An agent that predates capabilities declares none, so work it would ignore is refused.
				capabilitiesJson: JSON.stringify(input.capabilities ?? []),
				...hardwarePatch(input.hardware, now),
				...wireguardStatusPatch(input.wireguard, now),
				...this.settleUpdate(node, input.agentVersion, input.nodeUpdateResult),
				lastHeartbeatAt: now,
				statsJson: input.stats ? JSON.stringify(input.stats) : node.statsJson,
				storageStatusJson: input.storage ? JSON.stringify(input.storage) : node.storageStatusJson,
				updatedAt: now,
			})
			.where(eq(nodes.id, node.id))
			.run();
		if (input.workloads?.length) {
			this.ctx.workloads.applyHeartbeat(node.id, input.workloads);
			this.ctx.databases.applyHeartbeat(node.id, input.workloads);
			this.ctx.storage.applyHeartbeat(node.id, input.workloads);
			this.ctx.brokers.applyHeartbeat(node.id, input.workloads);
			this.ctx.registry.applyHeartbeat(node.id, input.workloads);
			this.ctx.databaseReplicas.applyWorkloadReports(node.id, input.workloads);
		}
		if (input.databaseReplication?.length)
			this.ctx.databaseReplicas.applyReplicationReports(node.id, input.databaseReplication);
		if (input.databaseReplicaPromotionResults?.length)
			this.ctx.databaseReplicas.applyPromotionResults(node.id, input.databaseReplicaPromotionResults);
		if (input.databaseBackupResults?.length)
			this.ctx.databases.applyBackupResults(node.id, input.databaseBackupResults);
		if (input.databasePitrResults?.length)
			this.ctx.databases.applyPitrResults(node.id, input.databasePitrResults);
		if (input.databaseRotationResults?.length)
			this.ctx.databases.applyRotationResults(node.id, input.databaseRotationResults);
		if (input.databaseCredentialResults?.length)
			this.ctx.databases.applyCredentialResults(node.id, input.databaseCredentialResults);
		if (input.databaseStudioPrincipalResults?.length)
			this.ctx.databaseStudio.principals.applyResults(node.id, input.databaseStudioPrincipalResults);
		if (input.databasePoolerRestarted?.length)
			this.ctx.databases.applyPoolerRestarted(node.id, input.databasePoolerRestarted);
		if (input.databaseTls?.length) this.ctx.databases.applyTlsReport(node.id, input.databaseTls);
		if (input.purgedDatabases?.length) {
			this.ctx.databases.applyPurged(node.id, input.purgedDatabases);
			this.ctx.moves.onPurged(node.id, input.purgedDatabases);
			this.ctx.databaseReplicas.applyPurged(node.id, input.purgedDatabases);
		}
		if (input.purgedStorage?.length) this.ctx.storage.applyPurged(node.id, input.purgedStorage);
		if (input.purgedBrokers?.length) this.ctx.brokers.applyPurged(node.id, input.purgedBrokers);
		if (input.appVolumeUsage?.length) this.ctx.appVolumes.lifecycle.applyUsage(node.id, input.appVolumeUsage);
		if (input.appVolumeTaskResults?.length)
			this.ctx.appVolumes.lifecycle.applyTaskResults(node.id, input.appVolumeTaskResults);
		if (input.purgedAppVolumes?.length) this.ctx.appVolumes.lifecycle.applyPurged(node.id, input.purgedAppVolumes);
		if (input.storageBucketDeletions?.length)
			this.ctx.storage.applyBucketDeletions(node.id, input.storageBucketDeletions);
		if (input.storageBucketConfigs?.length)
			this.ctx.storage.applyBucketConfigReports(node.id, input.storageBucketConfigs);
		if (input.storageRootKeys?.length) this.ctx.storage.applyRootKeyReports(node.id, input.storageRootKeys);
		if (input.storageReplication?.length)
			this.ctx.storageReplication.applyReports(node.id, input.storageReplication);
		// Disks first (capacity, missing mounts, Skiff mounts turning ready), then share mounts, which
		// register a mounted share as a disk once the inventory shows it (docs/STORAGE.md §3).
		if (input.volumes) this.ctx.disks.applyInventory(node.id, input.volumes);
		this.ctx.disks.applyMountReport(node.id, input.diskMounts, input.unmountedDisks);
		this.ctx.shares.applyNodeReport(node.id, input.shareMounts, input.unmountedShares);
		if (input.volumeProfileResults?.length) this.ctx.disks.applyProfileResults(node.id, input.volumeProfileResults);
		// Custom domains go `active` once an edge reports serving their certificate.
		if (input.stats?.certs?.length) {
			try {
				this.ctx.domains.applyServedCertificates(input.stats.certs);
			} catch (cause) {
				console.error('[nodes] could not apply certificate report:', cause);
			}
		}
		// A database move waits for its source to stop the attached apps before dumping (D97).
		this.ctx.moves.onHeartbeat(node.id, input.actualStateVersion, (input.workloads ?? []).map((item) => item.id));
		// A replica promotion waits for the old primary's node to stop it (C7, §9.3).
		this.ctx.databaseReplicas.onHeartbeat(node.id, input.actualStateVersion, (input.workloads ?? []).map((item) => item.id));
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
		this.assertPlatformAdmin(principal, 'platform:drain');
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

	/**
	 * Hand the edge role to another node (D98). The roles swap: the target terminates ingress and
	 * serves every static site, the old edge becomes a worker that keeps what was admitted to it.
	 * Everything follows from desired state, so both agents converge on their next pull. Outside
	 * Skiff the operator still points DNS at the new edge and gives it TLS settings; that is why the
	 * dashboard asks for a typed confirmation.
	 */
	setEdge(principal: Principal, nodeId: string): NodeView {
		this.assertPlatformAdmin(principal);
		if (this.ctx.config.edgeNodeId)
			throw new ConflictError(
				'SKIFF_EDGE_NODE_ID pins the edge in the control plane environment. Change it there and restart the control plane.',
			);
		const target = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!target) throw new NotFoundError('Node');
		if (target.mode === 'edge') throw new ConflictError(`"${target.name}" is already the edge node.`);
		if (target.status !== 'online')
			throw new ConflictError(`"${target.name}" is ${target.status}; only an online node can take over ingress.`);
		const previous = this.ctx.db.select().from(nodes).where(eq(nodes.mode, 'edge')).get();
		// The new edge proxies to whatever stays on the old one, so it needs an address to reach it.
		if (previous && !previous.publicAddress) {
			const blockers = this.removalBlockers(previous.id);
			if (blockers.length)
				throw new ConflictError(
					`"${previous.name}" still hosts ${blockers.join('; ')}, and has no address the new edge could proxy to. Give it one (Edit node) or move them first.`,
				);
		}

		const now = this.ctx.now();
		this.ctx.db.transaction(() => {
			if (previous)
				this.ctx.db.update(nodes).set({ mode: 'worker', updatedAt: now }).where(eq(nodes.id, previous.id)).run();
			this.ctx.db.update(nodes).set({ mode: 'edge', updatedAt: now }).where(eq(nodes.id, nodeId)).run();
		});
		this.ctx.audit.record({
			principal,
			action: 'node.set_edge',
			resource: 'node',
			resourceId: nodeId,
			args: { name: target.name, previous: previous ? { id: previous.id, name: previous.name } : null },
			result: 'ok',
		});
		this.bump();
		return this.view({ ...target, mode: 'edge', updatedAt: now });
	}

	/**
	 * Edit operator settings: name, the address the edge proxies to, the workload-slice budget and
	 * the Builder role. The slice budget cannot drop below what admitted workloads already reserve
	 * (D42), because the kernel limit would then OOM-kill workloads the control plane accepted.
	 * Every change is in desired state, so agents converge on their next pull.
	 */
	update(principal: Principal, nodeId: string, input: NodeUpdate): NodeView {
		this.assertPlatformAdmin(principal);
		const reservedLabel = Object.keys(input.labels ?? {}).find((key) => key.startsWith('skiff.io/'));
		if (reservedLabel)
			throw new ValidationError(
				`Label "${reservedLabel}" uses skiff.io/, which is reserved for derived hardware facts.`,
			);
		const parsed = nodeUpdateSchema.safeParse(input);
		if (!parsed.success)
			throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join('; '));
		const patch = parsed.data;
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');

		if (patch.sliceMemoryMb !== undefined && patch.sliceMemoryMb < node.sliceMemoryMb) {
			const reserved =
				this.ctx.workloads.capacityInternal().find((item) => item.nodeId === nodeId)?.reservedMemoryMb ?? 0;
			if (patch.sliceMemoryMb < reserved)
				throw new ValidationError(
					`Workloads on ${node.name} already reserve ${reserved} MB; the slice budget cannot be lower than that. Move or shrink workloads first.`,
				);
		}

		const changes: Partial<typeof nodesTable.$inferInsert> = {};
		if (patch.name !== undefined && patch.name !== node.name) changes.name = patch.name;
		if (patch.publicAddress !== undefined) {
			const address = patch.publicAddress || null;
			if (address !== node.publicAddress) changes.publicAddress = address;
		}
		if (patch.sliceMemoryMb !== undefined && patch.sliceMemoryMb !== node.sliceMemoryMb)
			changes.sliceMemoryMb = patch.sliceMemoryMb;
		if (patch.sliceCpuWeight !== undefined && patch.sliceCpuWeight !== node.sliceCpuWeight)
			changes.sliceCpuWeight = patch.sliceCpuWeight;
		if (patch.canBuild !== undefined && patch.canBuild !== node.canBuild) changes.canBuild = patch.canBuild;
		if (patch.zone !== undefined && patch.zone !== node.zone) changes.zone = patch.zone;
		if (patch.roles !== undefined) {
			const next = [...new Set(patch.roles)] as NodeRole[];
			const removed = rolesFor(node).filter((role) => !next.includes(role));
			if (removed.length) this.assertRolesRemovable(node, removed);
			if (JSON.stringify(next) !== node.rolesJson) changes.rolesJson = JSON.stringify(next);
		}
		if (patch.labels !== undefined) {
			const next = patch.labels;
			if (JSON.stringify(next) !== JSON.stringify(labelsFor(node.labelsJson)))
				changes.labelsJson = JSON.stringify(next);
		}
		if (patch.lanEndpoint !== undefined) {
			const next = patch.lanEndpoint || null;
			if (next !== node.lanEndpoint) changes.lanEndpoint = next;
		}
		if (patch.cpuBudgetMillis !== undefined) {
			const next = patch.cpuBudgetMillis ?? null;
			if (next !== node.cpuBudgetMillis) changes.cpuBudgetMillis = next;
		}
		const dataDir = patch.dataDir === undefined ? node.storageDataDir : patch.dataDir || null;
		const buildDir = patch.buildDir === undefined ? node.storageBuildDir : patch.buildDir || null;
		if (dataDir && buildDir && (dataDir === buildDir || dataDir.startsWith(`${buildDir}/`) || buildDir.startsWith(`${dataDir}/`)))
			throw new ValidationError('The data and build directories must be separate; neither may contain the other.');
		if (dataDir !== node.storageDataDir) changes.storageDataDir = dataDir;
		if (buildDir !== node.storageBuildDir) changes.storageBuildDir = buildDir;
		if (Object.keys(changes).length === 0) return this.view(node);

		const now = this.ctx.now();
		this.ctx.db
			.update(nodes)
			.set({ ...changes, updatedAt: now })
			.where(eq(nodes.id, nodeId))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'node.update',
			resource: 'node',
			resourceId: nodeId,
			args: changes,
			result: 'ok',
		});
		// Address, slice and storage changes all reach agents through desired state.
		this.bump();
		return this.view({ ...node, ...changes, updatedAt: now });
	}

	/** Refuse dropping a role while resources placed under it still run on the node. */
	private assertRolesRemovable(node: typeof nodesTable.$inferSelect, removed: NodeRole[]): void {
		const blockers: string[] = [];
		if ((removed.includes('ingress') || removed.includes('control')) && node.mode === 'edge')
			blockers.push('it is the edge and terminates ingress');
		if (removed.includes('compute')) {
			const running = this.ctx.db
				.select({ id: workloads.id })
				.from(workloads)
				.where(eq(workloads.nodeId, node.id))
				.all();
			if (running.length) blockers.push(`${running.length} app workload(s)`);
		}
		if (removed.includes('data')) {
			const dbs = this.ctx.db
				.select({ id: databases.id })
				.from(databases)
				.where(and(eq(databases.nodeId, node.id), isNull(databases.deletedAt)))
				.all();
			const stores = this.ctx.db
				.select({ id: storageInstances.id })
				.from(storageInstances)
				.where(and(eq(storageInstances.nodeId, node.id), isNull(storageInstances.deletedAt)))
				.all();
			if (dbs.length) blockers.push(`${dbs.length} database(s)`);
			if (stores.length) blockers.push(`${stores.length} storage instance(s)`);
		}
		if (blockers.length)
			throw new ConflictError(
				`"${node.name}" still runs ${blockers.join(' and ')}. Move or delete them before removing a role.`,
			);
	}

	/**
	 * Storage paths for the node's root `skiff-storage.service`. It asks the control plane rather
	 * than trusting the request file the agent drops, so only a platform admin picks paths (D48).
	 */
	storageFor(token: string): NodeStorage {
		return this.effectiveStorage(this.authenticate(token));
	}

	/**
	 * D48 directories the node should use: its explicit setting, else the most-free local ready disk
	 * of the `site-data` / `builds` default tier on this node (docs/STORAGE.md §2.2), else the
	 * install default.
	 */
	effectiveStorage(node: { id: string; storageDataDir: string | null; storageBuildDir: string | null }): NodeStorage {
		return {
			dataDir: node.storageDataDir ?? this.ctx.disks.nodeDirectory('site-data', node.id),
			buildDir: node.storageBuildDir ?? this.ctx.disks.nodeDirectory('builds', node.id),
		};
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

	/**
	 * What still lives on a node and so blocks removing it. Removal never moves or deletes data:
	 * the operator relocates or deletes these first, exactly as removing a disk works (D169).
	 * Soft-deleted rows do not count; their purge simply never runs once the node is gone.
	 */
	removalBlockers(nodeId: string): string[] {
		const names = (rows: Array<{ name: string }>) => rows.map((row) => `"${row.name}"`);
		const blockers: string[] = [];
		const placed = this.ctx.db
			.select({ name: projects.name })
			.from(projects)
			.where(and(eq(projects.placement, nodeId), isNull(projects.deletedAt)))
			.all();
		if (placed.length) blockers.push(`projects placed on it (${names(placed).join(', ')})`);
		const running = this.ctx.db
			.select({ name: projects.name })
			.from(workloads)
			.innerJoin(projects, eq(projects.id, workloads.projectId))
			.where(and(eq(workloads.nodeId, nodeId), isNull(projects.deletedAt)))
			.all();
		if (running.length) blockers.push(`app workloads (${names(running).join(', ')})`);
		const dbs = this.ctx.db
			.select({ name: databases.name })
			.from(databases)
			.where(and(eq(databases.nodeId, nodeId), isNull(databases.deletedAt)))
			.all();
		if (dbs.length) blockers.push(`databases (${names(dbs).join(', ')})`);
		const stores = this.ctx.db
			.select({ name: storageInstances.name })
			.from(storageInstances)
			.where(and(eq(storageInstances.nodeId, nodeId), isNull(storageInstances.deletedAt)))
			.all();
		if (stores.length) blockers.push(`storage instances (${names(stores).join(', ')})`);
		const volumes = this.ctx.db
			.select({ name: appVolumes.name })
			.from(appVolumes)
			.where(and(eq(appVolumes.nodeId, nodeId), isNull(appVolumes.deletedAt)))
			.all();
		if (volumes.length) blockers.push(`app volumes (${names(volumes).join(', ')})`);
		const moving = this.ctx.moves.nodeBlockers(nodeId);
		if (moving.length) blockers.push(`database moves in progress (${moving.join(', ')})`);
		// A live read replica must be removed first; one already being removed is forgotten (C7).
		const replicaCount = this.ctx.databaseReplicas.liveCountOnNode(nodeId);
		if (replicaCount) blockers.push(`database replicas (${replicaCount}; remove them first)`);
		return blockers;
	}

	/**
	 * Forget a worker node: its token stops working at once, its disk registrations and studio
	 * sessions go, and builds it had claimed return to the queue. History (deployments, builds,
	 * logs, audit) keeps the node id. The edge cannot be removed — it terminates ingress — and a
	 * node that still hosts anything is refused with the list of what to move first. Nothing on
	 * the machine itself changes; the operator uninstalls the agent there.
	 */
	remove(principal: Principal, nodeId: string): { ok: true; requeuedBuilds: number } {
		this.assertPlatformAdmin(principal);
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node) throw new NotFoundError('Node');
		if (node.mode === 'edge' || this.ctx.config.edgeNodeId === nodeId)
			throw new ConflictError(
				`"${node.name}" is the edge node. It terminates ingress for every site, so it cannot be removed.`,
			);
		const blockers = this.removalBlockers(nodeId);
		if (blockers.length)
			throw new ConflictError(
				`"${node.name}" still hosts ${blockers.join('; ')}. Move or delete them first.`,
			);

		let requeuedBuilds = 0;
		this.ctx.db.transaction(() => {
			requeuedBuilds = this.ctx.builds.releaseNodeClaims(nodeId);
			this.ctx.pipelines.engine.releaseNode(nodeId);
			this.ctx.db.delete(databaseStudioSessions).where(eq(databaseStudioSessions.nodeId, nodeId)).run();
			this.ctx.disks.forgetNode(nodeId);
			// Share mounts on it are forgotten with it; the share definitions stay.
			this.ctx.db.delete(shareMounts).where(eq(shareMounts.nodeId, nodeId)).run();
			this.ctx.db.delete(nodes).where(eq(nodes.id, nodeId)).run();
			// A removed node can never confirm a purge an earlier move left for it.
			this.ctx.moves.forgetNode(nodeId);
			this.ctx.databaseReplicas.forgetNode(nodeId);
		});
		this.ctx.audit.record({
			principal,
			action: 'node.remove',
			resource: 'node',
			resourceId: nodeId,
			args: { name: node.name, mode: node.mode, publicAddress: node.publicAddress, requeuedBuilds },
			result: 'ok',
		});
		// The edge drops any proxy routes that pointed at this node on its next pull.
		this.bump();
		return { ok: true, requeuedBuilds };
	}

	stateVersion(): number {
		return this.ctx.projects.stateVersion();
	}

	bump(): void {
		this.ctx.projects.bump();
	}

	/**
	 * Provider-side overlay listeners for services this node hosts (C2), plus the listeners read
	 * replicas on other nodes stream through (C7). The agent keeps one listener per port, so every
	 * consumer of a port is merged into that listener's allowlist: emitting one provider per
	 * consumer used to leave all but the last consumer node refused.
	 */
	serviceProvidersForNode(nodeId: string): ServiceProvider[] {
		const node = this.ctx.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
		if (!node?.privateAddress) return [];
		const rows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.upstreamNodeId, nodeId))
			.all();
		const byPort = new Map<number, ServiceProvider>();
		const add = (provider: ServiceProvider): void => {
			const current = byPort.get(provider.listenPort);
			if (!current) {
				byPort.set(provider.listenPort, { ...provider, allowedClientFingerprints: [...provider.allowedClientFingerprints] });
				return;
			}
			// Two services can never share a host port on one node, so the target agrees.
			for (const fingerprint of provider.allowedClientFingerprints)
				if (!current.allowedClientFingerprints.includes(fingerprint)) current.allowedClientFingerprints.push(fingerprint);
		};
		for (const row of rows) {
			const targetPort =
				row.serviceKind === 'database'
					? (this.ctx.databaseReplicas.servicePort(row.serviceId) ??
						this.ctx.db
							.select({ port: databases.hostPort })
							.from(databases)
							.where(eq(databases.id, row.serviceId))
							.get()?.port)
					: this.ctx.db
							.select({ port: storageInstances.hostPort })
							.from(storageInstances)
							.where(eq(storageInstances.id, row.serviceId))
							.get()?.port;
			if (!targetPort) continue;
			const consumerCert = this.ctx.db
				.select({ serial: nodeCertificates.serial })
				.from(nodeCertificates)
				.where(eq(nodeCertificates.nodeId, row.consumerNodeId))
				.get();
			add({
				id: `svp_${row.id}`.slice(0, 100),
				listenAddress: node.privateAddress,
				listenPort: row.upstreamPort,
				targetPort,
				allowedClientFingerprints: consumerCert ? [consumerCert.serial] : [],
			});
		}
		for (const provider of this.ctx.databaseReplicas.providersForNode(nodeId, node.privateAddress)) add(provider);
		return [...byPort.values()]
			.map((provider) => ({ ...provider, allowedClientFingerprints: [...provider.allowedClientFingerprints].sort() }))
			.sort((a, b) => a.listenPort - b.listenPort);
	}

	/** Consumer-side loopback endpoints for this node's remote attachments (C2). */
	private serviceEndpointsForNode(nodeId: string): ServiceEndpoint[] {
		const rows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.consumerNodeId, nodeId))
			.all();
		if (rows.length === 0) return [];
		const nodesById = new Map(this.ctx.db.select().from(nodes).all().map((node) => [node.id, node]));
		return rows
			.map((row) => {
				const upstream = nodesById.get(row.upstreamNodeId);
				return {
					id: row.id,
					kind: row.serviceKind,
					serviceId: row.serviceId,
					localPort: row.localPort,
					upstream: {
						nodeId: row.upstreamNodeId,
						address: upstream?.privateAddress ?? null,
						port: row.upstreamPort,
					},
					tlsFingerprint:
						this.ctx.db
							.select({ serial: nodeCertificates.serial })
							.from(nodeCertificates)
							.where(eq(nodeCertificates.nodeId, row.upstreamNodeId))
							.get()?.serial ?? null,
				};
			})
			.sort((a, b) => a.localPort - b.localPort);
	}

	/** Upsert the public node certificate; the private key never reaches this process. */
	private storeCertificate(nodeId: string, certificate: NodeIdentityCertificate | undefined, now: number): void {
		if (!certificate) return;
		const expiresAt = Date.parse(certificate.expiresAt);
		if (!Number.isFinite(expiresAt)) return;
		const existing = this.ctx.db
			.select({ nodeId: nodeCertificates.nodeId })
			.from(nodeCertificates)
			.where(eq(nodeCertificates.nodeId, nodeId))
			.get();
		if (existing) {
			this.ctx.db
				.update(nodeCertificates)
				.set({
					serial: certificate.fingerprint,
					certPem: certificate.certPem,
					issuedAt: now,
					expiresAt,
					revokedAt: null,
				})
				.where(eq(nodeCertificates.nodeId, nodeId))
				.run();
		} else {
			this.ctx.db
				.insert(nodeCertificates)
				.values({
					nodeId,
					serial: certificate.fingerprint,
					certPem: certificate.certPem,
					caSerial: null,
					issuedAt: now,
					expiresAt,
					revokedAt: null,
				})
				.run();
		}
	}

	/** Full rows as the pure peer-graph builder needs them. */
	private overlayNodes(): OverlayNode[] {
		return this.ctx.db
			.select()
			.from(nodes)
			.all()
			.map((row) => ({
				id: row.id,
				name: row.name,
				zone: row.zone,
				roles: rolesFor(row),
				networkMode: row.networkMode,
				privateAddress: row.privateAddress,
				wgPublicKey: row.wgPublicKey,
				publicAddress: row.publicAddress,
				wgEndpoint: row.wgEndpoint,
				lanEndpoint: row.lanEndpoint,
			}));
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

		// Apps are served from the node their workload was admitted to (`auto` and database pinning
		// resolve at deploy time); the placement request is only the fallback before a deploy.
		const workloadNodeByProject = new Map(
			this.ctx.db
				.select({ projectId: workloads.projectId, nodeId: workloads.nodeId })
				.from(workloads)
				.all()
				.flatMap((row) => (row.nodeId ? [[row.projectId, row.nodeId] as const] : [])),
		);
		const replicaNodesByProject = new Map<string, string[]>();
		for (const replica of this.ctx.db
			.select({ projectId: workloadReplicas.projectId, nodeId: workloadReplicas.nodeId })
			.from(workloadReplicas)
			.all()) {
			const list = replicaNodesByProject.get(replica.projectId) ?? [];
			list.push(replica.nodeId);
			replicaNodesByProject.set(replica.projectId, list);
		}

		const targetOf = (project: { id: string; runtime: string; runtimeName?: string | null; placement: string }): string | null =>
			(effectiveRuntime(project) !== 'static' ? workloadNodeByProject.get(project.id) : undefined) ??
			(project.placement === 'edge' || project.placement === 'auto' ? edgeId : project.placement);

		const projectRows = this.ctx.db
			.select()
			.from(projects)
			.where(isNull(projects.deletedAt))
			.all()
			.filter((project) => {
				const target = targetOf(project);
				// Edge serves edge-placed projects locally and proxies worker-placed ones; a worker
				// only serves the projects placed on it.
				return isEdge || target === node.id;
			});

		const routes: RouteSpec[] = [];
		/**
		 * The edge-only part of each policy (service tokens, whether a person could still match and
		 * whether the policy is enabled), read once per pull and shared by every route using it.
		 */
		const edgeSettings = new Map<string, ReturnType<CoreContext['accessPolicies']['edgeSettings']>>();
		const accessEdge = (policyId: string | null) => {
			if (!policyId) return {};
			let settings = edgeSettings.get(policyId);
			if (!settings) {
				settings = this.ctx.accessPolicies.edgeSettings(policyId);
				edgeSettings.set(policyId, settings);
			}
			return {
				policyEnabled: settings.enabled,
				serviceTokens: settings.serviceTokens,
				hasPersonRules: settings.hasPersonRules,
			};
		};
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

		/** Projects that serve HTTP at all (everything but workers); candidates for a default page. */
		const siteProjectIds = new Set<string>();
		for (const project of projectRows) {
			const target = targetOf(project) ?? node.id;
			const local = target === node.id;
			const workload = workloadByProject.get(project.id);
			// Parse the project's saved spec once: the worker test and a function route both need it.
			const spec = workloadSpecOf(project);
			// Workers (plan 21) have no route at all: no preview URL, no environment host. Their
			// release is app code or a template manifest and must never be served as a static site;
			// a process worker on this node still needs the release itself.
			if (isWorkerProject(project, spec)) {
				if (local && effectiveRuntime(project) === 'process') {
					for (const deployment of this.ctx.db
						.select({ releaseId: deployments.releaseId })
						.from(deployments)
						.where(and(eq(deployments.projectId, project.id), eq(deployments.status, 'active')))
						.all()) {
						const release = this.ctx.db
							.select({ sha256: releases.sha256 })
							.from(releases)
							.where(eq(releases.id, deployment.releaseId))
							.get();
						if (release) releaseShas.add(release.sha256);
					}
				}
				continue;
			}
			siteProjectIds.add(project.id);
			// Apps proxy to the workload on their node; the edge reaches a worker's Caddy over WireGuard.
			const upstream =
				effectiveRuntime(project) !== 'static' && local
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
				// A function's assets are part of *this deployment's* snapshot (rollback restores it),
				// and they live in the release, so only the node holding the release serves them. The
				// edge has no release and proxies here like any other worker-placed site (D110).
				const deploymentSpec = workloadSpecOf({ workloadJson: deployment.workloadJson });
				// A function dials its own socket (phase 4). Replica 0 keeps the workload id, so a
				// single-host function uses `<workload-id>.sock`, matching the helper's socket unit.
				// Read from this deployment's snapshot, so a rollback restores its own upstream.
				const functionUpstream =
					local && workload && deploymentSpec?.runtime === 'function'
						? upstreamFor(workload.id, deploymentSpec)
						: null;
				const functionRoute =
					local && deploymentSpec?.runtime === 'function'
						? {
								function: {
									assetsDirectory: deploymentSpec.function?.assets?.directory ?? null,
									runWorkerFirst: deploymentSpec.function?.assets?.runWorkerFirst ?? [],
									// Phase 4: a stateless function with `replicas > 1` gets one socket per
									// replica, in order, and the node's Caddy balances across them. Omitted
									// for a single host, so that route is byte-identical to phase 1.
									...(workload && deploymentSpec.replicas > 1
										? {
												upstreams: Array.from({ length: deploymentSpec.replicas }, (_, index) =>
													upstreamFor(workloadReplicaId(workload.id, index), deploymentSpec),
												),
											}
										: {}),
								},
							}
						: {};
				const replicaNodes = replicaNodesByProject.get(project.id) ?? [];
				const replicaUpstreams =
					!local && replicaNodes.length > 1
						? replicaNodes
								.map((nodeId) => nodeById.get(nodeId)?.publicAddress)
								.filter((address): address is string => Boolean(address))
								.map((address) => `http://${address}`)
						: [];
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
					upstream: functionUpstream ?? upstream,
					...(replicaUpstreams.length > 1
						? {
							upstreams: replicaUpstreams,
							...(deploymentSpec?.healthPath
								? {
										healthPath: deploymentSpec.healthPath,
										healthIntervalSeconds: this.ctx.cluster.get().replicas.healthIntervalSeconds,
									}
								: {}),
						}
						: {}),
					...functionRoute,
				} satisfies Omit<RouteSpec, 'host' | 'access' | 'accessMode'>;
				baseByDeployment.set(deployment.id, base);

				// Every deployment always gets its immutable preview URL, whatever its environment.
				const previewPolicyId = project.previewAccessPolicyId ?? null;
				const previewAccessMode = effectiveAccessMode(project.previewAccess, previewPolicyId);
				routes.push({
					...base,
					host: deployment.previewHost,
					production: false,
					accessMode: previewAccessMode,
					access: {
						mode: previewAccessMode,
						siteKey: siteKeyFor(this.ctx.config.siteCookieSecret, project.id, project.siteSessionEpoch),
						loginUrl: loginUrlFor(this.ctx.config.platformOrigin, previewAccessMode, project.id),
						policyId: previewPolicyId,
						...accessEdge(previewPolicyId),
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
					accessPolicyId: project.productionAccessPolicyId ?? null,
					passwordHash: null,
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
				const environmentPolicyId = environment.isProduction
					? (project.productionAccessPolicyId ?? null)
					: (environment.accessPolicyId ?? null);
				const accessMode = effectiveAccessMode(
					environment.isProduction ? project.productionAccess : environment.access,
					environmentPolicyId,
				);
				routes.push({
					...base,
					host: this.ctx.environments.hostFor(project, environment),
					production: true,
					accessMode,
					access: {
						mode: accessMode,
						siteKey: siteKeyFor(this.ctx.config.siteCookieSecret, project.id, project.siteSessionEpoch),
						loginUrl: loginUrlFor(this.ctx.config.platformOrigin, accessMode, project.id),
						policyId: environmentPolicyId,
						...accessEdge(environmentPolicyId),
					},
				});
				if (environment.isProduction) productionProjectIds.add(project.id);
			}
		}

		// A project created in the dashboard and never deployed gets a default page at its production
		// host instead of "No site here". Only the edge answers public traffic, and only while there is
		// no production pointer at all: a pointer whose release is missing is a fault, not a new project.
		const placeholders = isEdge
			? projectRows
					.filter(
						(project) =>
							siteProjectIds.has(project.id) &&
							!productionProjectIds.has(project.id) &&
							!project.productionDeploymentId &&
							!(environmentsByProject.get(project.id) ?? []).some((row) => row.isProduction && row.deploymentId),
					)
					.map((project) => ({
						host: `${project.slug}.${this.ctx.config.contentDomain}`,
						projectId: project.id,
						dashboardUrl: `${this.ctx.config.platformOrigin.replace(/\/+$/, '')}/projects/${project.slug}`,
					}))
			: [];

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

		// Managed databases ride the workload list as container workloads with a database profile.
		const workloadRows = [
			...this.ctx.workloads.desiredForNode(node.id),
			...this.ctx.databases.desiredForNode(node.id),
			// Postgres read replicas are their own database-profile workloads (C7).
			...this.ctx.databaseReplicas.desiredForNode(node.id),
			...this.ctx.storage.desiredForNode(node.id),
			...this.ctx.brokers.desiredForNode(node.id),
			// The platform registry (docs/REGISTRY.md G1) on its node.
			...this.ctx.registry.desiredForNode(node.id),
		];
		// Custom domains always clone the production route (stream B), so only projects with a
		// production pointer are candidates; staging-only projects must not serve them.
		const servedProjectIds = productionProjectIds;

		// The native studio (D96) routes ride one internal gateway listener on the edge's loopback.
		const publicAddressOf = (id: string) => nodeById.get(id)?.publicAddress ?? null;
		const databaseGateway = {
			listen: isEdge ? `127.0.0.1:${this.ctx.config.databaseGatewayPort ?? 8082}` : null,
			routes: [
				...this.ctx.databaseStudio.gatewayRoutes(node.id, isEdge, publicAddressOf),
				// Container console fronts (D127) share the internal gateway with `console.internal` hosts.
				...this.ctx.containerConsole.gatewayRoutes(node.id, isEdge, publicAddressOf),
			],
		};

		return {
			version: this.stateVersion(),
			nodeId: node.id,
			agentVersion: this.ctx.config.desiredAgentVersion ?? '0.1.0',
			nodeUpdate: this.updateTaskFor(node),
			generatedAt: new Date(now).toISOString(),
			contentDomain: this.ctx.config.contentDomain,
			platformOrigin: this.ctx.config.platformOrigin,
			sliceMemoryMb: node.sliceMemoryMb,
			sliceCpuWeight: node.sliceCpuWeight,
			storage: this.effectiveStorage(node),
			releases: releaseSpecs,
			routes,
			// Kept until every session a revocation affects has expired (share sessions last up to
			// 30 days), not for a fixed window.
			revocations: this.ctx.access.revocations(),
			hostRedirects,
			placeholders,
			workloads: workloadRows,
			volumes: this.ctx.disks.desiredForNode(node.id),
			shareMounts: this.ctx.shares.mountsForNode(node.id),
			shareUnmounts: this.ctx.shares.unmountsForNode(node.id),
			diskMounts: this.ctx.disks.mountsForNode(node.id),
			diskUnmounts: this.ctx.disks.unmountsForNode(node.id),
			volumeProfileTasks: this.ctx.disks.profileTasksForNode(node.id),
			// App-volume usage, purges and snapshot/restore tasks (docs/VOLUMES.md).
			appVolumes: this.ctx.appVolumes.lifecycle.volumesForNode(node.id),
			appVolumePurges: this.ctx.appVolumes.lifecycle.purgesForNode(node.id),
			appVolumeTasks: await this.ctx.appVolumes.lifecycle.tasksForNode(node.id),
			// Trashed databases plus the old copy a finished (or rolled-back) move left here.
			databasePurges: [
				...new Set([
					...this.ctx.databases.purgesForNode(node.id),
					...this.ctx.moves.purgesForNode(node.id),
					// Removed replicas, promotion leftovers and fenced old primaries (C7).
					...this.ctx.databaseReplicas.purgesForNode(node.id),
				]),
			].sort(),
			databaseBackupTasks: await this.ctx.databases.backupTasksForNode(node.id),
			databasePitrTasks: await this.ctx.databases.pitrTasksForNode(node.id),
			databaseRotations: this.ctx.databases.rotationTasksForNode(node.id),
			databaseCredentialTasks: this.ctx.databases.credentialTasksForNode(node.id),
			databaseStudioPrincipals: this.ctx.databaseStudio.principals.tasksForNode(node.id),
			databasePoolerRestarts: this.ctx.databases.poolerRestartTasksForNode(node.id),
			databaseReplication: this.ctx.databaseReplicas.replicationTasksForNode(node.id),
			databaseReplicaLinks: this.ctx.databaseReplicas.linksForNode(node.id),
			databaseReplicaPromotions: this.ctx.databaseReplicas.promotionsForNode(node.id),
			storageGateway: this.ctx.storage.gatewayForNode(node.id, isEdge, (id) => nodeById.get(id)?.publicAddress ?? null),
			studio: this.ctx.databaseStudio.desiredForNode(node.id),
			databaseGateway,
			containerConsole: this.ctx.containerConsole.desiredForNode(node),
			storageRoutes: [
				...this.ctx.storage.routesForNode(node.id, isEdge, (id) => nodeById.get(id)?.publicAddress ?? null),
				// The registry host streams like public S3: no body limit, no buffering (G1).
				...this.ctx.registry.routesForNode(node.id, isEdge, (id) => nodeById.get(id)?.publicAddress ?? null),
			],
			// The registry's pull-through cache (G4): Podman mirrors docker.io/ghcr.io/quay.io through it.
			registryMirror: this.ctx.registry.mirrorForNodes(),
			storagePurges: this.ctx.storage.purgesForNode(node.id),
			brokerPurges: this.ctx.brokers.purgesForNode(node.id),
			mail: this.ctx.email.desiredForNode(node.id),
			domains: this.ctx.domains.desiredForProjects(servedProjectIds),
			serviceEndpoints: this.serviceEndpointsForNode(node.id),
			serviceProviders: this.serviceProvidersForNode(node.id),
			...(node.networkMode === 'external'
				? {}
				: { wireguard: buildWireguardState(node.id, this.overlayNodes(), this.ctx.cluster.get().overlay.cidr, this.ctx.cluster.get().overlay) }),
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

function storageStatus(json: string | null): NodeStorageStatus | null {
	const parsed = nodeStorageStatusSchema.safeParse(parseJson(json, null));
	return parsed.success ? parsed.data : null;
}

/** The project's saved workload spec, or null when it has none (or it does not parse). */
function workloadSpecOf(project: { workloadJson: string | null }): WorkloadSpec | null {
	if (!project.workloadJson) return null;
	const spec = workloadSpecSchema.safeParse(parseJson<unknown>(project.workloadJson, null));
	return spec.success ? spec.data : null;
}

/** A project whose current spec is a worker (`ingress: "none"`, plan 21): it gets no route. */
function isWorkerProject(
	project: { runtime: string; runtimeName?: string | null },
	spec: WorkloadSpec | null,
): boolean {
	if (effectiveRuntime(project) === 'static') return false;
	return spec?.ingress === 'none';
}

function capabilities(json: string | null): string[] {
	const parsed = parseJson<unknown>(json, []);
	return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}

const RESERVED_LABEL_PREFIX = 'skiff.io/';

/** Operator-set roles, or the mode/can_build derivation older rows rely on. */
function rolesFor(row: typeof nodesTable.$inferSelect): NodeRole[] {
	const stored = parseJson<unknown>(row.rolesJson, null);
	if (Array.isArray(stored)) {
		const roles = [...new Set(stored.filter((value): value is NodeRole => nodeRoleSchema.safeParse(value).success))];
		if (roles.length > 0) return roles;
	}
	const base: NodeRole[] = row.mode === 'edge' ? ['ingress', 'control', 'compute', 'data'] : ['compute', 'data'];
	if (row.canBuild) base.push('build');
	return base;
}

function labelsFor(raw: string | null): Record<string, string> {
	const stored = parseJson<unknown>(raw, null);
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
	const labels: Record<string, string> = {};
	for (const [key, value] of Object.entries(stored)) {
		if (key.startsWith(RESERVED_LABEL_PREFIX) || typeof value !== 'string') continue;
		labels[key] = value;
	}
	return labels;
}

function hardwareFor(raw: string | null): NodeHardware | null {
	const parsed = nodeHardwareSchema.safeParse(parseJson<unknown>(raw, null));
	return parsed.success ? parsed.data : null;
}

/** `skiff.io/*` labels derived from the hardware report; never operator-written. */
export function derivedLabelsFor(hardware: NodeHardware | null): Record<string, string> {
	if (!hardware) return {};
	const labels: Record<string, string> = {};
	if (hardware.arch) labels['skiff.io/arch'] = hardware.arch;
	if (hardware.virtualization) labels['skiff.io/virt'] = hardware.virtualization;
	if (hardware.gpus?.length) {
		labels['skiff.io/gpu'] = hardware.gpus.some((gpu) => /nvidia/i.test(gpu.name ?? '') || /10de/i.test(gpu.pciId ?? ''))
			? 'nvidia'
			: 'other';
		labels['skiff.io/gpu-count'] = String(hardware.gpus.length);
	}
	if (hardware.memoryBytes !== undefined)
		labels['skiff.io/memory-gb'] = String(Math.max(1, Math.round(hardware.memoryBytes / 1024 ** 3)));
	if (hardware.cpuModel) labels['skiff.io/cpu-model'] = hardware.cpuModel.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 63);
	return labels;
}

/** Validate and store a heartbeat's hardware block; a bad report never clears the last good one. */
function hardwarePatch(hardware: NodeHardware | undefined, now: number): Partial<typeof nodesTable.$inferInsert> {
	if (!hardware) return {};
	const parsed = nodeHardwareSchema.safeParse(hardware);
	if (!parsed.success)
		return { hardwareError: parsed.error.issues[0]?.message ?? 'Invalid hardware report', hardwareAt: now };
	return { hardwareJson: JSON.stringify(parsed.data), hardwareAt: now, hardwareError: null };
}

function wireguardStatusFor(raw: string | null): WireguardStatus | null {
	const parsed = wireguardStatusSchema.safeParse(parseJson<unknown>(raw, null));
	return parsed.success ? parsed.data : null;
}

function wireguardStatusPatch(status: WireguardStatus | undefined, now: number): Partial<typeof nodesTable.$inferInsert> {
	if (!status) return {};
	const parsed = wireguardStatusSchema.safeParse(status);
	if (!parsed.success) return {};
	return { wgStatusJson: JSON.stringify(parsed.data), wgStatusAt: now };
}
