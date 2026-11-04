import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { errorResponse } from '#lib/server/api.js';

const HEARTBEAT_MS = 15_000;

/**
 * Live progress for one operation (docs/OPERATIONS.md §2.5). Events: `progress` (the operation
 * view), `items` (finished items in `seq` order, `id: <seq>` for resumption) and `done`. The
 * dashboard connects with `EventSource` (session cookie); the CLI streams it with `fetch` and its
 * API key. `?until=done` keeps the stream open past `planned` (an applied plan's whole run).
 */
export const GET: RequestHandler = async ({ locals, params, url, request }) => {
	const principal = locals.principal;
	if (!principal) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
	try {
		core.operations.get(principal, params.id);
	} catch (error) {
		return errorResponse(error);
	}

	const lastEventId = request.headers.get('last-event-id') ?? url.searchParams.get('after');
	const after = lastEventId && Number.isFinite(Number(lastEventId)) ? Math.max(0, Math.floor(Number(lastEventId))) : 0;
	const untilPlanned = url.searchParams.get('until') !== 'done';
	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let closed = false;
			const write = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					closed = true;
				}
			};
			const send = (event: string, data: unknown, id?: number) =>
				write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
			write('retry: 2000\n\n');
			try {
				for await (const event of core.operations.events(principal, params.id, {
					after,
					signal: request.signal,
					untilPlanned,
				})) {
					if (event.type === 'items') send('items', { items: event.items, cursor: event.cursor }, event.cursor);
					else send(event.type, event.operation);
					if (event.type === 'done') break;
				}
			} catch (error) {
				send('server-error', { message: error instanceof Error ? error.message : 'The progress stream failed.' });
			} finally {
				clearInterval(heartbeat);
				closed = true;
				try {
					controller.close();
				} catch {
					// Already cancelled by the client.
				}
			}
		},
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		},
	});
};
