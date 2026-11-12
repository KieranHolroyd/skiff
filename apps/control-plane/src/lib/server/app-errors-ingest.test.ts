import { describe, expect, test } from 'bun:test';
import type { AppErrorIngestInput, AppErrorIngestOutcome } from '@yoal/core';
import { handleAppErrorIngest, type AppErrorIngest } from './app-errors-ingest';

const URL_BASE = 'https://control.test/ingest/api/7/envelope/';

function request(
	init: RequestInit & { body?: BodyInit | null; headers?: Record<string, string> } = {},
): Request {
	return new Request(URL_BASE, { method: 'POST', ...init });
}

function fake(outcome: AppErrorIngestOutcome = { status: 200, eventId: 'a'.repeat(32), ignored: 0 }) {
	const seen: AppErrorIngestInput[] = [];
	const ingest: AppErrorIngest = (input) => {
		seen.push(input);
		return outcome;
	};
	return { seen, ingest };
}

describe('app error ingest edge', () => {
	test('OPTIONS returns CORS headers on every path', async () => {
		const { ingest } = fake();
		const response = await handleAppErrorIngest(request({ method: 'OPTIONS' }), '7', 'envelope', ingest);
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
		expect(response.headers.get('access-control-allow-methods')).toContain('OPTIONS');
	});

	test('a non-POST method is 405 with CORS', async () => {
		const { ingest } = fake();
		const response = await handleAppErrorIngest(request({ method: 'GET' }), '7', 'envelope', ingest);
		expect(response.status).toBe(405);
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
	});

	test('multipart/form-data is 415 before the body is read', async () => {
		const { seen, ingest } = fake();
		const response = await handleAppErrorIngest(
			request({ body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=x' } }),
			'7',
			'envelope',
			ingest,
		);
		expect(response.status).toBe(415);
		expect(seen).toHaveLength(0);
	});

	test('a declared body over the limit is 413 without reading it', async () => {
		const { seen, ingest } = fake();
		const response = await handleAppErrorIngest(
			request({ body: 'x', headers: { 'content-length': String(6 * 1024 * 1024) } }),
			'7',
			'envelope',
			ingest,
		);
		expect(response.status).toBe(413);
		expect(seen).toHaveLength(0);
	});

	test('gzip and deflate are decoded before ingest', async () => {
		const { seen, ingest } = fake();
		const text = Buffer.from('{"type":"event","message":"café"}');
		for (const [encoding, encode] of [
			['gzip', Bun.gzipSync],
			['deflate', Bun.deflateSync],
		] as const) {
			const response = await handleAppErrorIngest(
				request({ body: encode(text), headers: { 'content-encoding': encoding } }),
				'7',
				'envelope',
				ingest,
			);
			expect(response.status).toBe(200);
		}
		expect(seen).toHaveLength(2);
		expect(Buffer.from(seen[0]!.body).toString('utf8')).toBe(text.toString('utf8'));
	});

	test('bad compression and unknown encodings are refused', async () => {
		const { seen, ingest } = fake();
		const bad = await handleAppErrorIngest(
			request({ body: 'not gzip', headers: { 'content-encoding': 'gzip' } }),
			'7',
			'envelope',
			ingest,
		);
		expect(bad.status).toBe(400);
		const unknown = await handleAppErrorIngest(
			request({ body: 'x', headers: { 'content-encoding': 'br' } }),
			'7',
			'envelope',
			ingest,
		);
		expect(unknown.status).toBe(415);
		expect(seen).toHaveLength(0);
	});

	test('a decompressed envelope over 1 MB is 413', async () => {
		const { seen, ingest } = fake();
		const response = await handleAppErrorIngest(
			request({ body: Bun.gzipSync(Buffer.alloc(1024 * 1024 + 1, 0x61)), headers: { 'content-encoding': 'gzip' } }),
			'7',
			'envelope',
			ingest,
		);
		expect(response.status).toBe(413);
		expect(seen).toHaveLength(0);
	});

	test('the auth key comes from the header or the query string', async () => {
		const { seen, ingest } = fake();
		await handleAppErrorIngest(
			request({
				body: 'x',
				headers: { 'x-sentry-auth': 'Sentry sentry_version=7, sentry_key=abc123, sentry_client=test' },
			}),
			'7',
			'envelope',
			ingest,
		);
		await handleAppErrorIngest(
			new Request(`${URL_BASE}?sentry_key=query123`, { method: 'POST', body: 'x' }),
			'7',
			'store',
			ingest,
		);
		expect(seen[0]).toMatchObject({ dsnProjectId: '7', endpoint: 'envelope', headerKey: 'abc123', queryKey: null });
		expect(seen[1]).toMatchObject({ dsnProjectId: '7', endpoint: 'store', headerKey: null, queryKey: 'query123' });
	});

	test('an accepted event answers with its id, or an empty object for ignored telemetry', async () => {
		const withId = await handleAppErrorIngest(
			request({ body: 'x' }),
			'7',
			'envelope',
			fake({ status: 200, eventId: 'f'.repeat(32), ignored: 0 }).ingest,
		);
		expect(withId.status).toBe(200);
		expect(await withId.json()).toEqual({ id: 'f'.repeat(32) });
		const ignored = await handleAppErrorIngest(
			request({ body: 'x' }),
			'7',
			'envelope',
			fake({ status: 200, eventId: null, ignored: 2 }).ingest,
		);
		expect(ignored.status).toBe(200);
		expect(await ignored.json()).toEqual({});
	});

	test('rate limits carry retry-after and X-Sentry-Rate-Limits', async () => {
		const response = await handleAppErrorIngest(
			request({ body: 'x' }),
			'7',
			'envelope',
			fake({ status: 429, error: 'rate_limited', retryAfter: 60, rateLimit: '60:error:project:rate_limited' }).ingest,
		);
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('60');
		expect(response.headers.get('x-sentry-rate-limits')).toBe('60:error:project:rate_limited');
		expect(response.headers.get('access-control-allow-origin')).toBe('*');
	});

	test('a bad key and a malformed payload map to 401 and 400', async () => {
		const unauthorized = await handleAppErrorIngest(
			request({ body: 'x' }),
			'7',
			'envelope',
			fake({ status: 401, error: 'invalid_auth' }).ingest,
		);
		expect(unauthorized.status).toBe(401);
		const malformed = await handleAppErrorIngest(
			request({ body: 'x' }),
			'7',
			'envelope',
			fake({ status: 400, error: 'malformed_payload' }).ingest,
		);
		expect(malformed.status).toBe(400);
		expect(malformed.headers.get('access-control-allow-origin')).toBe('*');
	});
});
