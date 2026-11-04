/**
 * Follow an operation to the point the caller cares about: `planned` (a plan to review) or a
 * terminal status. Reads the SSE stream; if it drops, reconnects with `Last-Event-ID` so no
 * item is reported twice; after a few failed reconnects, falls back to polling
 * `GET /operations/:id?wait=…`. Rendering is the caller's job (`handlers`).
 */
import type { ApiClient } from './api.ts';
import { ApiError } from './errors.ts';
import { isTerminal, type OperationItemView, type OperationView } from './operations.ts';
import { readSse } from './sse.ts';

export interface FollowHandlers {
	progress?(operation: OperationView): void;
	/** Items that finished, in `seq` order, each reported once. */
	items?(items: OperationItemView[]): void;
	/** The stream dropped and we're reconnecting or polling. */
	reconnecting?(attempt: number, mode: 'stream' | 'poll'): void;
}

export interface FollowOptions {
	/** Keep following past `planned` (an applied plan). Otherwise stop at `planned`. */
	untilDone: boolean;
	handlers?: FollowHandlers;
	/** Stream reconnects before polling. */
	retries?: number;
	/** No bytes (not even a heartbeat; the server pings every 15 s) for this long = dropped. */
	idleMs?: number;
	backoffMs?: number;
	pollWaitSeconds?: number;
	/** `last-event-id` to resume from (the last item `seq` already seen). */
	after?: number;
}

export function isSettled(view: OperationView, untilDone: boolean): boolean {
	return isTerminal(view.status) || (!untilDone && view.status === 'planned');
}

/**
 * The finished items that follow `cursor` without a gap. Items finish in `seq` order; a
 * still-pending item is a gap the cursor must not jump (same rule as the server stream).
 */
export function takeSettled(items: OperationItemView[], cursor: number): OperationItemView[] {
	const out: OperationItemView[] = [];
	let expected = cursor + 1;
	for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
		if (item.seq < expected) continue;
		if (item.seq !== expected || item.status === 'pending') break;
		out.push(item);
		expected++;
	}
	return out;
}

export async function followOperation(
	client: ApiClient,
	initial: OperationView,
	options: FollowOptions,
): Promise<OperationView> {
	const handlers = options.handlers ?? {};
	const retries = options.retries ?? 3;
	const idleMs = options.idleMs ?? 45_000;
	const backoffMs = options.backoffMs ?? 1000;
	let cursor = options.after ?? 0;
	let latest = initial;
	if (isSettled(latest, options.untilDone)) return latest;

	let attempt = 0;
	while (attempt <= retries) {
		if (attempt > 0) {
			handlers.reconnecting?.(attempt, 'stream');
			await sleep(backoffMs * attempt);
		}
		attempt++;
		const controller = new AbortController();
		let idle: ReturnType<typeof setTimeout> | undefined;
		const arm = () => {
			clearTimeout(idle);
			idle = setTimeout(() => controller.abort(), idleMs);
		};
		try {
			arm();
			const body = await client.openOperationStream(latest.id, {
				untilDone: options.untilDone,
				lastEventId: cursor > 0 ? String(cursor) : undefined,
				signal: controller.signal,
			});
			for await (const event of readSse(body, { onChunk: arm })) {
				attempt = 1; // Data is flowing again: the retry budget is for consecutive failures.
				if (event.id && Number.isFinite(Number(event.id))) cursor = Math.max(cursor, Number(event.id));
				const data = parse(event.data);
				if (event.event === 'progress' && isView(data)) {
					latest = data;
					handlers.progress?.(data);
				} else if (event.event === 'items' && isRecord(data) && Array.isArray(data.items)) {
					handlers.items?.(data.items as OperationItemView[]);
				} else if (event.event === 'done' && isView(data)) {
					latest = data;
					handlers.progress?.(data);
					return data;
				} else if (event.event === 'server-error') {
					break;
				}
			}
		} catch (error) {
			// A 4xx (not found, forbidden) won't fix itself by reconnecting.
			if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)
				throw error;
		} finally {
			clearTimeout(idle);
			controller.abort();
		}
	}

	return poll(client, latest, cursor, options);
}

async function poll(
	client: ApiClient,
	initial: OperationView,
	after: number,
	options: FollowOptions,
): Promise<OperationView> {
	const handlers = options.handlers ?? {};
	const waitSeconds = options.pollWaitSeconds ?? 20;
	let cursor = after;
	let errors = 0;
	let latest = initial;
	handlers.reconnecting?.(1, 'poll');
	for (;;) {
		try {
			const settledBefore = isSettled(latest, options.untilDone);
			// `wait` returns as soon as the operation is planned, so it can't pace a planned op
			// we're following to the end; sleep instead.
			const view =
				latest.status === 'planned' && options.untilDone
					? (await sleep(2000), await client.getOperation(latest.id))
					: await client.getOperation(latest.id, { waitSeconds: settledBefore ? 0 : waitSeconds });
			latest = view;
			handlers.progress?.(view);
			for (;;) {
				const page = await client.getOperationItems(view.id, { after: cursor, limit: 1000 });
				const settled = takeSettled(page.items, cursor);
				if (settled.length === 0) break;
				handlers.items?.(settled);
				cursor = settled.at(-1)!.seq;
				if (!page.hasMore && settled.length === page.items.length) break;
			}
			errors = 0;
			if (isSettled(view, options.untilDone)) return view;
		} catch (error) {
			if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)
				throw error;
			if (++errors > 5) throw error;
			await sleep(Math.min(1000 * 2 ** errors, 15_000));
		}
	}
}

function parse(data: string): unknown {
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isView(value: unknown): value is OperationView {
	return isRecord(value) && typeof value.id === 'string' && typeof value.status === 'string';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
