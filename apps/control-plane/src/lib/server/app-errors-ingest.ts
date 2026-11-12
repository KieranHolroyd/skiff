import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import { authHeaderKey } from '@yoal/core';
import type { AppErrorIngestInput, AppErrorIngestOutcome } from '@yoal/core';

/**
 * Public Sentry ingest for app errors (docs/APP-ERRORS.md).
 *
 * Sentry SDKs build `/<dsn path>/api/<project>/envelope/` or `/store/`; the DSN path is `/ingest`,
 * so the routes live at `/ingest/api/<numeric-dsn-id>/...`. This module owns the HTTP edge only:
 * CORS, compression, key extraction and the status/header mapping around an ingest function. The
 * service is injected so the edge can be tested without booting the control plane's singleton core.
 */

const CORS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers':
		'content-type, x-sentry-auth, sentry-trace, baggage, traceparent, x-requested-with',
	'access-control-expose-headers': 'x-sentry-rate-limits, retry-after',
};

/** The raw-body ceiling before decompression; a Sentry envelope is capped at 1 MB decoded. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 1024 * 1024;

export type AppErrorIngest = (input: AppErrorIngestInput) => AppErrorIngestOutcome;

function headers(extra: Record<string, string> = {}): Headers {
	const out = new Headers(extra);
	for (const [key, value] of Object.entries(CORS)) out.set(key, value);
	return out;
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: headers({ 'content-type': 'application/json', ...extra }),
	});
}

function decode(request: Request, raw: Uint8Array): Uint8Array | Response {
	const encoding = request.headers.get('content-encoding')?.toLowerCase() ?? '';
	if (!encoding || encoding === 'identity') return raw;
	try {
		// maxOutputLength makes a compression bomb a 413 instead of an allocation the size of the
		// attacker's choosing.
		if (encoding === 'gzip')
			return new Uint8Array(gunzipSync(raw, { maxOutputLength: MAX_ENVELOPE_BYTES }));
		if (encoding === 'deflate') {
			try {
				return new Uint8Array(inflateSync(raw, { maxOutputLength: MAX_ENVELOPE_BYTES }));
			} catch (error) {
				if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw error;
				// Some clients send a raw DEFLATE stream rather than the zlib-wrapped HTTP form.
				return new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_ENVELOPE_BYTES }));
			}
		}
	} catch (error) {
		if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
			return json({ detail: 'payload too large' }, 413);
		return json({ detail: 'bad content encoding' }, 400);
	}
	return json({ detail: 'unsupported content encoding' }, 415);
}

function tooLarge(request: Request): boolean {
	const declared = Number(request.headers.get('content-length') ?? '');
	return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}

export async function handleAppErrorIngest(
	request: Request,
	project: string,
	endpoint: 'envelope' | 'store',
	ingest: AppErrorIngest,
): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers() });
	if (request.method !== 'POST') return json({ detail: 'method not allowed' }, 405);

	// The browser snippet sends `text/plain` to avoid a preflight. SDKs use the envelope type or
	// JSON. A multipart body is not a Sentry payload and is refused before it is read.
	const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
	if (contentType.startsWith('multipart/form-data')) return json({ detail: 'unsupported media type' }, 415);

	if (tooLarge(request)) return json({ detail: 'payload too large' }, 413);
	const raw = new Uint8Array(await request.arrayBuffer());
	if (raw.byteLength > MAX_BODY_BYTES) return json({ detail: 'payload too large' }, 413);
	const decoded = decode(request, raw);
	if (decoded instanceof Response) return decoded;
	if (decoded.byteLength > MAX_ENVELOPE_BYTES) return json({ detail: 'payload too large' }, 413);

	const url = new URL(request.url);
	const outcome = ingest({
		dsnProjectId: project,
		endpoint,
		body: decoded,
		headerKey: authHeaderKey(request.headers.get('x-sentry-auth')),
		queryKey: url.searchParams.get('sentry_key'),
	});

	if (outcome.status === 200) return json(outcome.eventId ? { id: outcome.eventId } : {});
	const extra: Record<string, string> = {};
	if (outcome.retryAfter !== undefined) extra['retry-after'] = String(outcome.retryAfter);
	if (outcome.rateLimit) extra['x-sentry-rate-limits'] = outcome.rateLimit;
	const message =
		outcome.status === 401
			? 'invalid authentication'
			: outcome.status === 429
				? 'rate limited'
				: outcome.status === 413
					? 'payload too large'
					: 'malformed sentry payload';
	return json({ detail: message }, outcome.status, extra);
}
