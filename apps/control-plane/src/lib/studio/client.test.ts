import { afterEach, describe, expect, test } from 'bun:test';
import { NDJSON_CONTENT_TYPE, encodeEvent, type StudioEvent } from '@skiff/studio/protocol';
import { StudioCallError, studioApiPath, studioCall, studioStream } from './client.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Seen {
	url: string;
	init: RequestInit;
}

function mockFetch(respond: (seen: Seen) => Response | Promise<Response>): Seen[] {
	const seen: Seen[] = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const entry = { url: String(url), init: init ?? {} };
		seen.push(entry);
		return respond(entry);
	}) as typeof fetch;
	return seen;
}

/** An NDJSON body split at awkward byte boundaries, as a network would deliver it. */
function chunkedBody(events: StudioEvent[], size: number): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(events.map(encodeEvent).join(''));
	return new ReadableStream({
		start(controller) {
			for (let offset = 0; offset < bytes.length; offset += size)
				controller.enqueue(bytes.slice(offset, offset + size));
			controller.close();
		}
	});
}

describe('studioApiPath', () => {
	test('encodes the database name', () => {
		expect(studioApiPath('app db', 'run')).toBe('/databases/app%20db/studio/api/run');
	});
});

describe('studioStream', () => {
	const events: StudioEvent[] = [
		{ t: 'columns', columns: [{ name: 'name', nativeType: 'text', kind: 'text' }] },
		{ t: 'rows', rows: [['ä 漢字 😀'], [null], [{ $t: 'truncated', v: 'abc', bytes: 9000 }]] },
		{ t: 'result', command: 'SELECT 3' },
		{ t: 'notice', level: 'info', message: 'hello' },
		{ t: 'done', ms: 12, truncated: false }
	];

	test('decodes NDJSON events split across chunks', async () => {
		const seen = mockFetch(
			() =>
				new Response(chunkedBody(events, 7), { headers: { 'content-type': NDJSON_CONTENT_TYPE } })
		);
		const received: StudioEvent[] = [];
		for await (const event of studioStream('app-db', 'run', { input: 'select name from t' }))
			received.push(event);
		expect(received).toEqual(events);
		expect(seen[0]!.url).toBe('/databases/app-db/studio/api/run');
		expect(seen[0]!.init.method).toBe('POST');
		expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ input: 'select name from t' });
	});

	test('passes the abort signal to fetch', async () => {
		const controller = new AbortController();
		const seen = mockFetch(
			() => new Response(chunkedBody([], 1), { headers: { 'content-type': NDJSON_CONTENT_TYPE } })
		);
		for await (const _ of studioStream('app-db', 'run', { input: 'x' }, controller.signal)) void _;
		expect(seen[0]!.init.signal).toBe(controller.signal);
	});

	test('throws a typed error for a protocol error body', async () => {
		mockFetch(() =>
			Response.json(
				{ error: { code: 'session_expired', message: 'The session has expired.' } },
				{ status: 410 }
			)
		);
		const stream = studioStream('app-db', 'browse', {
			object: { path: ['t'], kind: 'table' },
			query: {}
		});
		const caught = await stream.next().catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(StudioCallError);
		expect(caught).toMatchObject({
			code: 'session_expired',
			status: 410,
			message: 'The session has expired.'
		});
	});

	test('reports an abort mid-stream as cancelled', async () => {
		const controller = new AbortController();
		mockFetch(({ init }) => {
			const body = new ReadableStream<Uint8Array>({
				start(stream) {
					stream.enqueue(
						new TextEncoder().encode(encodeEvent({ t: 'notice', level: 'info', message: 'a' }))
					);
					init.signal?.addEventListener('abort', () =>
						stream.error(new DOMException('Aborted', 'AbortError'))
					);
				}
			});
			return new Response(body, { headers: { 'content-type': NDJSON_CONTENT_TYPE } });
		});
		const stream = studioStream('app-db', 'run', { input: 'x' }, controller.signal);
		expect((await stream.next()).value).toEqual({ t: 'notice', level: 'info', message: 'a' });
		controller.abort();
		const caught = await stream.next().catch((error: unknown) => error);
		expect(caught).toMatchObject({ code: 'cancelled' });
	});
});

describe('studioCall', () => {
	test('returns the JSON body', async () => {
		mockFetch(() => Response.json({ nodes: [] }));
		expect(await studioCall('app-db', 'tree', {})).toEqual({ nodes: [] });
	});

	test('maps a non-protocol failure by status', async () => {
		mockFetch(() => new Response('Bad gateway', { status: 503 }));
		const caught = await studioCall('app-db', 'info', {}).catch((error: unknown) => error);
		expect(caught).toMatchObject({ code: 'studio_unavailable', status: 503 });
	});

	test('an empty 200 is a retryable studio error, not a JSON parse TypeError', async () => {
		mockFetch(() => new Response(null, { status: 200 }));
		const caught = await studioCall('app-db', 'info', {}).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(StudioCallError);
		expect(caught).toMatchObject({ code: 'studio_unavailable', status: 200 });
	});

	test('a malformed JSON body is a typed internal error', async () => {
		mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
		const caught = await studioCall('app-db', 'info', {}).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(StudioCallError);
		expect(caught).toMatchObject({ code: 'internal', status: 200 });
	});

	test('a network failure is a network error', async () => {
		mockFetch(() => {
			throw new TypeError('Failed to fetch');
		});
		const caught = await studioCall('app-db', 'info', {}).catch((error: unknown) => error);
		expect(caught).toMatchObject({ code: 'network', status: 0 });
	});
});
