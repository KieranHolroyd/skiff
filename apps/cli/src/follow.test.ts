import { describe, expect, test } from 'bun:test';
import { ApiClient } from './api.ts';
import { ApiError } from './errors.ts';
import { followOperation, takeSettled } from './follow.ts';
import type { OperationItemView, OperationView } from './operations.ts';

function view(status: OperationView['status'], overrides: Partial<OperationView> = {}): OperationView {
	return {
		id: 'op_1',
		kind: 'bulk',
		action: 'project.delete',
		status,
		scope: null,
		phase: null,
		total: 2,
		done: 0,
		failed: 0,
		summary: { verdicts: {}, statuses: {}, flags: {}, freedBytes: 0 },
		createdAt: '2026-11-04T12:00:00.000Z',
		startedAt: null,
		finishedAt: null,
		planExpiresAt: null,
		...overrides,
	};
}

function item(seq: number, status: OperationItemView['status'] = 'succeeded'): OperationItemView {
	return {
		seq,
		category: null,
		targetKind: 'project',
		targetId: `prj_${seq}`,
		label: `p-${seq}`,
		verdict: 'ok',
		reason: null,
		flags: [],
		status,
		error: null,
		bytes: null,
	};
}

const sse = (event: string, data: unknown, id?: number) =>
	`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function streamResponse(text: string): Response {
	return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

async function withServer<T>(
	handler: (request: Request) => Response | Promise<Response>,
	run: (client: ApiClient) => Promise<T>,
): Promise<T> {
	const server = Bun.serve({ port: 0, fetch: handler });
	try {
		return await run(new ApiClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'skif_test' }));
	} finally {
		server.stop(true);
	}
}

describe('takeSettled', () => {
	test('returns finished items after the cursor up to the first gap or pending item', () => {
		expect(takeSettled([item(1), item(2), item(3, 'pending'), item(4)], 0).map((entry) => entry.seq)).toEqual([1, 2]);
		expect(takeSettled([item(2), item(3)], 1).map((entry) => entry.seq)).toEqual([2, 3]);
		expect(takeSettled([item(3)], 1)).toEqual([]);
		expect(takeSettled([item(1), item(2)], 2)).toEqual([]);
	});
});

describe('followOperation', () => {
	test('reconnects a dropped stream with Last-Event-ID and reports every item once', async () => {
		const seen: Array<{ lastEventId: string | null; until: string | null }> = [];
		const items: number[] = [];
		const progress: string[] = [];
		const final = await withServer(
			(request) => {
				const url = new URL(request.url);
				expect(url.pathname).toBe('/api/v1/operations/op_1/stream');
				expect(request.headers.get('authorization')).toBe('Bearer skif_test');
				seen.push({ lastEventId: request.headers.get('last-event-id'), until: url.searchParams.get('until') });
				if (seen.length === 1)
					// Drops after the first item: no `done`.
					return streamResponse(`retry: 2000\n\n${sse('progress', view('applying', { done: 1 }))}${sse('items', { items: [item(1)], cursor: 1 }, 1)}`);
				return streamResponse(
					`: ping\n\n${sse('items', { items: [item(2)], cursor: 2 }, 2)}${sse('done', view('succeeded', { done: 2 }))}`,
				);
			},
			(client) =>
				followOperation(client, view('applying'), {
					untilDone: true,
					backoffMs: 1,
					handlers: {
						progress: (operation) => progress.push(operation.status),
						items: (batch) => items.push(...batch.map((entry) => entry.seq)),
					},
				}),
		);
		expect(final.status).toBe('succeeded');
		expect(seen).toEqual([
			{ lastEventId: null, until: 'done' },
			{ lastEventId: '1', until: 'done' },
		]);
		expect(items).toEqual([1, 2]);
		expect(progress).toEqual(['applying', 'succeeded']);
	});

	test('without untilDone the stream is opened plain and a planned op is settled', async () => {
		const final = await withServer(
			(request) => {
				expect(new URL(request.url).searchParams.get('until')).toBeNull();
				return streamResponse(sse('progress', view('planning', { phase: 'Scanning releases' })) + sse('done', view('planned')));
			},
			(client) => followOperation(client, view('planning'), { untilDone: false }),
		);
		expect(final.status).toBe('planned');
	});

	test('falls back to polling when the stream keeps failing', async () => {
		let streams = 0;
		let polls = 0;
		const items: number[] = [];
		const reconnects: string[] = [];
		const final = await withServer(
			(request) => {
				const url = new URL(request.url);
				if (url.pathname.endsWith('/stream')) {
					streams++;
					return new Response('upstream down', { status: 502 });
				}
				if (url.searchParams.get('items') === '1') {
					const after = Number(url.searchParams.get('after') ?? 0);
					return Response.json({
						operation: view('succeeded'),
						items: [item(1), item(2)].filter((entry) => entry.seq > after),
						cursor: 2,
						hasMore: false,
					});
				}
				polls++;
				expect(url.searchParams.get('wait')).toBe('1');
				return Response.json({ operation: view('succeeded', { done: 2 }) });
			},
			(client) =>
				followOperation(client, view('applying'), {
					untilDone: true,
					retries: 1,
					backoffMs: 1,
					pollWaitSeconds: 1,
					handlers: {
						items: (batch) => items.push(...batch.map((entry) => entry.seq)),
						reconnecting: (_attempt, mode) => reconnects.push(mode),
					},
				}),
		);
		expect(final.status).toBe('succeeded');
		expect(streams).toBe(2);
		expect(polls).toBe(1);
		expect(items).toEqual([1, 2]);
		expect(reconnects).toEqual(['stream', 'poll']);
	});

	test('a 4xx from the stream is an error, not a reconnect', async () => {
		let caught: unknown;
		await withServer(
			() => Response.json({ error: 'not_found', message: 'No such operation.' }, { status: 404 }),
			async (client) => {
				try {
					await followOperation(client, view('applying'), { untilDone: true, backoffMs: 1 });
				} catch (error) {
					caught = error;
				}
			},
		);
		expect(caught).toBeInstanceOf(ApiError);
		expect((caught as ApiError).status).toBe(404);
	});

	test('an already settled operation returns without connecting', async () => {
		const final = await followOperation(new ApiClient({ baseUrl: 'http://127.0.0.1:1', token: 'x' }), view('partial'), {
			untilDone: true,
		});
		expect(final.status).toBe('partial');
	});
});
