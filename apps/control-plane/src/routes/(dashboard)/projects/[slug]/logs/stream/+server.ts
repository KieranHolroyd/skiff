import type { RequestHandler } from './$types';
import { hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';

const TAIL_LIMIT = 500;
const FLUSH_MS = 700;
const HEARTBEAT_MS = 15_000;

/**
 * Live log tail (DESIGN §8). The stream is deliberately a thin reader over the ordered
 * `log_events` table: SSE reconnects with `after=<cursor>` and gets exactly what it missed, while
 * a fresh tab receives the newest page first. Build streams end when the build settles; runtime
 * streams stay open until the tab goes away.
 */
export const GET: RequestHandler = async ({ locals, params, url, request }) => {
	const principal = locals.principal;
	if (!principal) return new Response('Unauthorized', { status: 401 });
	if (!hasPermission(principal, 'logs:read')) return new Response('Forbidden', { status: 403 });

	let project;
	try {
		project = core.projects.requireRow(principal, params.slug);
	} catch {
		return new Response('Not found', { status: 404 });
	}

	const source = url.searchParams.get('source') === 'build' ? 'build' : 'runtime';
	const buildId = url.searchParams.get('buildId')?.trim() || undefined;
	const deploymentId = url.searchParams.get('deploymentId')?.trim() || undefined;
	const afterParam = url.searchParams.get('after');
	// EventSource reconnects reuse the URL but send the last `id:` as `Last-Event-ID`, so a drop
	// never replays the initial page or loses the lines written while the tab was away.
	const lastEventId = request.headers.get('last-event-id');
	const afterSource = afterParam ?? lastEventId;
	const after =
		afterSource !== null && Number.isFinite(Number(afterSource))
			? Math.max(0, Math.floor(Number(afterSource)))
			: null;
	const level = url.searchParams.get('level') as 'debug' | 'info' | 'warn' | 'error' | null;
	const q = url.searchParams.get('q')?.trim() || undefined;

	if (source === 'build') {
		if (!buildId) return new Response('buildId is required for a build stream', { status: 400 });
		const build = core.ctx.sqlite
			.query<{ id: string }, [string, string]>(
				'SELECT id FROM builds WHERE id = ? AND project_id = ?'
			)
			.get(buildId, project.id);
		if (!build) return new Response('Build not found', { status: 404 });
	} else if (deploymentId) {
		const deployment = core.ctx.sqlite
			.query<{ id: string }, [string, string]>(
				'SELECT id FROM deployments WHERE id = ? AND project_id = ?'
			)
			.get(deploymentId, project.id);
		if (!deployment) return new Response('Deployment not found', { status: 404 });
	}

	const encoder = new TextEncoder();
	const filter = {
		source,
		...(buildId ? { buildId } : {}),
		...(deploymentId && source === 'runtime' ? { deploymentId } : {}),
		...(level && ['debug', 'info', 'warn', 'error'].includes(level) ? { level } : {}),
		...(q ? { q } : {})
	} as const;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let closed = false;
			const send = (event: string, data: unknown, id?: number): void => {
				if (closed) return;
				try {
					const prefix = id === undefined ? '' : `id: ${id}\n`;
					controller.enqueue(
						encoder.encode(`${prefix}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
					);
				} catch {
					closed = true;
				}
			};
			const ping = (): void => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
				} catch {
					closed = true;
				}
			};

			let cursor = after ?? 0;
			let lastStatus: string | null = null;
			let lastPing = Date.now();
			try {
				// A new tab starts with the newest page; a reconnect starts strictly after its cursor.
				if (after === null) {
					const tail = core.logs.query(principal, project, {
						...filter,
						limit: source === 'build' ? 2_000 : TAIL_LIMIT
					});
					send('logs', { events: tail.events, cursor: tail.cursor, initial: true }, tail.cursor);
					cursor = tail.cursor;
				}
				lastStatus = source === 'build' && buildId ? buildStatus(project.id, buildId) : null;
				send('ready', {
					source,
					cursor,
					buildId: buildId ?? null,
					deploymentId: deploymentId ?? null,
					status: lastStatus
				});

				while (!request.signal.aborted && !closed) {
					const page = core.logs.query(principal, project, {
						...filter,
						after: cursor,
						limit: 300
					});
					if (page.events.length > 0) {
						cursor = page.cursor;
						send('logs', { events: page.events, cursor }, cursor);
					}

					if (source === 'build' && buildId) {
						const status = buildStatus(project.id, buildId);
						if (status !== lastStatus) {
							lastStatus = status;
							send('status', { status });
						}
						// A settled build has no more rows to write. Flush once more, then close so the
						// client shows "finished" instead of a permanently reconnecting EventSource.
						if (status && status !== 'queued' && status !== 'building') {
							const final = core.logs.query(principal, project, {
								...filter,
								after: cursor,
								limit: 300
							});
							if (final.events.length === 0) {
								send('end', { status });
								break;
							}
						}
					}

					if (Date.now() - lastPing >= HEARTBEAT_MS) {
						lastPing = Date.now();
						ping();
					}
					await sleep(FLUSH_MS, request.signal);
				}
			} catch (error) {
				send('server-error', {
					message: error instanceof Error ? error.message : 'The log stream failed.'
				});
			} finally {
				closed = true;
				try {
					controller.close();
				} catch {
					// Already cancelled by the browser.
				}
			}
		},
		cancel() {
			// `request.signal` also aborts; nothing else to release.
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

function buildStatus(projectId: string, buildId: string): string | null {
	return (
		core.ctx.sqlite
			.query<{ status: string }, [string, string]>(
				'SELECT status FROM builds WHERE id = ? AND project_id = ?'
			)
			.get(buildId, projectId)?.status ?? null
	);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', finish, { once: true });
	});
}
