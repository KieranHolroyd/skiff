import type { RequestHandler } from './$types';
import { buildLogChunkSchema, buildReportSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';

function nodeToken(request: Request): string {
	const header = request.headers.get('authorization') ?? '';
	if (!header.startsWith('Bearer ')) throw new Response('Unauthorized', { status: 401 });
	return header.slice(7).trim();
}

/**
 * Builder protocol (D3). A node marked `can_build` authenticates with its node token, claims at
 * most one job, streams log chunks and reports the outcome. No cookies, no CSRF.
 */
const handler: RequestHandler = async (event) => {
	const { request } = event;
	const action = event.params.path?.replace(/^\/+/, '') ?? '';
	const token = nodeToken(request);

	return route(async () => {
		const node = core.nodes.authenticate(token);

		if (action === 'next') {
			if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
			return core.builds.claim(node.id);
		}

		const log = /^([^/]+)\/log$/.exec(action);
		if (log) {
			if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const chunk = await readJson(request, buildLogChunkSchema);
			const text = chunk.lines
				.map((line) => (chunk.stream === 'stderr' ? `[stderr] ${line}` : line))
				.join('\n');
			const appended = core.builds.appendLog(node.id, log[1]!, text ? `${text}\n` : '');
			if (!appended) return json({ error: 'not_found' }, 404);
			return { ok: true };
		}

		const report = /^([^/]+)\/report$/.exec(action);
		if (report) {
			if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
			const input = await readJson(request, buildReportSchema);
			return core.builds.report(node.id, report[1]!, input);
		}

		return json({ error: 'not_found', action }, 404);
	});
};

export const GET = handler;
export const POST = handler;
