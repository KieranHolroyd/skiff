/**
 * The `skiff-agent studio` entrypoint (plan 22): the on-demand studio process that runs engine
 * plugins. It listens only on a unix socket that the agent front reaches, holds the session
 * table (activations arrive by `PUT /sessions/:id`), enforces the session limits on every result
 * stream, and exits cleanly once it has had no sessions for a while so systemd leaves it stopped.
 *
 * It never talks to the control plane and never reads the node token: everything it knows about
 * a session comes from the agent over the socket.
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
	databaseEngines,
	databaseStudioActivationSchema,
	STUDIO_SESSION_HEADER,
	type DatabaseEngine,
	type DatabaseStudioActivation,
} from '@skiff/contracts';
import {
	encodeEvent,
	limitEvents,
	loadPlugin,
	NDJSON_CONTENT_TYPE,
	STUDIO_PROTOCOL_VERSION,
	StudioError,
	studioOps,
	studioRequestSchemas,
	type PluginLoader,
	type StudioEvent,
	type StudioInfo,
	type StudioOp,
	type StudioPlugin,
	type StudioRequest,
	type StudioSession,
	type StudioTarget,
} from '@skiff/studio';

export const DEFAULT_STUDIO_SOCKET = '/run/skiff/studio.sock';

export interface StudioProcessOptions {
	/** Defaults to `SKIFF_STUDIO_SOCKET`, then `/run/skiff/studio.sock`. */
	socketPath?: string;
	/** Exit after this long with no sessions. */
	idleExitMs?: number;
	/** Close a session's plugin connection after this long unused; it reconnects lazily. */
	sessionIdleMs?: number;
	maxSessions?: number;
	/** Engine → plugin loaders; defaults to the registry (or the fake with `SKIFF_STUDIO_FAKE=1`). */
	loaders?: Partial<Record<DatabaseEngine, PluginLoader>>;
	/** Called after an idle shutdown; defaults to `process.exit(0)` (a clean exit systemd won't restart). */
	exit?: () => void;
	now?: () => number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface StudioProcess {
	readonly bootId: string;
	readonly socketPath: string;
	/** Close every session, stop listening and remove the socket. Does not call `exit`. */
	stop(): Promise<void>;
}

interface SessionEntry {
	activation: DatabaseStudioActivation;
	plugin: Promise<StudioPlugin> | null;
	connection: Promise<StudioSession> | null;
	lastUsed: number;
	/** Requests and streams currently using the connection. */
	inFlight: Set<AbortController>;
	/** The current `run`, cancelled when a newer one starts. */
	run: AbortController | null;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const NDJSON_HEADERS = { 'content-type': NDJSON_CONTENT_TYPE, 'cache-control': 'no-store' };
const encoder = new TextEncoder();

export async function runStudioProcess(options: StudioProcessOptions = {}): Promise<StudioProcess> {
	const socketPath = options.socketPath ?? process.env.SKIFF_STUDIO_SOCKET ?? DEFAULT_STUDIO_SOCKET;
	const idleExitMs = options.idleExitMs ?? 300_000;
	const sessionIdleMs = options.sessionIdleMs ?? 300_000;
	const maxSessions = options.maxSessions ?? 8;
	const now = options.now ?? Date.now;
	const log = options.log ?? defaultLog;
	const loaders = options.loaders ?? (process.env.SKIFF_STUDIO_FAKE === '1' ? fakeLoaders() : undefined);
	const bootId = crypto.randomUUID();

	const sessions = new Map<string, SessionEntry>();
	let emptySince = now();
	let stopped = false;

	function forget(id: string): void {
		const entry = sessions.get(id);
		if (!entry) return;
		sessions.delete(id);
		if (sessions.size === 0) emptySince = now();
		for (const controller of entry.inFlight) controller.abort(new StudioError('cancelled', 'The session was closed.'));
		closeConnection(entry);
	}

	function closeConnection(entry: SessionEntry): void {
		const connection = entry.connection;
		entry.connection = null;
		connection?.then((session) => session.close()).catch(() => undefined);
	}

	function lookup(id: string): SessionEntry {
		const entry = sessions.get(id);
		if (!entry) throw new StudioError('unknown_session', 'The studio process does not know this session.');
		if (expired(entry.activation)) {
			forget(id);
			throw new StudioError('session_expired', 'The studio session has expired.');
		}
		return entry;
	}

	function expired(activation: DatabaseStudioActivation): boolean {
		const expiresAt = Date.parse(activation.expiresAt);
		return Number.isNaN(expiresAt) || now() >= expiresAt;
	}

	function plugin(entry: SessionEntry): Promise<StudioPlugin> {
		if (!entry.plugin) {
			const loading = loadPlugin(entry.activation.engine, loaders);
			entry.plugin = loading;
			loading.catch(() => {
				if (entry.plugin === loading) entry.plugin = null;
			});
		}
		return entry.plugin;
	}

	function connection(entry: SessionEntry): Promise<StudioSession> {
		if (!entry.connection) {
			const { activation } = entry;
			const connecting = plugin(entry).then((loaded) =>
				loaded.connect(targetOf(activation), { readOnly: activation.readOnly, limits: activation.limits }),
			);
			entry.connection = connecting;
			connecting.catch(() => {
				if (entry.connection === connecting) entry.connection = null;
			});
		}
		return entry.connection;
	}

	async function putSession(id: string, request: Request): Promise<Response> {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			throw new StudioError('bad_request', 'The activation is not valid JSON.');
		}
		const parsed = databaseStudioActivationSchema.safeParse(body);
		if (!parsed.success) throw new StudioError('bad_request', 'The activation failed validation.');
		const activation = parsed.data;
		if (activation.sessionId !== id) throw new StudioError('bad_request', 'The activation is for another session.');
		if (expired(activation)) throw new StudioError('session_expired', 'The studio session has expired.');
		const existing = sessions.get(id);
		if (existing) {
			// A changed activation (new credential, mode or limits) needs a fresh connection.
			if (JSON.stringify(existing.activation) !== JSON.stringify(activation)) {
				existing.activation = activation;
				existing.plugin = null;
				closeConnection(existing);
			}
			existing.lastUsed = now();
		} else {
			if (sessions.size >= maxSessions)
				throw new StudioError('busy', `This node already has ${maxSessions} open studio sessions.`);
			sessions.set(id, {
				activation,
				plugin: null,
				connection: null,
				lastUsed: now(),
				inFlight: new Set(),
				run: null,
			});
		}
		return Response.json({ ok: true }, { headers: JSON_HEADERS });
	}

	async function handleOp(op: StudioOp, request: Request): Promise<Response> {
		const id = request.headers.get(STUDIO_SESSION_HEADER);
		if (!id) throw new StudioError('unknown_session', 'The request names no studio session.');
		const entry = lookup(id);
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			throw new StudioError('bad_request', 'The request body is not valid JSON.');
		}
		const parsed = studioRequestSchemas[op].safeParse(raw);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
			throw new StudioError('bad_request', `Invalid ${op} request. ${where}${issue?.message ?? ''}`.trim());
		}

		const controller = new AbortController();
		const onAbort = () => controller.abort(new StudioError('cancelled', 'The request was cancelled.'));
		if (request.signal.aborted) onAbort();
		else request.signal.addEventListener('abort', onAbort, { once: true });
		entry.inFlight.add(controller);
		entry.lastUsed = now();
		let streaming = false;
		const release = () => {
			request.signal.removeEventListener('abort', onAbort);
			entry.inFlight.delete(controller);
			if (entry.run === controller) entry.run = null;
			entry.lastUsed = now();
		};

		try {
			if (op === 'run') {
				entry.run?.abort(new StudioError('cancelled', 'A newer run replaced this one.'));
				entry.run = controller;
			}
			if (op === 'info') return Response.json(await info(entry), { headers: JSON_HEADERS });
			const session = await connection(entry);
			const signal = controller.signal;
			const { limits } = entry.activation;
			switch (op) {
				case 'tree': {
					const body = parsed.data as StudioRequest<'tree'>;
					return Response.json({ nodes: await session.tree(body.path, signal) }, { headers: JSON_HEADERS });
				}
				case 'describe': {
					const body = parsed.data as StudioRequest<'describe'>;
					return Response.json(await session.describe(body.object, signal), { headers: JSON_HEADERS });
				}
				case 'explain': {
					const body = parsed.data as StudioRequest<'explain'>;
					if (!session.explain) throw new StudioError('unsupported', 'This engine has no EXPLAIN.');
					return Response.json(await session.explain(body.input, signal), { headers: JSON_HEADERS });
				}
				case 'apply': {
					const body = parsed.data as StudioRequest<'apply'>;
					return Response.json(await session.apply(body.object, body.changes, signal), {
						headers: JSON_HEADERS,
					});
				}
				case 'alter': {
					const body = parsed.data as StudioRequest<'alter'>;
					// A second layer: plugins refuse too, and the read-only principal cannot run DDL.
					if (entry.activation.readOnly) throw new StudioError('read_only', 'The session is read-only.');
					if (!session.alter) throw new StudioError('unsupported', 'This engine cannot edit structure.');
					return Response.json(await session.alter(body.change, { dryRun: body.dryRun }, signal), {
						headers: JSON_HEADERS,
					});
				}
				case 'value': {
					const body = parsed.data as StudioRequest<'value'>;
					if (!session.value) throw new StudioError('unsupported', 'This engine cannot load full values.');
					const cell = await session.value(body.object, body.key, body.column, signal);
					return Response.json({ cell }, { headers: JSON_HEADERS });
				}
				case 'browse': {
					const body = parsed.data as StudioRequest<'browse'>;
					const events = session.browse(body.object, body.query, signal);
					streaming = true;
					return await stream(events, { maxRows: limits.maxRows, maxBytes: limits.maxBytes }, controller, release);
				}
				case 'run': {
					const body = parsed.data as StudioRequest<'run'>;
					const maxRows = Math.min(body.maxRows ?? limits.maxRows, limits.maxRows);
					const events = session.run(body.input, { maxRows, timeoutMs: limits.statementTimeoutMs }, signal);
					streaming = true;
					return await stream(events, { maxRows, maxBytes: limits.maxBytes }, controller, release);
				}
				default:
					throw new StudioError('not_found', `Unknown op ${op satisfies never}.`);
			}
		} finally {
			// A stream releases the entry itself when it ends.
			if (!streaming) release();
		}
	}

	async function info(entry: SessionEntry): Promise<StudioInfo> {
		const { activation } = entry;
		const loaded = await plugin(entry);
		return {
			v: STUDIO_PROTOCOL_VERSION,
			engine: activation.engine,
			version: activation.version,
			readOnly: activation.readOnly,
			capabilities: loaded.capabilities(activation.engine, activation.version),
			limits: {
				maxRows: activation.limits.maxRows,
				maxBytes: activation.limits.maxBytes,
				statementTimeoutMs: activation.limits.statementTimeoutMs,
			},
			expiresAt: activation.expiresAt,
		};
	}

	/**
	 * Pull the first event before answering, so an error that happens before any output (a
	 * refused statement, a failed connect) is a JSON error with the right status; anything after
	 * that is an `error` event followed by `done`.
	 */
	async function stream(
		source: AsyncIterable<StudioEvent>,
		limits: { maxRows: number; maxBytes: number },
		controller: AbortController,
		release: () => void,
	): Promise<Response> {
		const startedAt = performance.now();
		const iterator = limitEvents(source, limits, startedAt)[Symbol.asyncIterator]();
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			release();
		};
		let first: IteratorResult<StudioEvent>;
		try {
			first = await iterator.next();
		} catch (error) {
			finish();
			throw error;
		}
		let pending: StudioEvent | null = first.done ? null : first.value;
		if (first.done) finish();
		const body = new ReadableStream<Uint8Array>({
			async pull(sink) {
				if (pending) {
					sink.enqueue(encoder.encode(encodeEvent(pending)));
					pending = null;
					return;
				}
				if (finished) {
					sink.close();
					return;
				}
				try {
					const next = await iterator.next();
					if (next.done) {
						finish();
						sink.close();
						return;
					}
					sink.enqueue(encoder.encode(encodeEvent(next.value)));
				} catch (error) {
					const failure = toStudioError(error);
					finish();
					sink.enqueue(encoder.encode(encodeEvent({ t: 'error', code: failure.code, message: failure.message })));
					sink.enqueue(
						encoder.encode(
							encodeEvent({ t: 'done', ms: Math.round(performance.now() - startedAt), truncated: false }),
						),
					);
					sink.close();
				}
			},
			async cancel() {
				controller.abort(new StudioError('cancelled', 'The client went away.'));
				finish();
				await iterator.return?.(undefined).catch(() => undefined);
			},
		});
		return new Response(body, { headers: NDJSON_HEADERS });
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		try {
			if (path === '/healthz' && request.method === 'GET')
				return Response.json({ ok: true, bootId, sessions: sessions.size }, { headers: JSON_HEADERS });
			const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
			if (sessionMatch) {
				const id = decodeURIComponent(sessionMatch[1] ?? '');
				if (request.method === 'PUT') return await putSession(id, request);
				if (request.method === 'DELETE') {
					forget(id);
					return Response.json({ ok: true }, { headers: JSON_HEADERS });
				}
				throw new StudioError('bad_request', `${request.method} is not allowed here.`, 405);
			}
			const opMatch = /^\/v1\/([a-z]+)$/.exec(path);
			const op = opMatch?.[1];
			if (op && (studioOps as readonly string[]).includes(op)) {
				if (request.method !== 'POST') throw new StudioError('bad_request', 'Studio calls are POST.', 405);
				return await handleOp(op as StudioOp, request);
			}
			throw new StudioError('not_found', 'No such studio endpoint.');
		} catch (error) {
			const failure = toStudioError(error);
			if (failure.code === 'engine_error' || failure.code === 'internal')
				log('warn', `studio ${request.method} ${path} failed: ${failure.message}`);
			return Response.json(failure.toBody(), { status: failure.status, headers: JSON_HEADERS });
		}
	}

	await fs.mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined);
	await fs.rm(socketPath, { force: true });
	const server = Bun.serve({
		unix: socketPath,
		// Long statements may send nothing for a while; the statement timeout bounds them instead.
		// Bun's types omit `idleTimeout` for unix listeners, but it applies; without it a reused
		// keep-alive connection is cut after 10 s of quiet even with `server.timeout(request, 0)`.
		...({ idleTimeout: 0 } as object),
		fetch(request, server) {
			server.timeout(request, 0);
			return handle(request);
		},
	});
	await fs.chmod(socketPath, 0o660);
	log('info', `Studio process ${bootId} listening on unix/${socketPath}`);

	async function stop(): Promise<void> {
		if (stopped) return;
		stopped = true;
		clearInterval(sweeper);
		for (const id of [...sessions.keys()]) forget(id);
		server.stop(true);
		await fs.rm(socketPath, { force: true }).catch(() => undefined);
	}

	const sweepEvery = Math.max(10, Math.min(15_000, Math.floor(Math.min(idleExitMs, sessionIdleMs) / 4)));
	const sweeper = setInterval(() => {
		const at = now();
		for (const [id, entry] of sessions) {
			if (expired(entry.activation)) {
				forget(id);
				continue;
			}
			if (entry.connection && entry.inFlight.size === 0 && at - entry.lastUsed >= sessionIdleMs)
				closeConnection(entry);
		}
		if (sessions.size === 0 && at - emptySince >= idleExitMs) {
			log('info', `Studio process ${bootId} idle; exiting`);
			void stop().then(() => (options.exit ?? (() => process.exit(0)))());
		}
	}, sweepEvery);

	if (!options.exit) {
		// systemd stops the unit with SIGTERM: leave no stale socket behind, and exit 0.
		const signals = process as unknown as { once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void };
		const onSignal = () => void stop().then(() => process.exit(0));
		signals.once('SIGTERM', onSignal);
		signals.once('SIGINT', onSignal);
	}

	return { bootId, socketPath, stop };
}

function targetOf(activation: DatabaseStudioActivation): StudioTarget {
	return {
		engine: activation.engine,
		version: activation.version,
		host: activation.host,
		port: activation.port,
		database: activation.database,
		user: activation.user,
		password: activation.password,
		tls: activation.tls,
	};
}

/** Anything that is not already a `StudioError` is an engine error: its message, never a stack. */
export function toStudioError(error: unknown): StudioError {
	if (error instanceof StudioError) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new StudioError('engine_error', message.slice(0, 2_000) || 'The engine reported an error.');
}

function fakeLoaders(): Partial<Record<DatabaseEngine, PluginLoader>> {
	const load: PluginLoader = () => import('@skiff/studio/fake').then((module) => module.fakePlugin);
	return Object.fromEntries(databaseEngines.map((engine) => [engine, load]));
}

function defaultLog(level: 'info' | 'warn' | 'error', message: string): void {
	const line = `[skiff-studio ${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else console.log(line);
}
