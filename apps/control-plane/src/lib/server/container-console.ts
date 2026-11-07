import {
	CONTAINER_CONSOLE_TOKEN_HEADER,
	containerConsoleLimits,
	containerExecIdPattern,
	containerExecOpenSchema,
	containerExecResizeSchema,
	containerPathSchema,
	type ContainerConsoleScope,
	type Principal
} from '@skiff/contracts';
import type { ContainerConsoleActivity, ContainerConsoleEndpoint } from '@skiff/core';
import { ForbiddenError } from '@skiff/contracts';

/**
 * The control-plane hop of the container console (D127): browser → here → internal gateway →
 * the node's console front → the helper. It authenticates the dashboard user, checks the scope,
 * audits shells and file reads, adds the console token and streams the answer back untouched.
 * The token lives only in upstream request headers: never in a response or a log line.
 */

export interface ContainerConsoleDeps {
	console: {
		enabled(): boolean;
		endpoint(
			principal: Principal,
			slug: string,
			scope: ContainerConsoleScope,
			replica: number | null
		): ContainerConsoleEndpoint;
		targets(principal: Principal, slug: string): unknown[];
		record(principal: Principal, slug: string, activity: ContainerConsoleActivity): void;
		restart(principal: Principal, slug: string): { generation: number };
	};
	/** Loopback port of the edge's internal gateway (`SKIFF_DATABASE_GATEWAY_PORT`). */
	gatewayPort: () => number;
	fetch?: typeof fetch;
	now?: () => number;
}

export interface ContainerConsoleCall {
	principal: Principal | undefined;
	slug: string;
	/** The path after `/container/`, e.g. `inspect`, `files/download`, `exec/cx_…/stream`. */
	op: string;
	request: Request;
	url: URL;
}

const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

/** Tokens are reused for a few minutes so the node pulls one activation per page, not per key. */
const tokenCache = new Map<string, ContainerConsoleEndpoint>();
const TOKEN_REUSE_MARGIN_MS = 60_000;

export function consoleError(status: number, message: string, code = 'console_error'): Response {
	return Response.json({ error: code, message }, { status, headers: NO_STORE });
}

export async function handleContainerConsole(
	deps: ContainerConsoleDeps,
	call: ContainerConsoleCall
): Promise<Response> {
	const { principal, slug, request, url } = call;
	if (!principal) return consoleError(401, 'Sign in to use the container console.', 'unauthorized');
	if (!deps.console.enabled())
		return consoleError(404, 'The container console is disabled.', 'not_found');
	const method = request.method;
	const op = call.op.replace(/^\/+|\/+$/g, '');
	const replicaParam = url.searchParams.get('replica');
	const replica = replicaParam === null || replicaParam === '' ? null : Number(replicaParam);
	if (replica !== null && (!Number.isInteger(replica) || replica < 0 || replica > 999))
		return consoleError(400, 'replica must be a replica index.', 'bad_request');

	try {
		if (op === 'restart') {
			if (method !== 'POST') return methodNotAllowed('POST');
			const result = deps.console.restart(principal, slug);
			return Response.json(
				{
					ok: true,
					generation: result.generation,
					message: 'Restart requested. The node restarts the container on its next reconcile.'
				},
				{ headers: NO_STORE }
			);
		}

		if (op === 'targets') {
			if (method !== 'GET') return methodNotAllowed('GET');
			return Response.json(
				{ targets: deps.console.targets(principal, slug) },
				{ headers: NO_STORE }
			);
		}

		if (op === 'inspect') {
			if (method !== 'GET') return methodNotAllowed('GET');
			const upstream = await upstreamFetch(
				deps,
				principal,
				slug,
				'inspect',
				replica,
				'/v1/inspect',
				{ signal: request.signal }
			);
			if (!upstream.ok) return relayError(upstream);
			const body = (await upstream.json()) as { container?: unknown };
			return Response.json(
				{ targets: deps.console.targets(principal, slug), container: body.container ?? null },
				{ headers: NO_STORE }
			);
		}

		if (op === 'files' || op === 'files/preview' || op === 'files/download') {
			if (method !== 'GET') return methodNotAllowed('GET');
			const parsed = containerPathSchema.safeParse(url.searchParams.get('path') ?? '/');
			if (!parsed.success)
				return consoleError(400, 'path must be an absolute path.', 'bad_request');
			const path = parsed.data;
			const upstream = await upstreamFetch(
				deps,
				principal,
				slug,
				'files',
				replica,
				`/v1/${op}?path=${encodeURIComponent(path)}`,
				{ signal: request.signal }
			);
			if (!upstream.ok) return relayError(upstream);
			if (op === 'files') return relayJson(upstream, 'listing');
			if (op === 'files/preview') {
				deps.console.record(principal, slug, { op: 'files.read', path, replica });
				return relayJson(upstream, 'preview');
			}
			// `Number(null)` is 0, so a chunked answer with no length must stay null: copying a
			// bogus 0 onto the response would truncate the download.
			const declaredLength = upstream.headers.get('content-length');
			const size = declaredLength === null ? null : Number(declaredLength);
			const knownSize = size !== null && Number.isFinite(size) && size >= 0;
			deps.console.record(principal, slug, {
				op: 'files.download',
				path,
				sizeBytes: knownSize ? size : null,
				replica
			});
			const name = safeFileName(
				decodeHeader(upstream.headers.get('x-skiff-file-name')) ?? 'download'
			);
			return new Response(upstream.body, {
				headers: {
					...NO_STORE,
					'content-type': 'application/octet-stream',
					...(knownSize ? { 'content-length': String(size) } : {}),
					'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`
				}
			});
		}

		if (op === 'exec') {
			if (method !== 'POST') return methodNotAllowed('POST');
			const parsed = containerExecOpenSchema.safeParse(await request.json().catch(() => ({})));
			if (!parsed.success) return consoleError(400, 'Invalid shell options.', 'bad_request');
			const upstream = await upstreamFetch(deps, principal, slug, 'exec', replica, '/v1/exec', {
				method: 'POST',
				body: JSON.stringify(parsed.data),
				contentType: 'application/json',
				signal: request.signal
			});
			if (!upstream.ok) return relayError(upstream);
			deps.console.record(principal, slug, {
				op: 'exec.open',
				shell: parsed.data.shell,
				user: parsed.data.user,
				replica
			});
			return relayJson(upstream, 'exec');
		}

		const exec = /^exec\/([^/]+)(?:\/(stream|input|resize))?$/.exec(op);
		if (exec) {
			const execId = exec[1]!;
			if (!containerExecIdPattern.test(execId))
				return consoleError(400, 'Malformed shell id.', 'bad_request');
			const verb = exec[2];
			const base = `/v1/exec/${execId}`;
			if (!verb) {
				if (method !== 'DELETE') return methodNotAllowed('DELETE');
				const upstream = await upstreamFetch(deps, principal, slug, 'exec', replica, base, {
					method: 'DELETE'
				});
				if (upstream.ok) deps.console.record(principal, slug, { op: 'exec.close', replica });
				return upstream.ok ? relayJson(upstream, null) : relayError(upstream);
			}
			if (verb === 'stream') {
				if (method !== 'GET') return methodNotAllowed('GET');
				const after = url.searchParams.get('after') ?? request.headers.get('last-event-id');
				const upstream = await upstreamFetch(
					deps,
					principal,
					slug,
					'exec',
					replica,
					`${base}/stream${after && /^\d+$/.test(after) ? `?after=${after}` : ''}`,
					{ signal: request.signal }
				);
				if (!upstream.ok) return relayError(upstream);
				return new Response(upstream.body, {
					headers: {
						...NO_STORE,
						'content-type': 'text/event-stream',
						connection: 'keep-alive',
						'x-accel-buffering': 'no'
					}
				});
			}
			if (method !== 'POST') return methodNotAllowed('POST');
			if (verb === 'input') {
				const bytes = new Uint8Array(await request.arrayBuffer());
				if (bytes.length > containerConsoleLimits.execInputBytes)
					return consoleError(413, 'Input is too large.', 'too_large');
				const upstream = await upstreamFetch(
					deps,
					principal,
					slug,
					'exec',
					replica,
					`${base}/input`,
					{
						method: 'POST',
						body: bytes,
						contentType: 'application/octet-stream'
					}
				);
				return upstream.ok ? relayJson(upstream, null) : relayError(upstream);
			}
			const parsed = containerExecResizeSchema.safeParse(await request.json().catch(() => null));
			if (!parsed.success) return consoleError(400, 'Invalid terminal size.', 'bad_request');
			const upstream = await upstreamFetch(
				deps,
				principal,
				slug,
				'exec',
				replica,
				`${base}/resize`,
				{
					method: 'POST',
					body: JSON.stringify(parsed.data),
					contentType: 'application/json'
				}
			);
			return upstream.ok ? relayJson(upstream, null) : relayError(upstream);
		}

		return consoleError(404, 'No such console endpoint.', 'not_found');
	} catch (error) {
		return errorResponse(error);
	}
}

async function upstreamFetch(
	deps: ContainerConsoleDeps,
	principal: Principal,
	slug: string,
	scope: ContainerConsoleScope,
	replica: number | null,
	path: string,
	init: {
		method?: string;
		body?: string | Uint8Array<ArrayBuffer>;
		contentType?: string;
		signal?: AbortSignal;
	}
): Promise<Response> {
	const endpoint = cachedEndpoint(deps, principal, slug, scope, replica);
	const doFetch = deps.fetch ?? fetch;
	try {
		return await doFetch(`http://127.0.0.1:${deps.gatewayPort()}${path}`, {
			method: init.method ?? 'GET',
			headers: {
				host: endpoint.host,
				[CONTAINER_CONSOLE_TOKEN_HEADER]: endpoint.token,
				...(init.contentType ? { 'content-type': init.contentType } : {})
			},
			...(init.body !== undefined ? { body: init.body } : {}),
			...(init.signal ? { signal: init.signal } : {})
		});
	} catch (error) {
		if (init.signal?.aborted) throw error;
		throw new UpstreamUnavailable();
	}
}

/** One token per user, project, replica and scope set, reused until a minute before it expires. */
function cachedEndpoint(
	deps: ContainerConsoleDeps,
	principal: Principal,
	slug: string,
	scope: ContainerConsoleScope,
	replica: number | null
): ContainerConsoleEndpoint {
	const now = (deps.now ?? Date.now)();
	// Permissions and the target are re-checked on every call: minting does that, so only the
	// token is cached, keyed by everything that shapes it.
	const fresh = deps.console.endpoint(principal, slug, scope, replica);
	const key = [
		principal.orgId,
		principal.userId,
		principal.kind,
		slug,
		replica ?? '-',
		fresh.desiredId,
		fresh.nodeId,
		fresh.scopes.join(',')
	].join('|');
	const cached = tokenCache.get(key);
	if (cached && cached.expiresAt - TOKEN_REUSE_MARGIN_MS > now) return cached;
	tokenCache.set(key, fresh);
	if (tokenCache.size > 1_000) {
		for (const [entry, value] of tokenCache) if (value.expiresAt <= now) tokenCache.delete(entry);
	}
	return fresh;
}

class UpstreamUnavailable extends Error {}

function errorResponse(error: unknown): Response {
	if (error instanceof UpstreamUnavailable)
		return consoleError(
			502,
			'The node could not be reached through the internal gateway. Check that it is online.',
			'node_unreachable'
		);
	if (error instanceof ForbiddenError) return consoleError(403, error.message, 'forbidden');
	if (error instanceof Error && error.name === 'AbortError')
		return consoleError(499, 'Cancelled.', 'cancelled');
	const status = (error as { status?: unknown }).status;
	const message = error instanceof Error ? error.message : 'The container console failed.';
	if (typeof status === 'number' && status >= 400 && status < 600)
		return consoleError(status, message);
	return consoleError(500, 'The container console failed.');
}

/** Node and helper errors are small JSON with `message` or `error`; pass the text on. */
async function relayError(upstream: Response): Promise<Response> {
	const text = await upstream.text().catch(() => '');
	let message = `The node answered ${upstream.status}.`;
	try {
		const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
		if (typeof parsed.message === 'string') message = parsed.message;
		else if (typeof parsed.error === 'string') message = parsed.error;
	} catch {
		// Not JSON (a gateway error page): keep the generic message.
	}
	const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
	return consoleError(status, message);
}

async function relayJson(upstream: Response, field: string | null): Promise<Response> {
	const body = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
	return Response.json(field ? { [field]: body[field] ?? null } : { ok: true }, {
		headers: NO_STORE
	});
}

function methodNotAllowed(allow: string): Response {
	return new Response(JSON.stringify({ error: 'method_not_allowed', message: `Use ${allow}.` }), {
		status: 405,
		headers: { ...NO_STORE, allow, 'content-type': 'application/json' }
	});
}

function decodeHeader(value: string | null): string | null {
	if (!value) return null;
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function safeFileName(name: string): string {
	const cleaned = name.replace(/[/\\\0"\r\n]/g, '_').slice(0, 200);
	return cleaned || 'download';
}

/**
 * Run one console call in-process and return its JSON body (MCP tools and the assistant).
 * Throws the console's own message on a refusal, so callers surface it unchanged.
 */
export async function consoleJson<T>(
	deps: ContainerConsoleDeps,
	principal: Principal,
	slug: string,
	op: string,
	query: Record<string, string | number | null | undefined> = {}
): Promise<T> {
	const url = new URL(
		`http://control.internal/projects/${encodeURIComponent(slug)}/container/${op}`
	);
	for (const [key, value] of Object.entries(query))
		if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
	const response = await handleContainerConsole(deps, {
		principal,
		slug,
		op,
		request: new Request(url, { method: op === 'restart' ? 'POST' : 'GET' }),
		url
	});
	const body = (await response.json().catch(() => ({}))) as T & { message?: string };
	if (!response.ok)
		throw new Error(body.message ?? `The container console answered ${response.status}.`);
	return body;
}
