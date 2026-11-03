import type { RequestHandler } from './$types';
import { heartbeatSchema, nodeJoinSchema, telemetryBatchSchema } from '@skiff/contracts';
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
			const clientVersion = Number(request.headers.get('if-none-match')?.replace(/[^0-9]/g, '') ?? 0);
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
					headers: { etag: `"v${core.nodes.stateVersion()}"`, 'cache-control': 'no-store' },
				});
			const state = await core.nodes.desiredState(token);
			return json(state, 200, { etag: `"v${state.version}"`, 'cache-control': 'no-store' });
		}

		if (action === 'heartbeat') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, heartbeatSchema);
			return core.nodes.heartbeat(token, input);
		}

		if (action === 'telemetry') {
			if (method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const batch = await readJson(request, telemetryBatchSchema);
			// The token authenticates the node; the payload must not claim another one.
			const node = core.nodes.authenticate(token);
			if (node.id !== batch.nodeId) return json({ error: 'node_mismatch' }, 403);
			if (!core.ctx.telemetry?.available) return json({ ok: true, stored: 0, detail: 'telemetry disabled' });
			const result = await core.ctx.telemetry.ingest(batch.buckets);
			return { ok: true, stored: result.inserted };
		}

		return json({ error: 'not_found', action }, 404);
	});
};

export const GET = handler;
export const POST = handler;
