/**
 * The agent's container console front (D127). It listens on one loopback port per node, reached
 * only through the internal gateway (D82/D96), and does three things: checks the console token
 * by pulling its activation from the control plane, maps a fixed set of calls onto the helper's
 * `/v1/containers/<id>/…` verbs for the one workload the token names, and passes the bodies
 * through untouched so shell output and downloads stream.
 *
 * Shell sessions are bound to the user who opened them: another user's token for the same
 * workload cannot read or type into them.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
	CONTAINER_CONSOLE_TOKEN_HEADER,
	containerConsoleActivationSchema,
	containerExecIdPattern,
	type ContainerConsoleActivation,
	type ContainerConsoleScope,
	type NodeContainerConsoleDesired,
} from '@yoal/contracts';

export type FetchConsoleActivation = (token: string, signal?: AbortSignal) => Promise<ContainerConsoleActivation>;

export interface ConsoleHelper {
	containerConsole(
		path: string,
		init?: { method?: string; body?: string | Uint8Array | ReadableStream<Uint8Array> | null; contentType?: string; lastEventId?: string; signal?: AbortSignal },
	): Promise<Response>;
}

export interface ConsoleFrontOptions {
	fetchActivation: FetchConsoleActivation;
	helper: ConsoleHelper;
	now?: () => number;
	hostname?: string;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Refusals carry a status the control plane maps onto its own answer. */
export class ConsoleRefusal extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

interface CachedActivation {
	activation: ContainerConsoleActivation;
	tokenHash: Buffer;
	expiresAt: number;
}

const MAX_CACHED = 500;
const MAX_INPUT_BYTES = 64 * 1024;
const JSON_BODY_BYTES = 4 * 1024;

export class ConsoleFront {
	private readonly fetchActivation: FetchConsoleActivation;
	private readonly helper: ConsoleHelper;
	private readonly now: () => number;
	private readonly hostname: string;
	private readonly log: NonNullable<ConsoleFrontOptions['log']>;
	private server: ReturnType<typeof Bun.serve> | null = null;
	private desiredPort: number | null = null;
	private readonly cache = new Map<string, CachedActivation>();
	/** execId → who opened it, on which workload. */
	private readonly owners = new Map<string, { workloadId: string; userId: string; openedAt: number }>();

	constructor(options: ConsoleFrontOptions) {
		this.fetchActivation = options.fetchActivation;
		this.helper = options.helper;
		this.now = options.now ?? Date.now;
		this.hostname = options.hostname ?? '127.0.0.1';
		this.log = options.log ?? (() => undefined);
	}

	get port(): number | null {
		return this.server?.port ?? null;
	}

	update(desired: NodeContainerConsoleDesired | null): void {
		const port = desired?.port ?? null;
		if (port === this.desiredPort && (port === null) === (this.server === null)) return;
		if (this.server) {
			this.server.stop(true);
			this.server = null;
			this.log('info', 'Container console front stopped');
		}
		this.desiredPort = port;
		if (port === null) {
			this.cache.clear();
			return;
		}
		this.server = Bun.serve({
			hostname: this.hostname,
			port,
			// Shell output streams for as long as the shell is open.
			idleTimeout: 0,
			fetch: (request, server) => {
				server.timeout(request, 0);
				return this.handle(request);
			},
		});
		this.log('info', `Container console front listening on ${this.hostname}:${this.server.port}`);
	}

	stop(): void {
		this.update(null);
	}

	async handle(request: Request): Promise<Response> {
		try {
			return await this.route(request);
		} catch (error) {
			if (error instanceof ConsoleRefusal) return refusal(error.status, error.code, error.message);
			this.log('error', `Container console front: ${errorText(error)}`);
			return refusal(502, 'console_unavailable', 'The node could not reach its container helper.');
		}
	}

	private async route(request: Request): Promise<Response> {
		const token = request.headers.get(CONTAINER_CONSOLE_TOKEN_HEADER);
		if (!token) throw new ConsoleRefusal(401, 'unauthorized', 'A console token is required.');
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		if (path === '/v1/inspect') {
			const activation = await this.authorize(token, 'inspect');
			requireMethod(method, 'GET');
			return this.forward(activation, '', { signal: request.signal });
		}

		if (path === '/v1/files' || path === '/v1/files/preview' || path === '/v1/files/download') {
			const activation = await this.authorize(token, 'files');
			requireMethod(method, 'GET');
			const target = url.searchParams.get('path') ?? '/';
			const suffix = path.slice('/v1/'.length);
			return this.forward(activation, `/${suffix}?path=${encodeURIComponent(target)}`, { signal: request.signal });
		}

		if (path === '/v1/exec') {
			const activation = await this.authorize(token, 'exec');
			requireMethod(method, 'POST');
			const body = await boundedText(request, JSON_BODY_BYTES);
			const response = await this.helper.containerConsole(this.base(activation, '/exec'), {
				method: 'POST',
				body,
				contentType: 'application/json',
				signal: request.signal,
			});
			const text = await response.text();
			if (response.ok) {
				const execId = (JSON.parse(text) as { exec?: { execId?: unknown } }).exec?.execId;
				if (typeof execId === 'string')
					this.owners.set(execId, { workloadId: activation.workloadId, userId: activation.userId, openedAt: this.now() });
				this.pruneOwners();
			}
			return passthrough(text, response);
		}

		const exec = /^\/v1\/exec\/([^/]+)(?:\/(stream|input|resize))?$/.exec(path);
		if (exec) {
			const activation = await this.authorize(token, 'exec');
			const execId = exec[1]!;
			if (!containerExecIdPattern.test(execId)) throw new ConsoleRefusal(400, 'bad_request', 'Malformed shell id.');
			const owner = this.owners.get(execId);
			if (!owner || owner.workloadId !== activation.workloadId || owner.userId !== activation.userId)
				throw new ConsoleRefusal(404, 'unknown_shell', 'No such shell session.');
			const verb = exec[2];
			const suffix = `/exec/${execId}${verb ? `/${verb}` : ''}`;
			if (!verb) {
				requireMethod(method, 'DELETE');
				this.owners.delete(execId);
				return this.forward(activation, suffix, { method: 'DELETE', signal: request.signal });
			}
			if (verb === 'stream') {
				requireMethod(method, 'GET');
				const after = url.searchParams.get('after');
				return this.forward(activation, `${suffix}${after ? `?after=${encodeURIComponent(after)}` : ''}`, {
					signal: request.signal,
					lastEventId: request.headers.get('last-event-id') ?? undefined,
				});
			}
			requireMethod(method, 'POST');
			const body = verb === 'input' ? await boundedBytes(request, MAX_INPUT_BYTES) : await boundedText(request, JSON_BODY_BYTES);
			return this.forward(activation, suffix, {
				method: 'POST',
				body,
				contentType: verb === 'input' ? 'application/octet-stream' : 'application/json',
				signal: request.signal,
			});
		}

		throw new ConsoleRefusal(404, 'not_found', 'No such console endpoint.');
	}

	private base(activation: ContainerConsoleActivation, suffix: string): string {
		return `/v1/containers/${encodeURIComponent(activation.workloadId)}${suffix}`;
	}

	private async forward(
		activation: ContainerConsoleActivation,
		suffix: string,
		init: { method?: string; body?: string | Uint8Array | ReadableStream<Uint8Array> | null; contentType?: string; lastEventId?: string; signal?: AbortSignal },
	): Promise<Response> {
		const upstream = await this.helper.containerConsole(this.base(activation, suffix), init);
		return passthrough(upstream.body, upstream);
	}

	/** The cached activation when the token matches, otherwise a fresh one; checks the scope. */
	private async authorize(token: string, scope: ContainerConsoleScope): Promise<ContainerConsoleActivation> {
		const tokenHash = sha256(token);
		const key = tokenHash.toString('hex');
		let cached = this.cache.get(key);
		if (!cached || this.now() >= cached.expiresAt || !timingSafeEqual(cached.tokenHash, tokenHash)) {
			let activation: ContainerConsoleActivation;
			try {
				activation = await this.fetchActivation(token);
			} catch (error) {
				if (error instanceof ConsoleRefusal) throw error;
				this.log('warn', `Console activation fetch failed: ${errorText(error)}`);
				throw new ConsoleRefusal(503, 'console_unavailable', 'The token could not be verified with the control plane.');
			}
			const expiresAt = Date.parse(activation.expiresAt);
			if (Number.isNaN(expiresAt) || this.now() >= expiresAt)
				throw new ConsoleRefusal(401, 'token_expired', 'The console token has expired.');
			cached = { activation, tokenHash, expiresAt };
			this.cache.set(key, cached);
			this.pruneCache();
		}
		if (!cached.activation.scopes.includes(scope))
			throw new ConsoleRefusal(403, 'forbidden', `This console token does not allow ${scope}.`);
		return cached.activation;
	}

	private pruneCache(): void {
		const now = this.now();
		for (const [key, entry] of this.cache) if (entry.expiresAt <= now) this.cache.delete(key);
		while (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
	}

	/** The helper closes shells after at most 8 h; forget owners well after that. */
	private pruneOwners(): void {
		const cutoff = this.now() - 9 * 60 * 60_000;
		for (const [id, owner] of this.owners) if (owner.openedAt < cutoff) this.owners.delete(id);
	}
}

/** `GET /api/agent/container-console` with the node bearer and the console token. */
export function controlPlaneConsoleActivationFetcher(options: {
	controlUrl: string;
	nodeToken: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}): FetchConsoleActivation {
	const fetchImpl = options.fetch ?? fetch;
	return async (token, signal) => {
		const signals = [AbortSignal.timeout(10_000)];
		if (signal) signals.push(signal);
		if (options.signal) signals.push(options.signal);
		const response = await fetchImpl(`${options.controlUrl}/api/agent/container-console`, {
			headers: {
				authorization: `Bearer ${options.nodeToken}`,
				accept: 'application/json',
				[CONTAINER_CONSOLE_TOKEN_HEADER]: token,
			},
			signal: AbortSignal.any(signals),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 409)
				throw new ConsoleRefusal(response.status === 409 ? 409 : 403, 'forbidden', messageOf(text) ?? 'The console token was refused.');
			throw new Error(`container console activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
		}
		const parsed = containerConsoleActivationSchema.safeParse(await response.json());
		if (!parsed.success) throw new Error(`container console activation failed validation: ${parsed.error.message}`);
		return parsed.data;
	};
}

function requireMethod(actual: string, expected: string): void {
	if (actual !== expected) throw new ConsoleRefusal(405, 'method_not_allowed', `Use ${expected}.`);
}

async function boundedText(request: Request, max: number): Promise<string> {
	const text = await request.text();
	if (Buffer.byteLength(text) > max) throw new ConsoleRefusal(413, 'too_large', 'The request body is too large.');
	return text;
}

async function boundedBytes(request: Request, max: number): Promise<Uint8Array> {
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.length > max) throw new ConsoleRefusal(413, 'too_large', 'The input is too large.');
	return bytes;
}

const PASSED_HEADERS = ['content-type', 'content-length', 'x-yoal-file-name', 'x-yoal-file-path'];

function passthrough(body: string | ReadableStream<Uint8Array> | null, upstream: Response): Response {
	const headers = new Headers({ 'cache-control': 'no-store' });
	for (const name of PASSED_HEADERS) {
		const value = upstream.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	if (typeof body === 'string') headers.delete('content-length');
	if (headers.get('content-type') === 'text/event-stream') headers.set('x-accel-buffering', 'no');
	return new Response(body, { status: upstream.status, headers });
}

function refusal(status: number, code: string, message: string): Response {
	return Response.json({ error: code, message }, { status, headers: { 'cache-control': 'no-store' } });
}

function messageOf(text: string): string | null {
	try {
		const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
		if (typeof parsed.message === 'string') return parsed.message;
		return typeof parsed.error === 'string' ? parsed.error : null;
	} catch {
		return null;
	}
}

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
