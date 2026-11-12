#!/usr/bin/env bun
/**
 * Capture sink for the error-tracker compatibility harnesses.
 *
 * It speaks just enough of the Sentry ingest protocol to be a useful target:
 *   POST /ingest/api/<project>/envelope/
 *   POST /ingest/api/<project>/store/
 *   OPTIONS on both
 *
 * The `/ingest` prefix is the Yoal DSN path (`https://<key>@<host>/ingest/<project>`). The
 * unprefixed `/api/<project>/...` form is also accepted so the same sink works for a standalone
 * tracker or a plain Sentry-shaped client.
 *
 * Every request is written to `captures/` as JSON (raw body, decoded body, headers and a
 * best-effort envelope parse) so the real parser can be developed and tested against payloads
 * produced by actual Sentry SDKs. It is not the tracker; it never stores anything in a database.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const port = Number(process.env.SINK_PORT ?? 18080);
const hostname = process.env.SINK_HOST ?? '127.0.0.1';
const capturesDir = process.env.CAPTURES_DIR ?? join(import.meta.dir, 'captures');
mkdirSync(capturesDir, { recursive: true });
const manifestPath = join(capturesDir, 'manifest.jsonl');
const runId = process.env.CAPTURE_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-');

const CORS: Record<string, string> = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers':
		'content-type, x-sentry-auth, sentry-trace, baggage, traceparent, x-requested-with',
	'access-control-expose-headers': 'x-sentry-rate-limits, retry-after',
};

function headers(extra: Record<string, string> = {}): Headers {
	const out = new Headers(extra);
	for (const [key, value] of Object.entries(CORS)) out.set(key, value);
	return out;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: headers({ 'content-type': 'application/json' }),
	});
}

function readLine(buffer: Buffer, offset: number): { line: string; next: number } {
	const end = buffer.indexOf(0x0a, offset);
	if (end === -1) return { line: buffer.subarray(offset).toString('utf8'), next: buffer.length };
	return { line: buffer.subarray(offset, end).toString('utf8'), next: end + 1 };
}

type EnvelopeItem = {
	header: Record<string, unknown>;
	length: number;
	text?: string;
	binary?: boolean;
};

function parseEnvelope(buffer: Buffer): { header: unknown; items: EnvelopeItem[] } {
	const first = readLine(buffer, 0);
	let header: unknown = null;
	try {
		header = JSON.parse(first.line);
	} catch {
		// Keep the raw body; a malformed header is still useful to see.
	}
	const items: EnvelopeItem[] = [];
	let offset = first.next;
	while (offset < buffer.length) {
		// A trailing newline after the last item is legal.
		if (buffer[offset] === 0x0a) {
			offset++;
			continue;
		}
		const line = readLine(buffer, offset);
		let itemHeader: Record<string, unknown>;
		try {
			itemHeader = JSON.parse(line.line) as Record<string, unknown>;
		} catch {
			break;
		}
		offset = line.next;
		let payload: Buffer;
		const length = itemHeader.length;
		if (typeof length === 'number' && Number.isFinite(length) && length >= 0) {
			payload = buffer.subarray(offset, offset + length);
			offset += length;
			if (buffer[offset] === 0x0a) offset++;
		} else {
			const implicit = readLine(buffer, offset);
			payload = Buffer.from(implicit.line, 'utf8');
			offset = implicit.next;
		}
		const textTypes = new Set(['event', 'transaction', 'session', 'sessions', 'client_report', 'check_in', 'feedback', 'user_report']);
		const type = typeof itemHeader.type === 'string' ? itemHeader.type : '';
		items.push({
			header: itemHeader,
			length: payload.length,
			...(textTypes.has(type) ? { text: payload.toString('utf8') } : { binary: true }),
		});
	}
	return { header, items };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function extractEventId(endpoint: string, text: string, envelope: { header: unknown; items: EnvelopeItem[] } | null): string | null {
	if (endpoint === 'store') {
		const event = parseJson(text) as { event_id?: unknown } | null;
		return typeof event?.event_id === 'string' ? event.event_id : null;
	}
	const header = envelope?.header as { event_id?: unknown } | null;
	if (typeof header?.event_id === 'string') return header.event_id;
	const eventItem = envelope?.items.find((item) => item.header.type === 'event');
	if (eventItem?.text) {
		const event = parseJson(eventItem.text) as { event_id?: unknown } | null;
		if (typeof event?.event_id === 'string') return event.event_id;
	}
	return null;
}

let sequence = 0;

const server = Bun.serve({
	port,
	hostname,
	async fetch(request) {
		const url = new URL(request.url);

		if (url.pathname === '/healthz') return json({ ok: true });
		if (url.pathname === '/' && request.method === 'GET') {
			return json({
				name: 'error-tracker harness sink',
				capturesDir,
				routes: [
					'POST /ingest/api/<project>/envelope/',
					'POST /ingest/api/<project>/store/',
					'POST /api/<project>/envelope/',
					'POST /api/<project>/store/',
					'GET /healthz',
				],
			});
		}

		const match = /^(?:\/ingest)?\/api\/([^/]+)\/(envelope|store)\/?$/.exec(url.pathname);
		if (!match) return json({ detail: 'not found' }, 404);
		const [, project, endpoint] = match;

		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers() });
		if (request.method !== 'POST') return json({ detail: 'method not allowed' }, 405);

		const raw = Buffer.from(await request.arrayBuffer());
		if (raw.length > 5 * 1024 * 1024) return json({ detail: 'payload too large' }, 413);

		const encoding = request.headers.get('content-encoding')?.toLowerCase() ?? '';
		let body: Buffer;
		try {
			body = encoding === 'gzip' ? Buffer.from(Bun.gunzipSync(raw)) : encoding === 'deflate' ? Buffer.from(Bun.inflateSync(raw)) : raw;
		} catch (error) {
			console.error(`[sink] could not decode ${encoding} body:`, error);
			return json({ detail: 'bad content encoding' }, 400);
		}

		const text = body.toString('utf8');
		const envelope = endpoint === 'envelope' ? parseEnvelope(body) : null;
		const eventId = extractEventId(endpoint, text, envelope);
		const receivedAt = new Date().toISOString();
		sequence++;
		const file = join(capturesDir, `${runId}-${String(sequence).padStart(3, '0')}-project-${project}-${endpoint}.json`);
		const capture = {
			receivedAt,
			project,
			endpoint,
			request: {
				method: request.method,
				url: request.url,
				headers: Object.fromEntries(request.headers.entries()),
			},
			contentEncoding: encoding || null,
			rawBase64: raw.toString('base64'),
			bodyText: text,
			...(endpoint === 'store' ? { event: parseJson(text) } : { envelope: envelope ?? undefined }),
		};
		await Bun.write(file, JSON.stringify(capture, null, 2));
		appendFileSync(
			manifestPath,
			JSON.stringify({
				file: basename(file),
				receivedAt,
				project,
				endpoint,
				eventId,
				bytes: raw.length,
				items: envelope?.items.map((item) => item.header.type ?? 'unknown') ?? [],
			}) + '\n',
		);

		console.log(
			`[sink] ${endpoint} project=${project} bytes=${raw.length} id=${eventId ?? '-'} -> ${basename(file)}` +
				(envelope ? ` items=${envelope.items.map((item) => item.header.type ?? '?').join(',')}` : ''),
		);

		return json({ id: eventId ?? crypto.randomUUID().replaceAll('-', '') });
	},
});

console.log(`[sink] listening on http://${hostname}:${server.port}`);
console.log(`[sink] captures -> ${capturesDir}`);
