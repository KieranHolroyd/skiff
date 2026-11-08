import type { RequestHandler } from './$types';
import {
	agentEventAckSchema,
	agentJobHeartbeatSchema,
	agentJobResultSchema,
	agentNodeTaskResultSchema,
	heartbeatSchema,
	mailEventsBatchSchema,
	mailOutboxAckSchema,
	nodeJoinSchema,
	CONTAINER_CONSOLE_TOKEN_HEADER,
	STUDIO_TOKEN_HEADER,
	telemetryBatchSchema
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';

function nodeToken(request: Request): string {
	const header = request.headers.get('authorization') ?? '';
	if (!header.startsWith('Bearer ')) throw new Response('Unauthorized', { status: 401 });
	return header.slice(7).trim();
}

/**
 * Agent protocol (DESIGN §3.3, §8). Machine-authenticated with a node bearer token; no cookies,
 * no CSRF. `desired-state` long-polls so a deploy converges in ~1 s without polling cost.
 */
const handler: RequestHandler = async (event) => {
	const { request, url } = event;
	const action = event.params.path?.replace(/^\//, '') ?? '';
	const method = request.method;

	return route(async () => {
		if (action === 'join') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, nodeJoinSchema);
			const result = core.nodes.join(input);
			return json(result, 201);
		}

		const token = nodeToken(request);

		if (action === 'desired-state') {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			// Authenticate before holding the long-poll: an unknown or rotated token gets a 401
			// immediately instead of a 304 after the wait.
			core.nodes.authenticate(token);
			const current = core.nodes.stateVersion();
			const etag = `"v${current}"`;
			const clientVersion = Number(
				request.headers.get('if-none-match')?.replace(/[^0-9]/g, '') ?? 0
			);
			const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 25);
			if (clientVersion === current && wait > 0) {
				const deadline = Date.now() + wait * 1000;
				while (Date.now() < deadline) {
					await Bun.sleep(1000);
					if (core.nodes.stateVersion() !== current) break;
				}
			}
			if (clientVersion === core.nodes.stateVersion())
				return new Response(null, {
					status: 304,
					headers: { etag: `"v${core.nodes.stateVersion()}"`, 'cache-control': 'no-store' }
				});
			const state = await core.nodes.desiredState(token);
			return json(state, 200, { etag: `"v${state.version}"`, 'cache-control': 'no-store' });
		}

		if (action === 'heartbeat') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, heartbeatSchema);
			return core.nodes.heartbeat(token, input);
		}

		if (action === 'storage') {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			return core.nodes.storageFor(token);
		}

		const activation = /^workloads\/([^/]+)\/activation$/.exec(action);
		if (activation) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return core.workloads.activationFor(node.id, activation[1]!);
		}

		// Event notifications (D122): the broker's node publishes pending deliveries and acks them.
		if (action === 'events/lease') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return core.events.lease(node.id);
		}

		if (action === 'events/ack') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, agentEventAckSchema);
			const node = core.nodes.authenticate(token);
			return core.events.ack(node.id, input);
		}

		// Node tasks (D124): queue and function tools the target node runs once and reports.
		if (action === 'tasks/lease') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), 25);
			const deadline = Date.now() + wait * 1000;
			while (!core.nodeTasks.hasPending(node.id) && Date.now() < deadline && !request.signal.aborted)
				await Bun.sleep(250);
			return json(core.nodeTasks.lease(node.id), 200, { 'cache-control': 'no-store' });
		}

		if (action === 'tasks/result') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, agentNodeTaskResultSchema);
			const node = core.nodes.authenticate(token);
			return core.nodeTasks.complete(node.id, input);
		}

		// Jobs (plan 09): the project's node leases runs, reports the ones it holds and posts exits.
		if (action === 'jobs/lease') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), 25);
			const deadline = Date.now() + wait * 1000;
			while (!core.jobs.hasQueued(node.id) && Date.now() < deadline && !request.signal.aborted)
				await Bun.sleep(250);
			return json(core.jobs.lease(node.id), 200, { 'cache-control': 'no-store' });
		}

		if (action === 'jobs/heartbeat') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, agentJobHeartbeatSchema);
			const node = core.nodes.authenticate(token);
			return core.jobs.heartbeat(node.id, input);
		}

		if (action === 'jobs/result') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, agentJobResultSchema);
			const node = core.nodes.authenticate(token);
			return core.jobs.complete(node.id, input);
		}

		// Email (docs/EMAIL.md §3.5, D117): only the mail node's agent may call these. The state
		// carries opened DKIM keys, so like an activation it is fetched, never put in desired state.
		if (action === 'email/state') {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return json(core.email.stateForNode(node.id), 200, { 'cache-control': 'no-store' });
		}

		if (action === 'email/outbox') {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			const limit = Number(url.searchParams.get('limit') ?? 50);
			const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 25);
			let messages = core.email.claimOutbox(node.id, limit);
			const deadline = Date.now() + wait * 1000;
			while (messages.length === 0 && Date.now() < deadline) {
				await Bun.sleep(500);
				messages = core.email.claimOutbox(node.id, limit);
			}
			return json({ messages }, 200, { 'cache-control': 'no-store' });
		}

		if (action === 'email/outbox/ack') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, mailOutboxAckSchema);
			const node = core.nodes.authenticate(token);
			return { acked: core.email.ackOutbox(node.id, input.messageIds) };
		}

		if (action === 'email/events') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, mailEventsBatchSchema);
			const node = core.nodes.authenticate(token);
			return core.email.ingestEvents(node.id, input.events);
		}

		const rotation = /^database-rotations\/([^/]+)$/.exec(action);
		if (rotation) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return core.databases.rotationActivation(node.id, rotation[1]!);
		}

		// The primary's `skiff_repl` password for one replication task (C7); never in desired state.
		const replication = /^database-replication\/([^/]+)$/.exec(action);
		if (replication) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return core.databaseReplicas.replicationActivation(node.id, replication[1]!);
		}

		const pitrTask = /^database-pitr\/([^/]+)$/.exec(action);
		if (pitrTask) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return core.databases.pitrActivation(node.id, pitrTask[1]!);
		}

		// SMB credentials for one share mount (docs/STORAGE.md §3, D143); never in desired state.
		const shareCredential = /^share-mounts\/([^/]+)\/credentials$/.exec(action);
		if (shareCredential) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return json(core.shares.credentialsFor(node.id, shareCredential[1]!), 200, { 'cache-control': 'no-store' });
		}

		const credential = /^database-credentials\/([^/]+)$/.exec(action);
		if (credential) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return core.databases.credentialActivation(node.id, credential[1]!);
		}

		// The read-only studio principal's password (plan 22 track G); never in desired state.
		const studioPrincipal = /^database-studio-principal\/([^/]+)$/.exec(action);
		if (studioPrincipal) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const node = core.nodes.authenticate(token);
			return core.databaseStudio.principals.activation(node.id, studioPrincipal[1]!);
		}

		const studioSession = /^database-studio\/([^/]+)$/.exec(action);
		if (studioSession) {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			// The node bearer says which node is asking; the session token proves this request came
			// through a browser session the control plane minted (plan 22).
			const studioToken = request.headers.get(STUDIO_TOKEN_HEADER)?.trim();
			if (!studioToken) return json({ error: 'unauthorized' }, 401);
			const node = core.nodes.authenticate(token);
			return core.databaseStudio.activation(node.id, studioSession[1]!, studioToken);
		}

		// Container console (D127): the node bearer says which node is asking; the console token
		// proves the call came through a dashboard request the control plane authorised.
		if (action === 'container-console') {
			if (method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			const consoleToken = request.headers.get(CONTAINER_CONSOLE_TOKEN_HEADER)?.trim();
			if (!consoleToken) return json({ error: 'unauthorized' }, 401);
			const node = core.nodes.authenticate(token);
			return core.containerConsole.activation(node.id, consoleToken);
		}

		if (action === 'telemetry') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const batch = await readJson(request, telemetryBatchSchema);
			// The token authenticates the node; the payload must not claim another one.
			const node = core.nodes.authenticate(token);
			if (node.id !== batch.nodeId) return json({ error: 'node_mismatch' }, 403);
			// Database, object-storage and broker sizes and snapshots land in SQLite even when
			// ClickHouse is disabled (D57, S7, D123).
			const databases = await core.databases.ingestTelemetry(
				node.id,
				batch.databases,
				batch.databaseSnapshots
			);
			const storage = await core.storage.ingestTelemetry(
				node.id,
				batch.objectStorage,
				batch.objectStorageBuckets
			);
			const brokerStats = await core.brokers.ingestTelemetry(
				node.id,
				batch.brokers,
				batch.brokerQueues
			);
			if (!core.ctx.telemetry || !(await core.ctx.telemetry.ready()))
				return json({
					ok: true,
					stored: 0,
					databasesStored: 0,
					storageStored: 0,
					brokersStored: 0,
					detail: 'telemetry disabled'
				});
			const result =
				batch.buckets.length > 0 ? await core.ctx.telemetry.ingest(batch.buckets) : { inserted: 0 };
			// Analytics Engine datapoints from function bindings (docs/FUNCTIONS.md §4.5). The store's
			// ingest is fail-open, so a ClickHouse hiccup cannot fail the node's telemetry path.
			if (batch.analytics.length > 0) await core.ctx.telemetry.ingestAnalytics(batch.analytics);
			// Tail-worker items (phase 3) take the same fail-open route.
			if (batch.tails.length > 0) await core.ctx.telemetry.ingestTails(batch.tails);
			return {
				ok: true,
				stored: result.inserted,
				databasesStored: databases.stored,
				storageStored: storage.stored,
				brokersStored: brokerStats.stored,
				analyticsStored: batch.analytics.length,
				tailsStored: batch.tails.length
			};
		}

		return json({ error: 'not_found', action }, 404);
	});
};

export const GET = handler;
export const POST = handler;
