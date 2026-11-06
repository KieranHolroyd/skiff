/**
 * The agent's studio front (plan 22). It listens on one loopback port per node, reached only
 * through the internal gateway, and does four things: checks the session token, fetches and
 * caches the activation, starts the studio process through the helper when it is not running,
 * and forwards each call over the studio socket with both bodies streaming and the client's
 * abort passed through.
 *
 * It never loads a plugin and never parses result rows: the only `@skiff/studio` import is the
 * protocol module, so the agent's memory does not change while results stream.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
	databaseStudioActivationSchema,
	STUDIO_SESSION_HEADER,
	STUDIO_TOKEN_HEADER,
	type DatabaseStudioActivation,
	type NodeStudioDesired,
} from '@skiff/contracts';
import {
	idempotentOps,
	StudioError,
	studioErrorBodySchema,
	studioOps,
	type StudioOp,
} from '@skiff/studio/protocol';

export type FetchStudioActivation = (
	sessionId: string,
	token: string,
	signal?: AbortSignal,
) => Promise<DatabaseStudioActivation>;

export interface StudioFrontOptions {
	/** Ask the control plane for a session's activation; throws a `StudioError` when refused. */
	fetchActivation: FetchStudioActivation;
	helper: { studioStart(): Promise<void> };
	/** Defaults to `SKIFF_STUDIO_SOCKET`, then `/run/skiff/studio.sock`. */
	socketPath?: string;
	/** Used for the unix-socket calls; injected for tests. */
	fetch?: typeof fetch;
	now?: () => number;
	/** Loopback only; injected for tests. */
	hostname?: string;
	/** How long to wait for a started studio process to answer `/healthz`. */
	startTimeoutMs?: number;
	startPollMs?: number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface CachedActivation {
	activation: DatabaseStudioActivation;
	tokenHash: Buffer;
	expiresAt: number;
	fetchedAt: number;
}

/** A session fetched this recently survives a desired state that does not list it yet. */
const EVICT_GRACE_MS = 30_000;
const STUDIO_HOST = 'http://studio';

export class StudioFront {
	private readonly fetchActivation: FetchStudioActivation;
	private readonly helper: StudioFrontOptions['helper'];
	private readonly socketPath: string;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly hostname: string;
	private readonly startTimeoutMs: number;
	private readonly startPollMs: number;
	private readonly log: NonNullable<StudioFrontOptions['log']>;

	private server: ReturnType<typeof Bun.serve> | null = null;
	private desiredPort: number | null = null;
	private readonly cache = new Map<string, CachedActivation>();
	private readonly fetching = new Map<string, Promise<DatabaseStudioActivation>>();
	/** The studio process's boot id as last seen, or null when it must be checked again. */
	private bootId: string | null = null;
	/** The last boot id ever seen, to notice a restart after `bootId` was reset. */
	private lastBootId: string | null = null;
	/** Sessions the current studio boot already holds. */
	private readonly sent = new Set<string>();
	private starting: Promise<string> | null = null;

	constructor(options: StudioFrontOptions) {
		this.fetchActivation = options.fetchActivation;
		this.helper = options.helper;
		this.socketPath = options.socketPath ?? process.env.SKIFF_STUDIO_SOCKET ?? '/run/skiff/studio.sock';
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
		this.hostname = options.hostname ?? '127.0.0.1';
		this.startTimeoutMs = options.startTimeoutMs ?? 5_000;
		this.startPollMs = options.startPollMs ?? 50;
		this.log = options.log ?? (() => undefined);
	}

	/** The bound port, or null when not listening. */
	get port(): number | null {
		return this.server?.port ?? null;
	}

	/** Apply the node's studio desired state: listen, move, stop, and drop dead sessions. */
	async update(desired: NodeStudioDesired | null): Promise<void> {
		if (!desired) {
			this.listen(null);
			await this.evict(() => true);
			return;
		}
		this.listen(desired.port);
		const live = new Set(desired.sessions);
		const at = this.now();
		await this.evict((id) => {
			if (live.has(id)) return false;
			const cached = this.cache.get(id);
			return !cached || at - cached.fetchedAt >= EVICT_GRACE_MS;
		});
	}

	/** Stop listening. Cached activations are kept until `update` drops them. */
	stop(): void {
		this.listen(null);
	}

	private listen(port: number | null): void {
		if (port === this.desiredPort && (port === null) === (this.server === null)) return;
		if (this.server) {
			this.server.stop(true);
			this.server = null;
			this.log('info', 'Studio front stopped');
		}
		this.desiredPort = port;
		if (port === null) return;
		this.server = Bun.serve({
			hostname: this.hostname,
			port,
			// Long statements may stream nothing for a while; the studio's statement timeout bounds
			// them. `idleTimeout: 0` alone does not cover a request still waiting for its response.
			idleTimeout: 0,
			fetch: (request, server) => {
				server.timeout(request, 0);
				return this.handle(request);
			},
		});
		this.log('info', `Studio front listening on ${this.hostname}:${this.server.port}`);
	}

	private async evict(shouldDrop: (id: string) => boolean): Promise<void> {
		const ids = new Set([...this.cache.keys(), ...this.sent]);
		const dropped = [...ids].filter(shouldDrop);
		await Promise.all(dropped.map((id) => this.forget(id)));
	}

	/** Drop a session here and, best effort, in the studio process. */
	private async forget(id: string): Promise<void> {
		this.cache.delete(id);
		if (!this.sent.delete(id)) return;
		try {
			const response = await this.fetchImpl(`${STUDIO_HOST}/sessions/${encodeURIComponent(id)}`, {
				method: 'DELETE',
				unix: this.socketPath,
				signal: AbortSignal.timeout(2_000),
			});
			await response.body?.cancel().catch(() => undefined);
		} catch {
			// The process is gone or restarting; it no longer holds the session either way.
		}
	}

	// --- requests ------------------------------------------------------------

	async handle(request: Request): Promise<Response> {
		try {
			return await this.forward(request);
		} catch (error) {
			const failure =
				error instanceof StudioError ? error : new StudioError('internal', 'The studio front failed.');
			if (!(error instanceof StudioError)) this.log('error', `Studio front: ${errorText(error)}`);
			return errorResponse(failure);
		}
	}

	private async forward(request: Request): Promise<Response> {
		const sessionId = request.headers.get(STUDIO_SESSION_HEADER);
		const token = request.headers.get(STUDIO_TOKEN_HEADER);
		if (!sessionId || !token) throw new StudioError('unauthorized', 'A studio session and token are required.');
		const op = /^\/v1\/([a-z]+)$/.exec(new URL(request.url).pathname)?.[1];
		if (!op || !(studioOps as readonly string[]).includes(op))
			throw new StudioError('not_found', 'No such studio endpoint.');
		if (request.method !== 'POST') throw new StudioError('bad_request', 'Studio calls are POST.', 405);
		const studioOp = op as StudioOp;
		const idempotent = idempotentOps.has(studioOp);
		// Idempotent bodies are small; keep them so the call can be retried after a restart.
		const body: ArrayBuffer | ReadableStream<Uint8Array> | null = idempotent ? await request.arrayBuffer() : request.body;

		const activation = await this.activation(sessionId, token);
		let retried = false;
		while (true) {
			await this.prepare(activation, request.signal);
			let upstream: Response;
			try {
				upstream = await this.fetchImpl(`${STUDIO_HOST}/v1/${studioOp}`, {
					method: 'POST',
					unix: this.socketPath,
					headers: {
						'content-type': request.headers.get('content-type') ?? 'application/json',
						[STUDIO_SESSION_HEADER]: sessionId,
					},
					body,
					signal: request.signal,
				});
			} catch (error) {
				if (request.signal.aborted) throw new StudioError('cancelled', 'The request was cancelled.');
				this.log('warn', `Studio process unreachable: ${errorText(error)}`);
				this.bootId = null;
				if (idempotent && !retried) {
					retried = true;
					continue;
				}
				throw restarted(studioOp);
			}

			if (upstream.ok) return passthrough(upstream.body, upstream);
			// Error bodies are small JSON; read them to react to the ones the front handles.
			const text = await upstream.text().catch(() => '');
			const code = errorCode(text);
			if (code === 'unknown_session') {
				// The process restarted (or dropped the session): hand it the activation again.
				this.sent.delete(sessionId);
				this.bootId = null;
				if (idempotent && !retried) {
					retried = true;
					continue;
				}
					throw restarted(studioOp);
			}
			if (code === 'session_expired') this.cache.delete(sessionId);
			return passthrough(text, upstream);
		}
	}

	/** The cached activation when the token matches, otherwise a fresh one from the control plane. */
	private async activation(sessionId: string, token: string): Promise<DatabaseStudioActivation> {
		const tokenHash = sha256(token);
		const cached = this.cache.get(sessionId);
		if (cached && this.now() < cached.expiresAt && timingSafeEqual(cached.tokenHash, tokenHash))
			return cached.activation;

		const key = `${sessionId}:${tokenHash.toString('hex')}`;
		let pending = this.fetching.get(key);
		if (!pending) {
			// Shared by concurrent callers, so no single caller's abort signal.
			pending = this.fetchActivation(sessionId, token);
			this.fetching.set(key, pending);
			void pending.catch(() => undefined).finally(() => this.fetching.delete(key));
		}
		let activation: DatabaseStudioActivation;
		try {
			activation = await pending;
		} catch (error) {
			if (error instanceof StudioError) {
				// The control plane says the session is gone: drop it everywhere. A wrong token alone
				// (401/403) must not evict the real session's cache.
				if (error.code === 'unknown_session' || error.code === 'session_expired') await this.forget(sessionId);
				throw error;
			}
			this.log('warn', `Studio activation fetch failed: ${errorText(error)}`);
			throw new StudioError('studio_unavailable', 'The session could not be verified with the control plane.');
		}
		if (activation.sessionId !== sessionId)
			throw new StudioError('forbidden', 'The activation is for another session.');
		const expiresAt = Date.parse(activation.expiresAt);
		if (Number.isNaN(expiresAt) || this.now() >= expiresAt)
			throw new StudioError('session_expired', 'The studio session has expired.');
		const previous = this.cache.get(sessionId);
		// A new activation (e.g. writes enabled) must reach the process before the next call.
		if (previous && JSON.stringify(previous.activation) !== JSON.stringify(activation)) this.sent.delete(sessionId);
		this.cache.set(sessionId, { activation, tokenHash, expiresAt, fetchedAt: this.now() });
		return activation;
	}

	/** Make sure the studio process runs and holds this session. */
	private async prepare(activation: DatabaseStudioActivation, signal: AbortSignal): Promise<void> {
		if (this.bootId === null) await this.ensureStudio();
		if (this.sent.has(activation.sessionId)) return;
		const put = () =>
			this.fetchImpl(`${STUDIO_HOST}/sessions/${encodeURIComponent(activation.sessionId)}`, {
				method: 'PUT',
				unix: this.socketPath,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(activation),
				signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
			});
		let response: Response;
		try {
			response = await put();
		} catch {
			if (signal.aborted) throw new StudioError('cancelled', 'The request was cancelled.');
			// The process exited (idle) or crashed since the last call: start it and try once more.
			this.bootId = null;
			await this.ensureStudio();
			try {
				response = await put();
			} catch {
				throw new StudioError('studio_unavailable', 'The studio process is not answering.');
			}
		}
		const text = await response.text().catch(() => '');
		if (!response.ok) {
			const parsed = parseError(text);
			throw parsed ?? new StudioError('studio_unavailable', `The studio process refused the session (${response.status}).`);
		}
		this.sent.add(activation.sessionId);
	}

	/** Health-check the studio process, starting it through the helper when it does not answer. */
	private async ensureStudio(): Promise<string> {
		const running = await this.health();
		if (running) return this.noteBoot(running);
		if (!this.starting) {
			this.starting = this.start().finally(() => {
				this.starting = null;
			});
		}
		return await this.starting;
	}

	private async start(): Promise<string> {
		try {
			await this.helper.studioStart();
		} catch (error) {
			this.log('error', `Studio start failed: ${errorText(error)}`);
			throw new StudioError('studio_unavailable', 'The studio process could not be started.');
		}
		// Monotonic, not the injectable wall clock used for session expiry.
		const deadline = performance.now() + this.startTimeoutMs;
		while (true) {
			const bootId = await this.health();
			if (bootId) return this.noteBoot(bootId);
			if (performance.now() >= deadline) break;
			await Bun.sleep(this.startPollMs);
		}
		throw new StudioError('studio_unavailable', 'The studio process did not start in time.');
	}

	private noteBoot(bootId: string): string {
		// A different boot holds none of the sessions the last one did.
		if (bootId !== this.lastBootId) this.sent.clear();
		this.bootId = bootId;
		this.lastBootId = bootId;
		return bootId;
	}

	private async health(): Promise<string | null> {
		try {
			const response = await this.fetchImpl(`${STUDIO_HOST}/healthz`, {
				unix: this.socketPath,
				signal: AbortSignal.timeout(1_000),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				return null;
			}
			const body = (await response.json()) as { ok?: unknown; bootId?: unknown };
			return body.ok === true && typeof body.bootId === 'string' ? body.bootId : null;
		} catch {
			return null;
		}
	}
}

/**
 * The agent's activation fetch: `GET /api/agent/database-studio/:id` with the node bearer and the
 * session token. The control plane validates both; refusals map onto studio error codes.
 */
export function controlPlaneActivationFetcher(options: {
	controlUrl: string;
	nodeToken: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}): FetchStudioActivation {
	const fetchImpl = options.fetch ?? fetch;
	return async (sessionId, token, signal) => {
		const signals = [AbortSignal.timeout(10_000)];
		if (signal) signals.push(signal);
		if (options.signal) signals.push(options.signal);
		const response = await fetchImpl(
			`${options.controlUrl}/api/agent/database-studio/${encodeURIComponent(sessionId)}`,
			{
				headers: {
					authorization: `Bearer ${options.nodeToken}`,
					accept: 'application/json',
					[STUDIO_TOKEN_HEADER]: token,
				},
				signal: AbortSignal.any(signals),
			},
		);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			const refused = refusal(response.status);
			if (refused) throw new StudioError(refused, parseError(text)?.message ?? 'The studio session was refused.');
			throw new Error(`database studio activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
		}
		const parsed = databaseStudioActivationSchema.safeParse(await response.json());
		if (!parsed.success) throw new Error(`database studio activation failed validation: ${parsed.error.message}`);
		return parsed.data;
	};
}

function refusal(status: number): StudioError['code'] | null {
	switch (status) {
		case 401:
			return 'unauthorized';
		case 403:
			return 'forbidden';
		case 404:
			return 'unknown_session';
		case 409:
		case 410:
			return 'session_expired';
		default:
			return null;
	}
}

function restarted(op: StudioOp): StudioError {
	return new StudioError(
		'studio_restarted',
		op === 'run' ? 'The studio restarted while running this query. Run it again.' : 'The studio restarted. Try again.',
	);
}

function passthrough(body: string | ReadableStream<Uint8Array> | null, upstream: Response): Response {
	return new Response(body, {
		status: upstream.status,
		headers: {
			'content-type': upstream.headers.get('content-type') ?? 'application/json',
			'cache-control': 'no-store',
		},
	});
}

function errorResponse(error: StudioError): Response {
	return Response.json(error.toBody(), { status: error.status, headers: { 'cache-control': 'no-store' } });
}

function parseError(text: string): StudioError | null {
	try {
		const parsed = studioErrorBodySchema.safeParse(JSON.parse(text));
		return parsed.success ? new StudioError(parsed.data.error.code, parsed.data.error.message) : null;
	} catch {
		return null;
	}
}

function errorCode(text: string): string | null {
	return parseError(text)?.code ?? null;
}

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
