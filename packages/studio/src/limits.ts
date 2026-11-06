/**
 * Enforces the session limits on a plugin's event stream, independent of the plugin. A plugin
 * should already stop at `maxRows`; this is the backstop, and the only place `maxBytes` is
 * enforced. Stopping early calls the iterator's `return()`, so a plugin's `finally` cleanup
 * (close cursor, cancel query) runs.
 */
import { encodedBytes } from './cells.ts';
import type { StudioEvent } from './protocol.ts';

export interface StreamLimits {
	maxRows: number;
	maxBytes: number;
}

export async function* limitEvents(
	events: AsyncIterable<StudioEvent>,
	limits: StreamLimits,
	startedAt = performance.now(),
): AsyncGenerator<StudioEvent> {
	let rowsInResult = 0;
	let bytes = 0;
	let truncated = false;
	let sawDone = false;
	// True only once the source finished on its own. Every other exit (done event, truncation,
	// error, consumer abort) must call `return()`: a plugin generator suspended after yielding
	// `done` still owes its `finally` (rollback, releasing the run connection), and skipping it
	// leaves the session's next run waiting forever.
	let exhausted = false;
	const iterator = events[Symbol.asyncIterator]();
	try {
		while (true) {
			const next = await iterator.next();
			if (next.done) {
				exhausted = true;
				break;
			}
			const event = next.value;
			if (event.t === 'columns') rowsInResult = 0;
			if (event.t === 'rows') {
				let rows = event.rows;
				const roomRows = limits.maxRows - rowsInResult;
				if (rows.length > roomRows) {
					rows = rows.slice(0, Math.max(roomRows, 0));
					truncated = true;
				}
				// Keep whole rows within the byte budget.
				let kept = 0;
				for (const row of rows) {
					const size = encodedBytes(row) + 1;
					if (bytes + size > limits.maxBytes) {
						truncated = true;
						break;
					}
					bytes += size;
					kept += 1;
				}
				rows = rows.slice(0, kept);
				rowsInResult += rows.length;
				if (rows.length > 0) yield { t: 'rows', rows };
				if (truncated) break;
				continue;
			}
			if (event.t === 'done') {
				sawDone = true;
				yield { ...event, truncated: event.truncated || truncated };
				return;
			}
			bytes += encodedBytes(event);
			yield event;
			if (event.t === 'error') {
				yield { t: 'done', ms: elapsed(startedAt), truncated };
				sawDone = true;
				return;
			}
		}
	} finally {
		if (!exhausted) await iterator.return?.();
	}
	if (!sawDone) yield { t: 'done', ms: elapsed(startedAt), truncated };
}

function elapsed(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}
