import {
	NDJSON_CONTENT_TYPE,
	StudioError,
	applyResultSchema,
	studioOps,
	studioRequestSchemas,
	type ObjectRef,
	type StudioOp
} from '@skiff/studio/protocol';
import { STUDIO_SESSION_HEADER, STUDIO_TOKEN_HEADER, type Principal } from '@skiff/contracts';

/**
 * The control-plane hop of the native studio (plan 22): browser → here → internal gateway → the
 * node's studio front. It authenticates the dashboard user, validates the body against the
 * protocol, audits, adds the session token and streams the answer back untouched. The token
 * lives only in the upstream request headers: never in a response, a log line or an error.
 */

/** A `run`/`explain` body is at most 1 MiB of input; leave room for the JSON around it. */
export const STUDIO_MAX_BODY_BYTES = Math.floor(1.1 * 1_048_576);

/** What `core.databaseStudio.endpoint` returns: the values needed to dial one session. */
export interface StudioEndpoint {
	sessionId: string;
	token: string;
	host: string;
	nodeId: string;
	engine: string;
	readOnly: boolean;
	expiresAt: string;
}

/** Audit payloads; never raw SQL, commands or values. */
export type StudioActivity =
	| { op: 'run'; fingerprint: string; readOnly: boolean }
	| {
			op: 'apply';
			object: ObjectRef;
			inserted: number;
			updated: number;
			deleted: number;
			applied: number;
	  };

export interface StudioProxyDeps {
	/** False when `DB_STUDIO` is off; every call is then a 404. */
	enabled: () => boolean;
	studio: {
		endpoint(principal: Principal, name: string): StudioEndpoint;
		recordActivity(principal: Principal, name: string, activity: StudioActivity): void;
	};
	/** Loopback port of the edge's internal database gateway (`SKIFF_DATABASE_GATEWAY_PORT`). */
	gatewayPort: () => number;
	fingerprint: (input: string) => string;
	fetch?: typeof fetch;
}

export interface StudioProxyCall {
	principal: Principal | undefined;
	name: string;
	op: string;
	request: Request;
}

const BASE_HEADERS = {
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff'
} as const;

export function studioErrorResponse(error: StudioError): Response {
	return new Response(JSON.stringify(error.toBody()), {
		status: error.status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS }
	});
}

function isStudioOp(op: string): op is StudioOp {
	return (studioOps as readonly string[]).includes(op);
}

/**
 * Map an error from `core.databaseStudio` onto the protocol's codes. Core and contracts each have
 * their own error classes, so match on `status` and `name` rather than `instanceof`.
 */
export function studioErrorFromCore(caught: unknown): StudioError | null {
	if (caught instanceof StudioError) return caught;
	if (!(caught instanceof Error)) return null;
	const status = (caught as { status?: unknown }).status;
	const message = caught.message || 'The studio request was refused.';
	if (caught.name === 'ForbiddenError' || status === 403)
		return new StudioError('forbidden', message);
	if (status === 401) return new StudioError('unauthorized', message);
	if (status === 404) return new StudioError('not_found', message);
	if (status === 409 || status === 410)
		return /expired/i.test(message)
			? new StudioError('session_expired', message)
			: new StudioError('conflict', message);
	if (status === 400 || status === 422) return new StudioError('bad_request', message);
	return null;
}

/** Read at most `max` bytes of the body; `null` when it is larger. */
async function readCapped(request: Request, max: number): Promise<string | null> {
	const declared = Number(request.headers.get('content-length') ?? '');
	if (Number.isFinite(declared) && declared > max) return null;
	if (!request.body) return '';
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function applyCounts(changes: Array<{ op: 'insert' | 'update' | 'delete' }>) {
	let inserted = 0;
	let updated = 0;
	let deleted = 0;
	for (const change of changes) {
		if (change.op === 'insert') inserted += 1;
		else if (change.op === 'update') updated += 1;
		else deleted += 1;
	}
	return { inserted, updated, deleted };
}

function responseHeaders(upstream: Response): Headers {
	// Fresh headers: nothing from upstream (set-cookie, hop-by-hop, the token) leaks through.
	const headers = new Headers(BASE_HEADERS);
	const type = upstream.headers.get('content-type');
	if (type !== null) headers.set('content-type', type);
	// Results stream: an edge proxy must not hold them back.
	if ((type ?? '').startsWith(NDJSON_CONTENT_TYPE)) headers.set('x-accel-buffering', 'no');
	return headers;
}

/** Handle `POST /databases/<name>/studio/api/<op>`. */
export async function handleStudioCall(
	deps: StudioProxyDeps,
	call: StudioProxyCall
): Promise<Response> {
	try {
		return await proxy(deps, call);
	} catch (caught) {
		const mapped = studioErrorFromCore(caught);
		if (mapped) return studioErrorResponse(mapped);
		// Log the class only: an error message could quote request data.
		console.error('[studio] proxy failed:', caught instanceof Error ? caught.name : typeof caught);
		return studioErrorResponse(new StudioError('internal', 'The studio request failed.'));
	}
}

async function proxy(deps: StudioProxyDeps, call: StudioProxyCall): Promise<Response> {
	const { principal, name, op, request } = call;
	if (request.method !== 'POST')
		return studioErrorResponse(
			new StudioError('bad_request', 'Studio calls are POST requests.', 405)
		);
	if (!principal)
		return studioErrorResponse(new StudioError('unauthorized', 'Sign in to use the studio.'));
	// The studio is a human surface (D96): an API key must never reuse a user's open session.
	if (principal.kind !== 'user')
		return studioErrorResponse(
			new StudioError('forbidden', 'The database studio needs an interactive user session.')
		);
	if (!deps.enabled() || !isStudioOp(op))
		return studioErrorResponse(new StudioError('not_found', 'Unknown studio call.'));

	const raw = await readCapped(request, STUDIO_MAX_BODY_BYTES);
	if (raw === null)
		return studioErrorResponse(
			new StudioError('bad_request', 'The request body is too large.', 413)
		);
	let decoded: unknown;
	try {
		decoded = JSON.parse(raw || '{}');
	} catch {
		return studioErrorResponse(new StudioError('bad_request', 'The request body must be JSON.'));
	}
	const parsed = studioRequestSchemas[op].safeParse(decoded);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
		return studioErrorResponse(
			new StudioError('bad_request', `${where}${issue?.message ?? 'Invalid request.'}`)
		);
	}
	// Only re-serialised, schema-checked protocol reaches the node.
	const body = JSON.stringify(parsed.data);

	const endpoint = deps.studio.endpoint(principal, name);

	if (op === 'apply' && endpoint.readOnly)
		return studioErrorResponse(
			new StudioError(
				'read_only',
				'This studio session is read-only. Enable writes to apply changes.'
			)
		);

	if (op === 'run') {
		const { input } = parsed.data as { input: string };
		deps.studio.recordActivity(principal, name, {
			op: 'run',
			fingerprint: deps.fingerprint(input),
			readOnly: endpoint.readOnly
		});
	}

	const headers = new Headers({
		// Bun's fetch honours an explicit Host, which the gateway routes on.
		host: endpoint.host,
		'content-type': 'application/json',
		// Never let the gateway compress: the body is forwarded untouched.
		'accept-encoding': 'identity',
		[STUDIO_SESSION_HEADER]: endpoint.sessionId,
		[STUDIO_TOKEN_HEADER]: endpoint.token
	});

	const doFetch = deps.fetch ?? fetch;
	let upstream: Response;
	try {
		upstream = await doFetch(`http://127.0.0.1:${deps.gatewayPort()}/v1/${op}`, {
			method: 'POST',
			headers,
			body,
			redirect: 'manual',
			// A browser abort (Stop, closed tab) cancels the query on the node.
			signal: request.signal
		});
	} catch {
		if (request.signal.aborted)
			return studioErrorResponse(new StudioError('cancelled', 'The request was cancelled.'));
		return studioErrorResponse(
			new StudioError('studio_unavailable', 'The database studio is unavailable on its node.')
		);
	}

	if (op === 'apply' && upstream.status === 200) {
		const text = await upstream.text();
		let result: { applied: number } | null = null;
		try {
			const checked = applyResultSchema.safeParse(JSON.parse(text));
			if (checked.success) result = checked.data;
		} catch {
			// Not JSON: pass it through; the client reports it.
		}
		if (result) {
			const { object, changes } = parsed.data as {
				object: ObjectRef;
				changes: Array<{ op: 'insert' | 'update' | 'delete' }>;
			};
			try {
				deps.studio.recordActivity(principal, name, {
					op: 'apply',
					object,
					...applyCounts(changes),
					applied: result.applied
				});
			} catch (caught) {
				// The write already happened on the node; still answer the browser.
				console.error(
					'[studio] apply audit failed:',
					caught instanceof Error ? caught.name : caught
				);
			}
		}
		return new Response(text, { status: upstream.status, headers: responseHeaders(upstream) });
	}

	const passthrough = upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
	return new Response(passthrough, { status: upstream.status, headers: responseHeaders(upstream) });
}
