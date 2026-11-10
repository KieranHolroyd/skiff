import { timingSafeEqual } from 'node:crypto';
import {
	USAGE_ANALYTICS_INGEST_PATH,
	USAGE_ANALYTICS_MAX_BODY_BYTES,
	usagePingSchema,
	type UsagePing
} from '@yoal/contracts';
import type { UsageStats, UsageStore } from './store.ts';

/**
 * The collector's HTTP surface (docs/USAGE-ANALYTICS.md).
 *
 * `POST /api/v1/ping` is the only public write. It accepts exactly the schema in
 * `@yoal/contracts`, so a field the sender adds by accident is refused rather than stored. There
 * is no CORS header: no browser is supposed to post here, and a page that finds the endpoint
 * cannot make a visitor's browser look like an install.
 *
 * `GET /api/v1/stats` is the operator view and answers 404 unless `YOAL_USAGE_ADMIN_TOKEN` is set
 * and presented as a bearer token. `GET /healthz` and `GET /` are unauthenticated and contain no
 * stored data.
 */

export interface UsageHttpOptions {
	store: UsageStore;
	/** The collector's own version, for `/healthz`. */
	version?: string;
	adminToken?: string | null;
	/** Behind Caddy, read the client address from `X-Forwarded-For`. */
	trustProxy?: boolean;
	now?: () => number;
	/** Injectable so tests can prove the limit without sleeping. */
	limiter?: RateLimiter;
	log?: (message: string) => void;
}

const JSON_HEADERS = {
	'content-type': 'application/json; charset=utf-8',
	'cache-control': 'no-store'
} as const;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

/** Fixed-window limiter: cheap, and enough to stop a runaway sender or a script. */
export class RateLimiter {
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #buckets = new Map<string, { count: number; resetAt: number }>();

	constructor(limit = 60, windowMs = 60_000) {
		this.#limit = limit;
		this.#windowMs = windowMs;
	}

	/** True when the request may proceed. */
	take(key: string, now: number): boolean {
		if (this.#buckets.size > 10_000) {
			for (const [bucketKey, bucket] of this.#buckets) {
				if (bucket.resetAt <= now) this.#buckets.delete(bucketKey);
			}
		}
		const bucket = this.#buckets.get(key);
		if (!bucket || bucket.resetAt <= now) {
			this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs });
			return true;
		}
		if (bucket.count >= this.#limit) return false;
		bucket.count += 1;
		return true;
	}
}

/** One limiter per process, so a caller that does not pass one still gets the protection. */
const defaultLimiter = new RateLimiter();

/** The address a rate-limit bucket is keyed by. Never stored. */
export function clientAddress(request: Request, trustProxy: boolean): string {
	if (trustProxy) {
		const forwarded = request.headers.get('x-forwarded-for');
		const first = forwarded?.split(',')[0]?.trim();
		if (first) return first;
	}
	return request.headers.get('x-real-ip') ?? 'unknown';
}

function safeTokenEqual(given: string, expected: string): boolean {
	const left = Buffer.from(given);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function authorized(request: Request, token: string | null | undefined): boolean {
	if (!token) return false;
	const header = request.headers.get('authorization') ?? '';
	const prefix = 'Bearer ';
	if (!header.startsWith(prefix)) return false;
	return safeTokenEqual(header.slice(prefix.length).trim(), token);
}

/** Read at most `limit` bytes, before any JSON parsing. */
async function readBody(request: Request, limit: number): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
	const declared = Number(request.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > limit)
		return { ok: false, response: json({ error: 'body_too_large' }, 413) };
	const buffer = new Uint8Array(await request.arrayBuffer());
	if (buffer.byteLength > limit) return { ok: false, response: json({ error: 'body_too_large' }, 413) };
	try {
		return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buffer) };
	} catch {
		return { ok: false, response: json({ error: 'invalid_encoding' }, 400) };
	}
}

export async function handleUsageRequest(
	request: Request,
	options: UsageHttpOptions
): Promise<Response> {
	const now = options.now ?? Date.now;
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === '/healthz') {
		if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
		return json({ ok: true, version: options.version ?? null });
	}

	if (path === '/' || path === '') {
		if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
		return json({
			name: 'Yoal usage analytics',
			description:
				'Anonymous, opt-in usage pings from self-hosted Yoal installs. The collector and the protocol are open source in the Yoal repository.',
			ingest: USAGE_ANALYTICS_INGEST_PATH,
			docs: 'https://github.com/KieranHolroyd/yoal/blob/main/docs/USAGE-ANALYTICS.md'
		});
	}

	if (path === '/api/v1/stats') {
		if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { allow: 'GET' });
		// Without a configured token the operator view does not exist at all.
		if (!options.adminToken) return json({ error: 'not_found' }, 404);
		if (!authorized(request, options.adminToken)) return json({ error: 'unauthorized' }, 401);
		const days = Number(url.searchParams.get('days') ?? '30');
		const window = Number.isInteger(days) && days >= 1 && days <= 400 ? days : 30;
		const stats: UsageStats = options.store.stats(now(), window);
		return json(stats);
	}

	if (path !== USAGE_ANALYTICS_INGEST_PATH) return json({ error: 'not_found' }, 404);
	if (request.method !== 'POST')
		return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });

	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.toLowerCase().startsWith('application/json'))
		return json({ error: 'unsupported_media_type' }, 415);

	const limiter = options.limiter ?? defaultLimiter;
	if (!limiter.take(clientAddress(request, options.trustProxy ?? true), now()))
		return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });

	const body = await readBody(request, USAGE_ANALYTICS_MAX_BODY_BYTES);
	if (!body.ok) return body.response;

	let raw: unknown;
	try {
		raw = JSON.parse(body.text);
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}
	const parsed = usagePingSchema.safeParse(raw);
	if (!parsed.success) {
		// Never echo the payload back: it is not ours to repeat, and it might be personal data.
		options.log?.(`refused a ping: ${parsed.error.issues[0]?.path.join('.') ?? 'schema'}`);
		return json({ error: 'invalid_ping', issues: parsed.error.issues.length }, 400);
	}

	const ping: UsagePing = parsed.data;
	const { stored } = options.store.record(ping, now());
	if (stored) options.log?.(`stored a ping from ${installHint(ping.installId)} (${ping.version})`);
	return json({ ok: true, duplicate: !stored }, 202);
}

/** A short, non-reversible hint for logs; the full id is never logged. */
function installHint(installId: string): string {
	return `${installId.slice(0, 6)}…`;
}
