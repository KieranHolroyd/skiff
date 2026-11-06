import { describe, expect, test } from 'bun:test';
import { bigintCell, bytesCell, cellToParam, jsonCell, textCell } from './cells.ts';
import { limitEvents } from './limits.ts';
import { decodeEvents, encodeEvent, StudioError, type StudioEvent } from './protocol.ts';
import { loadPlugin } from './registry.ts';
import { fakePlugin } from './fake.ts';

async function collect(events: AsyncIterable<StudioEvent>) {
	const out: StudioEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

describe('cells', () => {
	test('bigints outside the safe range become tagged strings and round-trip', () => {
		expect(bigintCell(42n)).toBe(42);
		const big = bigintCell(2n ** 63n - 1n);
		expect(big).toEqual({ $t: 'bigint', v: '9223372036854775807' });
		expect(cellToParam(big)).toBe(2n ** 63n - 1n);
	});
	test('bytes round-trip through base64', () => {
		const cell = bytesCell(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
		expect(Buffer.from(cellToParam(cell) as Buffer)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
	});
	test('large text is cut on a code point boundary and marked truncated', () => {
		const cell = textCell('é'.repeat(100), 51);
		expect(cell).toMatchObject({ $t: 'truncated', bytes: 200 });
		expect((cell as { v: string }).v).toBe('é'.repeat(25));
		expect(() => cellToParam(cell)).toThrow();
	});
	test('json keeps structure', () => {
		expect(jsonCell({ a: [1, 2] })).toEqual({ $t: 'json', v: { a: [1, 2] } });
	});
});

describe('limitEvents', () => {
	async function* source(): AsyncGenerator<StudioEvent> {
		yield { t: 'columns', columns: [{ name: 'n', nativeType: 'int', kind: 'number' }] };
		for (let i = 0; i < 10; i += 1) yield { t: 'rows', rows: Array.from({ length: 100 }, (_, j) => [i * 100 + j]) };
		yield { t: 'done', ms: 1, truncated: false };
	}
	test('truncates at maxRows, stops the source and ends with done', async () => {
		let cleaned = false;
		async function* tracked() {
			try {
				yield* source();
			} finally {
				cleaned = true;
			}
		}
		const events = await collect(limitEvents(tracked(), { maxRows: 250, maxBytes: 1e9 }));
		expect(events.flatMap((e) => (e.t === 'rows' ? e.rows : [])).length).toBe(250);
		expect(events.at(-1)).toMatchObject({ t: 'done', truncated: true });
		expect(cleaned).toBe(true);
	});
	test('truncates at maxBytes', async () => {
		const events = await collect(limitEvents(source(), { maxRows: 1e6, maxBytes: 200 }));
		const rows = events.flatMap((e) => (e.t === 'rows' ? e.rows : []));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.length).toBeLessThan(100);
		expect(events.at(-1)).toMatchObject({ t: 'done', truncated: true });
	});
	test('closes the source after done so its cleanup runs', async () => {
		let cleaned = false;
		async function* withCleanup(): AsyncGenerator<StudioEvent> {
			try {
				yield* source();
			} finally {
				// A plugin releases its run connection here; it must not stay suspended after done.
				cleaned = true;
			}
		}
		const events = await collect(limitEvents(withCleanup(), { maxRows: 1e6, maxBytes: 1e9 }));
		expect(events.at(-1)).toMatchObject({ t: 'done', truncated: false });
		expect(cleaned).toBe(true);
	});
	test('passes a complete stream through untouched', async () => {
		const events = await collect(limitEvents(source(), { maxRows: 1e6, maxBytes: 1e9 }));
		expect(events.at(-1)).toMatchObject({ t: 'done', truncated: false });
		expect(events.length).toBe(12);
	});
});

describe('protocol', () => {
	test('NDJSON encode/decode round-trips across arbitrary chunk boundaries', async () => {
		const events: StudioEvent[] = [
			{ t: 'columns', columns: [{ name: 'a', nativeType: 'text', kind: 'text' }] },
			{ t: 'rows', rows: [['x'], [{ $t: 'bigint', v: '9007199254740993' }]] },
			{ t: 'done', ms: 3, truncated: false },
		];
		const bytes = new TextEncoder().encode(events.map(encodeEvent).join(''));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
				controller.close();
			},
		});
		expect(await collect(decodeEvents(body))).toEqual(events);
	});
	test('errors carry stable codes and statuses', () => {
		expect(new StudioError('unknown_session', 'x').status).toBe(404);
		expect(new StudioError('read_only', 'x').toBody()).toEqual({ error: { code: 'read_only', message: 'x' } });
	});
});

describe('registry', () => {
	test('an engine without a plugin is unsupported', async () => {
		await expect(loadPlugin('mongodb', {})).rejects.toMatchObject({ code: 'unsupported' });
	});
	test('custom loaders resolve', async () => {
		expect((await loadPlugin('postgres', { postgres: async () => fakePlugin })).id).toBe('fake');
	});
});
