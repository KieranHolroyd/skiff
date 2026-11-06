import { hasPermission } from '@skiff/contracts';
import { assistantChatRequestSchema } from '@skiff/contracts';
import { json } from '#lib/server/api.js';
import { assistantStatus } from '#lib/server/assistant/config.js';
import { runAssistant } from '#lib/server/assistant/orchestrator.js';
import { allowAssistantTurn } from '#lib/server/assistant/rate-limit.js';
import type { AssistantEvent } from '@skiff/contracts';
import type { RequestHandler } from './$types';

const HEARTBEAT_MS = 15_000;

/**
 * One assistant turn, streamed as Server-Sent Events (docs/ASSISTANT.md). The browser keeps a
 * normal `fetch` stream so it can cancel the run; `request.signal` aborts the upstream model calls.
 *
 * Events are the `AssistantEvent` union: run boundaries, text deltas, tool activity, guided
 * tours, pending destructive confirmations, errors and the terminal `run.finished`.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const principal = locals.principal;
	if (!principal) return json({ error: 'unauthorized' }, 401);
	if (!hasPermission(principal, 'project:read'))
		return json(
			{ error: 'forbidden', message: 'You need project read access to use the assistant.' },
			403
		);
	const status = assistantStatus();
	if (!status.enabled)
		return json(
			{
				error: 'assistant_not_configured',
				message:
					'The assistant is not set up yet. An owner can configure it in Settings → Assistant.'
			},
			503
		);

	const limit = allowAssistantTurn(principal.userId);
	if (!limit.ok)
		return json(
			{
				error: 'rate_limited',
				message: `Slow down for a moment and try again in ${limit.retryAfter}s.`
			},
			429,
			{ 'retry-after': String(limit.retryAfter) }
		);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
	}
	const parsed = assistantChatRequestSchema.safeParse(body);
	if (!parsed.success)
		return json(
			{
				error: 'validation',
				issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
			},
			422
		);

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
			const emit = (event: AssistantEvent) =>
				write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
			write('retry: 2000\n\n');
			try {
				await runAssistant({
					principal,
					request: parsed.data,
					signal: request.signal,
					emit
				});
			} catch (error) {
				emit({
					type: 'error',
					runId: 'run_failed',
					message: error instanceof Error ? error.message : 'The assistant failed.'
				});
			} finally {
				clearInterval(heartbeat);
				closed = true;
				try {
					controller.close();
				} catch {
					// The client already went away.
				}
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
