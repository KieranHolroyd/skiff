import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join } from 'node:path';

/**
 * v2-stress — a deliberately boring Bun app that exposes every knob Skiff v2 can turn.
 *
 * It is a normal tier-2 workload: bind loopback, answer a health path, keep a little state in
 * /data, read injected env and secrets, and make CPU/memory/streaming failures easy to provoke.
 * Nothing here is Skiff-specific; the point is that Skiff's runtime should be invisible.
 */

const PORT = readInt(process.env.PORT, 3000, 1, 65_535);
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const APP_NAME = process.env.STRESS_APP?.trim() || 'v2-stress';
const APP_VERSION = process.env.STRESS_BUILD?.trim() || 'dev';
// Keep the defaults visible in `/api/env` and `/api/info`; provisioning overrides both.
process.env.STRESS_APP ??= APP_NAME;
process.env.STRESS_BUILD ??= APP_VERSION;
const STARTED_AT = Date.now();
const BOOT_ID = randomUUID();
const INSTANCE_ID = BOOT_ID.slice(0, 8);

if (process.env.LISTEN_FDS) {
	// Bun 1.4 can listen on a unix path, but it cannot adopt systemd's inherited listen fd.
	// Fail loudly instead of binding a port Caddy will never talk to.
	console.error(
		JSON.stringify({
			event: 'socket-activation-unsupported',
			message:
				'This example runs with socketActivation:false. Set the workload spec field to false (the provision script does).',
			listenFds: process.env.LISTEN_FDS
		})
	);
	process.exit(78);
}

// --- data -----------------------------------------------------------------

interface CounterRow {
	key: string;
	value: number;
	updated_at: string;
}

/**
 * `/data` is the only writable path under `ProtectSystem=strict`. When the workload has no data
 * directory (or runs locally) the app degrades to memory instead of crash-looping, and reports
 * that in `/api/info` so the stress report can tell the difference.
 */
class CounterStore {
	readonly kind: 'sqlite' | 'memory';
	readonly path: string | null;
	/** Paths we tried, in order; useful when /data is missing. */
	readonly candidates: string[];
	readonly error: string | null;
	private db: Database | null;
	private memory = new Map<string, { value: number; updatedAt: string }>();

	private constructor(options: {
		kind: 'sqlite' | 'memory';
		path: string | null;
		candidates: string[];
		error: string | null;
		db?: Database;
	}) {
		this.kind = options.kind;
		this.path = options.path;
		this.candidates = options.candidates;
		this.error = options.error;
		this.db = options.db ?? null;
	}

	static open(): CounterStore {
		const candidates = [
			process.env.STRESS_DATA_DIR?.trim(),
			'/data',
			join(process.cwd(), '.stress-data')
		].filter((value): value is string => Boolean(value));
		let lastError: string | null = null;
		for (const dir of candidates) {
			try {
				mkdirSync(dir, { recursive: true });
				const path = join(dir, 'stress.db');
				const db = new Database(path, { create: true });
				db.exec(
					'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;'
				);
				db.exec(`
					CREATE TABLE IF NOT EXISTS counters (
						key TEXT PRIMARY KEY,
						value INTEGER NOT NULL DEFAULT 0,
						updated_at TEXT NOT NULL
					);
				`);
				return new CounterStore({ kind: 'sqlite', path, candidates, error: null, db });
			} catch (error) {
				lastError = errorText(error);
			}
		}
		return new CounterStore({ kind: 'memory', path: null, candidates, error: lastError });
	}

	read(key: string): number {
		if (this.db) {
			const row = this.db
				.query<{ value: number }, [string]>('SELECT value FROM counters WHERE key = ?1')
				.get(key);
			return row?.value ?? 0;
		}
		return this.memory.get(key)?.value ?? 0;
	}

	increment(key: string, by: number): number {
		const now = new Date().toISOString();
		if (this.db) {
			const row = this.db
				.query<{ value: number }, [string, number, string]>(
					`INSERT INTO counters (key, value, updated_at) VALUES (?1, ?2, ?3)
					 ON CONFLICT(key) DO UPDATE SET value = counters.value + excluded.value, updated_at = excluded.updated_at
					 RETURNING value`
				)
				.get(key, by, now);
			return row?.value ?? 0;
		}
		const current = this.memory.get(key);
		const next = { value: (current?.value ?? 0) + by, updatedAt: now };
		this.memory.set(key, next);
		return next.value;
	}

	reset(key?: string): void {
		if (this.db) {
			if (key) this.db.query('DELETE FROM counters WHERE key = ?1').run(key);
			else this.db.query('DELETE FROM counters').run();
			return;
		}
		if (key) this.memory.delete(key);
		else this.memory.clear();
	}

	all(): CounterRow[] {
		if (this.db) {
			return this.db
				.query<CounterRow, []>(
					'SELECT key, value, updated_at AS updated_at FROM counters ORDER BY key'
				)
				.all();
		}
		return [...this.memory.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => ({ key, value: value.value, updated_at: value.updatedAt }));
	}

	info(): Record<string, unknown> {
		return {
			kind: this.kind,
			path: this.path,
			candidates: this.candidates,
			error: this.error,
			counters: this.all().length
		};
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}
}

const store = CounterStore.open();
let requestCount = 0;

// --- helpers --------------------------------------------------------------

function readInt(
	raw: string | null | undefined,
	fallback: number,
	min: number,
	max: number
): number {
	const parsed = Number.parseInt(raw ?? '', 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function queryInt(url: URL, name: string, fallback: number, min: number, max: number): number {
	return readInt(url.searchParams.get(name) ?? undefined, fallback, min, max);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

interface SecretMetadata {
	name: string;
	present: boolean;
	source: 'env' | 'file';
	length?: number;
	sha256?: string;
	error?: string;
}

function secretFromEnv(name: string): SecretMetadata {
	const value = process.env[name];
	if (value === undefined) return { name, present: false, source: 'env' };
	return { name, present: true, source: 'env', length: value.length, sha256: sha256(value) };
}

function secretFromFile(name: string, path: string | undefined): SecretMetadata {
	if (!path) return { name, present: false, source: 'file', error: `${name}_FILE is not set` };
	try {
		const value = readFileSync(path);
		return { name, present: true, source: 'file', length: value.byteLength, sha256: sha256(value) };
	} catch (error) {
		return { name, present: false, source: 'file', error: errorText(error) };
	}
}

function publicEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(process.env).sort()) {
		if (!key.startsWith('STRESS_')) continue;
		if (key.endsWith('_FILE') || key.endsWith('_SECRET')) continue;
		const value = process.env[key];
		if (value !== undefined) out[key] = value;
	}
	for (const key of ['NODE_ENV', 'PORT', 'HOST']) {
		const value = process.env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

function cgroupInfo(): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		const lines = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n');
		const relative = lines.find((line) => line.startsWith('0::'))?.slice(3) ?? '';
		for (const key of ['memory.max', 'memory.current', 'memory.peak', 'cpu.max', 'pids.max']) {
			try {
				out[key] = readFileSync(join('/sys/fs/cgroup', relative, key), 'utf8').trim();
			} catch {
				// Older kernels / non-cgroup-v2 hosts simply omit the file.
			}
		}
	} catch {
		// Not Linux, or /proc is unavailable.
	}
	return out;
}

function memoryInfo(): Record<string, unknown> {
	const usage = process.memoryUsage();
	return {
		rssBytes: usage.rss,
		heapTotalBytes: usage.heapTotal,
		heapUsedBytes: usage.heapUsed,
		externalBytes: usage.external,
		arrayBuffersBytes: usage.arrayBuffers
	};
}

function runtimeInfo(): Record<string, unknown> {
	const cpu = process.cpuUsage();
	return {
		bun: Bun.version,
		pid: process.pid,
		platform: platform(),
		arch: arch(),
		osRelease: release(),
		startedAt: new Date(STARTED_AT).toISOString(),
		uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 100) / 10,
		bootId: BOOT_ID,
		instanceId: INSTANCE_ID,
		memory: memoryInfo(),
		cpu: {
			userMs: Math.round(cpu.user / 1000),
			systemMs: Math.round(cpu.system / 1000)
		},
		cgroup: cgroupInfo()
	};
}

function configInfo(): Record<string, unknown> {
	return {
		host: HOST,
		port: PORT,
		app: APP_NAME,
		version: APP_VERSION,
		env: publicEnv(),
		secrets: {
			env: secretFromEnv('STRESS_ENV_SECRET'),
			file: secretFromFile('STRESS_FILE_SECRET', process.env.STRESS_FILE_SECRET_FILE)
		},
		data: store.info(),
		socketActivation: {
			listenFds: process.env.LISTEN_FDS ?? null,
			listenPid: process.env.LISTEN_PID ?? null,
			listenFdNames: process.env.LISTEN_FDNAMES ?? null
		},
		headers: {
			host: true,
			forwarded: true
		}
	};
}

function fullInfo(): Record<string, unknown> {
	return {
		app: APP_NAME,
		version: APP_VERSION,
		requestCount,
		runtime: runtimeInfo(),
		config: configInfo(),
		endpoints: ENDPOINTS
	};
}

const ENDPOINTS = [
	'GET  /',
	'GET  /healthz[?strict=1]',
	'GET  /api/info',
	'GET  /api/env',
	'GET|POST /api/echo',
	'GET  /api/headers',
	'GET|POST /api/data[?key=&by=]',
	'POST /api/data/reset',
	'GET  /api/cpu?ms=250',
	'GET  /api/memory?mb=64&hold=500',
	'GET  /api/sleep?ms=1000',
	'GET  /api/large?kb=512',
	'GET  /api/stream?seconds=5&interval=250',
	'GET  /api/status/:code',
	'POST /api/crash?code=1&delay=100'
];

const JSON_HEADERS: Record<string, string> = {
	'content-type': 'application/json; charset=utf-8',
	'cache-control': 'no-store',
	'x-stress-instance': INSTANCE_ID
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { ...JSON_HEADERS, ...headers }
	});
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			...headers
		}
	});
}

async function readBody(request: Request, limit = 64 * 1024): Promise<string> {
	const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
	if (Number.isFinite(declared) && declared > limit)
		throw new HttpError(413, `body exceeds ${limit} bytes`);
	const body = await request.text();
	if (body.length > limit) throw new HttpError(413, `body exceeds ${limit} bytes`);
	return body;
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function htmlPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Skiff v2 stress</title>
<style>
	:root { color-scheme: dark; font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
	body { max-width: 60rem; margin: 3rem auto; padding: 0 1.5rem; background: #0b0d10; color: #d7dde5; }
	h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
	.badge { display: inline-block; padding: .15rem .5rem; border-radius: .4rem; background: #1b2330; color: #8bd5a3; }
	pre { overflow: auto; padding: 1rem; border: 1px solid #222b38; border-radius: .6rem; background: #10141a; }
	code { color: #9ecbff; }
	small { color: #7f8a99; }
</style>
</head>
<body>
<h1>v2-stress <span class="badge">up</span></h1>
<p><small>Skiff v2 tier-2 workload. Live facts refresh below; the full surface is at <code>/api/info</code>.</small></p>
<pre id="facts">loading…</pre>
<p><small>Run the harness from the repository: <code>bun examples/v2-stress/scripts/stress.ts --base &lt;url&gt;</code></small></p>
<script>
	fetch('/api/info', { cache: 'no-store' })
		.then((response) => response.json())
		.then((info) => {
			const config = info.config ?? {};
			const runtime = info.runtime ?? {};
			document.getElementById('facts').textContent = JSON.stringify({
				app: info.app,
				version: info.version,
				instance: runtime.instanceId,
				bun: runtime.bun,
				pid: runtime.pid,
				uptimeSeconds: runtime.uptimeSeconds,
				data: config.data,
				env: config.env,
				secrets: config.secrets,
				memory: runtime.memory,
				cgroup: runtime.cgroup,
			}, null, 2);
		})
		.catch((error) => {
			document.getElementById('facts').textContent = String(error);
		});
</script>
</body>
</html>`;
}

// --- routes ---------------------------------------------------------------

async function handle(request: Request): Promise<Response> {
	requestCount += 1;
	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, '') || '/';
	const method = request.method.toUpperCase();

	try {
		if (method === 'GET' && path === '/') {
			return new Response(htmlPage(), {
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
			});
		}

		if (method === 'GET' && (path === '/healthz' || path === '/readyz')) {
			const strict = url.searchParams.get('strict') === '1';
			const dataOk = store.kind === 'sqlite' || !strict;
			return json(
				{ ok: dataOk, app: APP_NAME, version: APP_VERSION, pid: process.pid, data: store.kind },
				dataOk ? 200 : 503
			);
		}

		if (method === 'GET' && path === '/api/info') return json(fullInfo());
		if (method === 'GET' && path === '/api/env') {
			return json({
				env: publicEnv(),
				secrets: {
					env: secretFromEnv('STRESS_ENV_SECRET'),
					file: secretFromFile('STRESS_FILE_SECRET', process.env.STRESS_FILE_SECRET_FILE)
				}
			});
		}

		if (path === '/api/echo' && (method === 'GET' || method === 'POST')) {
			const body = method === 'POST' ? await readBody(request) : null;
			return json({
				method,
				path,
				headers: Object.fromEntries(request.headers.entries()),
				body,
				bodyBytes: body === null ? 0 : Buffer.byteLength(body)
			});
		}

		if (method === 'GET' && path === '/api/headers') {
			return json({
				headers: Object.fromEntries(request.headers.entries()),
				host: request.headers.get('host'),
				forwardedProto: request.headers.get('x-forwarded-proto'),
				forwardedFor: request.headers.get('x-forwarded-for')
			});
		}

		if ((method === 'GET' || method === 'POST') && path === '/api/data') {
			const key = (url.searchParams.get('key') ?? 'visits').slice(0, 128);
			if (method === 'GET') {
				return json({
					key,
					value: store.read(key),
					data: store.info(),
					rows: store.all()
				});
			}
			const body = (await request.json().catch(() => ({}))) as { key?: unknown; by?: unknown };
			const bodyKey = typeof body.key === 'string' ? body.key.slice(0, 128) : key;
			const by = queryInt(
				url,
				'by',
				Number.isFinite(Number(body.by)) ? Number(body.by) : 1,
				-1_000_000,
				1_000_000
			);
			return json({ key: bodyKey, value: store.increment(bodyKey, by), data: store.info() });
		}

		if (method === 'POST' && path === '/api/data/reset') {
			const key = url.searchParams.get('key') ?? undefined;
			store.reset(key ?? undefined);
			return json({ ok: true, reset: key ?? 'all', data: store.info() });
		}

		if (method === 'GET' && path === '/api/cpu') {
			const ms = queryInt(url, 'ms', 100, 1, 5_000);
			const started = performance.now();
			let iterations = 0;
			while (performance.now() - started < ms) {
				iterations += 1;
				Math.sqrt(iterations + 0.5);
			}
			const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
			return json({
				requestedMs: ms,
				elapsedMs,
				iterations,
				// A busy loop blocks Bun's event loop; the health probe will queue behind it.
				eventLoopBlocked: elapsedMs > ms * 1.5
			});
		}

		if (method === 'GET' && path === '/api/memory') {
			const mb = queryInt(url, 'mb', 32, 1, 512);
			const holdMs = queryInt(url, 'hold', 250, 0, 10_000);
			const before = memoryInfo();
			const buffer = Buffer.alloc(mb * 1024 * 1024, 0x7f);
			// Touch every page so the kernel actually charges the unit, not just reserves VA space.
			for (let offset = 0; offset < buffer.length; offset += 4096) buffer[offset] = offset & 0xff;
			const after = memoryInfo();
			if (holdMs > 0) await Bun.sleep(holdMs);
			const bytes = buffer.byteLength;
			return json({
				mb,
				holdMs,
				bytes,
				before,
				after,
				rssDeltaBytes: (after.rssBytes as number) - (before.rssBytes as number)
			});
		}

		if (method === 'GET' && path === '/api/sleep') {
			const ms = queryInt(url, 'ms', 1000, 0, 30_000);
			await Bun.sleep(ms);
			return json({ sleptMs: ms, at: new Date().toISOString() });
		}

		if (method === 'GET' && path === '/api/large') {
			const kb = queryInt(url, 'kb', 512, 1, 16 * 1024);
			const size = kb * 1024;
			const buffer = Buffer.allocUnsafe(size);
			for (let index = 0; index < size; index += 1) buffer[index] = index & 0xff;
			const digest = sha256(buffer);
			return new Response(buffer, {
				status: 200,
				headers: {
					'content-type': 'application/octet-stream',
					'content-length': String(size),
					'cache-control': 'no-store',
					'x-stress-sha256': digest,
					'x-stress-instance': INSTANCE_ID
				}
			});
		}

		if (method === 'GET' && path === '/api/stream') {
			const seconds = queryInt(url, 'seconds', 5, 1, 120);
			const interval = queryInt(url, 'interval', 250, 25, 5_000);
			const total = Math.max(1, Math.floor((seconds * 1000) / interval));
			const encoder = new TextEncoder();
			let timer: ReturnType<typeof setInterval> | undefined;
			let tick = 0;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const send = (): void => {
						tick += 1;
						const payload = JSON.stringify({
							tick,
							instance: INSTANCE_ID,
							at: new Date().toISOString()
						});
						try {
							controller.enqueue(encoder.encode(`event: tick\ndata: ${payload}\n\n`));
						} catch {
							if (timer) clearInterval(timer);
							return;
						}
						if (tick >= total) {
							if (timer) clearInterval(timer);
							try {
								controller.close();
							} catch {
								// Already closed by the client.
							}
						}
					};
					send();
					timer = setInterval(send, interval);
					request.signal.addEventListener('abort', () => {
						if (timer) clearInterval(timer);
						try {
							controller.close();
						} catch {
							// Already closed.
						}
					});
				},
				cancel() {
					if (timer) clearInterval(timer);
				}
			});
			return new Response(stream, {
				headers: {
					'content-type': 'text/event-stream; charset=utf-8',
					'cache-control': 'no-store',
					connection: 'keep-alive',
					'x-stress-instance': INSTANCE_ID
				}
			});
		}

		const statusMatch = /^\/api\/status\/(\d{3})$/.exec(path);
		if (method === 'GET' && statusMatch) {
			const status = Number(statusMatch[1]);
			if (!Number.isInteger(status) || status < 200 || status > 599) {
				throw new HttpError(400, 'status must be an HTTP status code between 200 and 599');
			}
			if (status === 204 || status === 304) return new Response(null, { status });
			return text(`status ${status}\n`, status, { 'x-stress-instance': INSTANCE_ID });
		}

		if (method === 'POST' && path === '/api/crash') {
			const code = queryInt(url, 'code', 1, 1, 255);
			const delay = queryInt(url, 'delay', 100, 10, 5_000);
			setTimeout(() => {
				console.log(JSON.stringify({ event: 'crash-requested', code, instance: INSTANCE_ID }));
				process.exit(code);
			}, delay);
			return json({ scheduled: true, code, delayMs: delay, instance: INSTANCE_ID }, 202);
		}

		return json(
			{
				error: 'not_found',
				method,
				path,
				endpoints: ENDPOINTS
			},
			404
		);
	} catch (error) {
		if (error instanceof HttpError) return json({ error: error.message }, error.status);
		console.error(JSON.stringify({ event: 'request-error', path, error: errorText(error) }));
		return json({ error: 'internal', message: errorText(error) }, 500);
	}
}

// --- lifecycle ------------------------------------------------------------

const server = Bun.serve({
	hostname: HOST,
	port: PORT,
	fetch: handle,
	error(error) {
		console.error(JSON.stringify({ event: 'server-error', error: errorText(error) }));
		return json({ error: 'internal', message: errorText(error) }, 500);
	}
});

console.log(
	JSON.stringify({
		event: 'listening',
		app: APP_NAME,
		version: APP_VERSION,
		instance: INSTANCE_ID,
		pid: process.pid,
		host: HOST,
		port: server.port ?? PORT,
		data: store.info()
	})
);

let shuttingDown = false;
function shutdown(signal: string): void {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(JSON.stringify({ event: 'shutdown', signal, instance: INSTANCE_ID }));
	try {
		server.stop(true);
	} catch {
		// Already stopped.
	}
	store.close();
	process.exit(0);
}

const onSignal = (process as unknown as { on(event: string, listener: () => void): void }).on.bind(
	process
);
onSignal('SIGTERM', () => shutdown('SIGTERM'));
onSignal('SIGINT', () => shutdown('SIGINT'));
