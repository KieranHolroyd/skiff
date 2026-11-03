import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import {
	desiredStateSchema,
	heartbeatSchema,
	type DesiredState,
	type Heartbeat,
	type NodeStatus,
} from '@skiff/contracts';
import type { TlsOptions } from '@skiff/site-config';
import { CaddyAdmin } from './caddy.ts';
import { buildCaddyConfig, tlsSubjects } from './caddy-config.ts';
import { loadConfig, type AgentConfig } from './config.ts';
import { formatEnv, JOIN_USAGE, joinNode, nodeFilePath, parseJoinArgs } from './join.ts';
import { ReleaseManager } from './releases.ts';
import { StatsCollector } from './stats.ts';
import { DesiredStateStore, desiredStateEtag } from './state.ts';
import { TelemetryClient } from './telemetry.ts';
import { handleSiteRequest, normalizeHost } from './verify.ts';

const HEARTBEAT_INTERVAL_MS = 10_000;
const LONG_POLL_SECONDS = 8;
const LONG_POLL_TIMEOUT_MS = (LONG_POLL_SECONDS + 10) * 1_000;
const TELEMETRY_INTERVAL_MS = 60_000;
const TELEMETRY_POLL_MS = 1_000;

class Backoff {
	private readonly initialMs: number;
	private readonly maxMs: number;
	private currentMs: number;

	constructor(initialMs: number, maxMs: number) {
		this.initialMs = initialMs;
		this.maxMs = maxMs;
		this.currentMs = initialMs;
	}

	next(): number {
		const value = this.currentMs;
		this.currentMs = Math.min(this.maxMs, this.currentMs * 2);
		return value;
	}

	reset(): void {
		this.currentMs = this.initialMs;
	}
}

class AgentRuntime {
	private readonly config: AgentConfig;
	private readonly store: DesiredStateStore;
	private readonly releases: ReleaseManager;
	private readonly caddy: CaddyAdmin;
	private readonly stats: StatsCollector;

	private desired: DesiredState | null = null;
	private desiredEtag: string | null = null;
	private convergedVersion: number | null = null;
	private actualStateVersion = 0;
	private projectByHost = new Map<string, string>();

	private caddyOk = false;
	private running = true;
	private server: ReturnType<typeof Bun.serve> | null = null;
	private readonly shutdownController = new AbortController();
	private resolveShutdown: (() => void) | null = null;
	private loops: Array<Promise<void>> = [];

	private lastReconcileAttemptAt = 0;
	private lastReconcileSuccessAt = 0;
	private reconcileFailures = 0;
	private heartbeatFailures = 0;

	private telemetry: TelemetryClient | null = null;
	private telemetryStartWarned = false;
	private heartbeatWasFailing = false;
	private pullBeforeConverge = false;

	private readonly reconcileBackoff = new Backoff(1_000, 30_000);
	private readonly heartbeatBackoff = new Backoff(5_000, 60_000);

	constructor(config: AgentConfig) {
		this.config = config;
		this.store = new DesiredStateStore(config.dataDir);
		this.releases = new ReleaseManager(config.dataDir);
		this.caddy = new CaddyAdmin(config.caddyAdminSocket);
		this.stats = new StatsCollector(config.dataDir);
	}

	async run(): Promise<void> {
		// Register the stop promise before starting so a signal during startup cannot be lost.
		const stopped = new Promise<void>((resolve) => {
			this.resolveShutdown = resolve;
		});
		try {
			await this.start();
			await stopped;
		} finally {
			await this.shutdown();
		}
	}

	beginShutdown(): void {
		if (!this.running) return;
		this.running = false;
		this.shutdownController.abort();
		this.resolveShutdown?.();
	}

	private async start(): Promise<void> {
		await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o755 });
		await this.releases.init();

		const cached = await this.store.readCached();
		if (cached) {
			if (cached.state.nodeId !== this.config.nodeId) {
				log(
					'warn',
					`Ignoring cached desired state for node ${cached.state.nodeId}; this is ${this.config.nodeId}`,
				);
			} else {
				this.desired = cached.state;
				this.desiredEtag = cached.etag;
				log('info', `Loaded cached desired state v${cached.state.version}`);
			}
		}

		await this.checkCaddy();
		await this.startServer();

		if (this.config.caddyAccessLog) {
			this.telemetry = new TelemetryClient({
				controlUrl: this.config.controlUrl,
				nodeToken: this.config.nodeToken,
				nodeId: this.config.nodeId,
				accessLogPath: this.config.caddyAccessLog,
				resolveProject: (host) => this.projectByHost.get(normalizeHost(host)) ?? null,
			});
		}

		// Bun's process typings only augment `memoryPressure`; the Node signal overloads still work
		// at runtime, so go through a narrow structural type here.
		const signals = process as unknown as {
			once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
		};
		signals.once('SIGTERM', () => this.beginShutdown());
		signals.once('SIGINT', () => this.beginShutdown());

		this.loops = [this.reconcileLoop(), this.heartbeatLoop(), this.telemetryLoop()];
		log(
			'info',
			`Agent ${this.config.agentVersion} for ${this.config.nodeId} running (control ${this.config.controlUrl})`,
		);
	}

	private async shutdown(): Promise<void> {
		log('info', 'Shutting down');
		this.shutdownController.abort();
		await Promise.allSettled(this.loops);
		await this.telemetry?.stop().catch(() => undefined);
		this.server?.stop(true);
		this.server = null;
		await fs.rm(this.config.agentSocket, { force: true }).catch(() => undefined);
		log('info', 'Stopped');
	}

	private async startServer(): Promise<void> {
		await fs.mkdir(dirname(this.config.agentSocket), { recursive: true, mode: 0o755 });
		await fs.rm(this.config.agentSocket, { force: true }).catch(() => undefined);

		this.server = Bun.serve({
			unix: this.config.agentSocket,
			fetch: (request) => this.handleRequest(request),
		});
		await fs.chmod(this.config.agentSocket, 0o660).catch(() => undefined);
		log('info', `Listening on unix/${this.config.agentSocket}`);
	}

	private handleRequest(request: Request): Response {
		const path = requestPath(request.url);
		if (path === '/metrics') return new Response(this.metricsText(), { headers: metricsHeaders() });
		if (path === '/healthz') {
			return Response.json({
				ok: true,
				nodeId: this.config.nodeId,
				caddyOk: this.caddyOk,
				desiredStateVersion: this.desired?.version ?? 0,
				actualStateVersion: this.actualStateVersion,
				lastReconcileSuccessAt: this.lastReconcileSuccessAt,
			});
		}
		return handleSiteRequest(request, {
			state: this.desired,
			cookieName: this.config.cookieName,
			insecureHttp: this.config.insecureHttp,
		});
	}

	// --- desired state -------------------------------------------------------

	private async reconcileLoop(): Promise<void> {
		while (this.running) {
			if (
				this.desired &&
				this.convergedVersion !== this.desired.version &&
				!this.pullBeforeConverge
			) {
				try {
					await this.converge(this.desired);
					this.reconcileBackoff.reset();
				} catch (error) {
					if (!this.running) break;
					this.reconcileFailures += 1;
					log('error', `Reconcile v${this.desired.version} failed: ${errorText(error)}`);
					// Do not get stuck retrying a stale state forever: pull once before trying
					// again, so a newer desired state can supersede a broken release URL.
					this.pullBeforeConverge = true;
					await sleep(this.reconcileBackoff.next(), this.shutdownController.signal);
				}
				continue;
			}

			try {
				this.pullBeforeConverge = false;
				const started = Date.now();
				const changed = await this.pullDesiredState();
				this.reconcileBackoff.reset();
				if (!changed) {
					// A control plane that supports long-poll holds for 25 s. If it answered instantly
					// (304 without holding), fall back to the documented 10 s poll interval.
					const elapsed = Date.now() - started;
					await sleep(elapsed < 2_000 ? 10_000 : 250, this.shutdownController.signal);
				}
			} catch (error) {
				if (!this.running) break;
				this.reconcileFailures += 1;
				log('warn', `Desired-state pull failed: ${errorText(error)}`);
				await sleep(this.reconcileBackoff.next(), this.shutdownController.signal);
			}
		}
	}

	private async pullDesiredState(): Promise<boolean> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.config.nodeToken}`,
			accept: 'application/json',
		};
		const etag = this.desiredEtag ?? (this.desired ? desiredStateEtag(this.desired) : null);
		if (etag) headers['if-none-match'] = etag;

		const timeout = AbortSignal.timeout(LONG_POLL_TIMEOUT_MS);
		const signal = AbortSignal.any([this.shutdownController.signal, timeout]);

		let response: Response;
		try {
			response = await fetch(
				`${this.config.controlUrl}/api/agent/desired-state?wait=${LONG_POLL_SECONDS}`,
				{ headers, signal },
			);
		} catch (error) {
			// A long-poll that outlived our client timeout is harmless: just ask again.
			if (error instanceof Error && error.name === 'TimeoutError') return false;
			throw error;
		}

		if (response.status === 304) return false;
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`desired-state -> ${response.status}${text ? `: ${text}` : ''}`);
		}

		const value: unknown = await response.json();
		const parsed = desiredStateSchema.safeParse(value);
		if (!parsed.success) {
			throw new Error(`desired-state failed validation: ${parsed.error.message}`);
		}
		const state = parsed.data;
		if (state.nodeId !== this.config.nodeId) {
			throw new Error(`desired-state is for node ${state.nodeId}, not ${this.config.nodeId}`);
		}

		const etagHeader = response.headers.get('etag') ?? desiredStateEtag(state);
		this.desired = state;
		this.desiredEtag = etagHeader;
		try {
			await this.store.write(state, etagHeader);
		} catch (error) {
			// Serving from the in-memory copy still works; the next pull will retry the cache write.
			log('warn', `Could not cache desired state: ${errorText(error)}`);
		}
		log('info', `Pulled desired state v${state.version} (${state.routes.length} routes)`);
		return true;
	}

	private async converge(state: DesiredState): Promise<void> {
		const started = Date.now();
		this.lastReconcileAttemptAt = started;

		const specs = new Map(state.releases.map((release) => [release.sha256, release]));
		for (const release of state.releases) {
			try {
				const downloaded = await this.releases.ensureRelease(release, this.shutdownController.signal);
				if (downloaded) log('info', `Cached release ${release.sha256.slice(0, 12)}`);
			} catch (error) {
				throw new Error(`release ${release.sha256.slice(0, 12)}: ${errorText(error)}`);
			}
		}

		for (const route of state.routes) {
			if (!(await this.releases.hasRelease(route.release))) {
				const spec = specs.get(route.release);
				if (!spec)
					throw new Error(`route ${route.host} references unknown release ${route.release.slice(0, 12)}`);
				await this.releases.ensureRelease(spec, this.shutdownController.signal);
			}
			await this.releases.activate(route.projectId, route.release);
		}

		const tls = this.config.tls ? this.tlsOptions(state) : undefined;
		const caddyConfig = buildCaddyConfig({
			state,
			// With TLS enabled Caddy owns :443 and site-config adds the :80 redirect server.
			listen: tls ? [':443'] : this.config.caddyListen,
			dataDir: this.config.dataDir,
			agentSocket: this.config.agentSocket,
			caddyAdminSocket: this.config.caddyAdminSocket,
			...(tls ? { tls } : {}),
			...(this.config.platformHost
				? {
						platform: {
							host: this.config.platformHost,
							upstream: this.config.platformUpstream,
						},
					}
				: {}),
		});
		await this.caddy.applyFullConfig(caddyConfig, this.shutdownController.signal);

		this.caddyOk = true;
		this.projectByHost = new Map(
			state.routes.map((route) => [normalizeHost(route.host), route.projectId]),
		);
		this.convergedVersion = state.version;
		this.actualStateVersion = state.version;
		this.lastReconcileSuccessAt = Date.now();
		log(
			'info',
			`Converged v${state.version}: ${state.routes.length} routes, ${state.releases.length} releases in ${Date.now() - started}ms`,
		);

		try {
			await this.releases.gc(state);
		} catch (error) {
			log('warn', `Release GC failed: ${errorText(error)}`);
		}
	}

	private tlsOptions(state: DesiredState): TlsOptions {
		const domain =
			this.config.contentDomain ?? (state.contentDomain || deriveContentDomain(state));
		return {
			email: this.config.acmeEmail ?? '',
			subjects: tlsSubjects(
				domain,
				this.config.platformHost ? [this.config.platformHost] : [],
			),
			httpRedirect: true,
			...(this.config.acmeCa ? { ca: this.config.acmeCa } : {}),
			...(this.config.cloudflareApiToken
				? { cloudflareApiToken: this.config.cloudflareApiToken }
				: {}),
		};
	}

	// --- heartbeat -----------------------------------------------------------

	private async heartbeatLoop(): Promise<void> {
		while (this.running) {
			let ok = false;
			try {
				ok = await this.sendHeartbeat('online');
			} catch (error) {
				if (!this.running) break;
				this.heartbeatFailures += 1;
				this.heartbeatWasFailing = true;
				log('warn', `Heartbeat failed: ${errorText(error)}`);
			}
			if (!this.running) break;

			if (ok) {
				if (this.heartbeatWasFailing) log('info', 'Heartbeat restored');
				this.heartbeatWasFailing = false;
				this.heartbeatBackoff.reset();
				await sleep(HEARTBEAT_INTERVAL_MS, this.shutdownController.signal);
			} else {
				await sleep(this.heartbeatBackoff.next(), this.shutdownController.signal);
			}
		}
	}

	private async sendHeartbeat(requestedStatus: NodeStatus): Promise<boolean> {
		await this.checkCaddy();
		const stats = await this.stats.collect();
		const body: Heartbeat = {
			nodeId: this.config.nodeId,
			agentVersion: this.config.agentVersion,
			actualStateVersion: this.actualStateVersion,
			status: requestedStatus === 'draining' ? 'draining' : this.caddyOk ? 'online' : 'offline',
			caddyOk: this.caddyOk,
			stats,
			releases: this.releases.listReleases(),
		};

		const parsed = heartbeatSchema.safeParse(body);
		if (!parsed.success) throw new Error(`heartbeat failed validation: ${parsed.error.message}`);

		const response = await fetch(`${this.config.controlUrl}/api/agent/heartbeat`, {
			method: 'POST',
			signal: AbortSignal.any([
				this.shutdownController.signal,
				AbortSignal.timeout(HEARTBEAT_INTERVAL_MS * 2),
			]),
			headers: {
				authorization: `Bearer ${this.config.nodeToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(parsed.data),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`heartbeat -> ${response.status}${text ? `: ${text}` : ''}`);
		}
		return true;
	}

	private async checkCaddy(): Promise<void> {
		try {
			await this.caddy.health(this.shutdownController.signal);
			this.caddyOk = true;
		} catch {
			this.caddyOk = false;
		}
	}

	// --- telemetry -----------------------------------------------------------

	private async telemetryLoop(): Promise<void> {
		const client = this.telemetry;
		if (!client) return;
		let lastFlush = Date.now();
		let lastStartAttempt = 0;

		while (this.running) {
			try {
				if (!client.ready) {
					if (Date.now() - lastStartAttempt >= 10_000) {
						lastStartAttempt = Date.now();
						try {
							await client.start();
							this.telemetryStartWarned = false;
							log('info', `Aggregating access log ${this.config.caddyAccessLog}`);
						} catch (error) {
							if (!this.telemetryStartWarned) {
								this.telemetryStartWarned = true;
								log('warn', `Waiting for access log: ${errorText(error)}`);
							}
						}
					}
					await sleep(TELEMETRY_POLL_MS, this.shutdownController.signal);
					continue;
				}

				await client.poll();
				if (Date.now() - lastFlush >= TELEMETRY_INTERVAL_MS) {
					lastFlush = Date.now();
					try {
						await client.flush();
					} catch (error) {
						log('warn', `Telemetry flush failed: ${errorText(error)}`);
					}
				}
			} catch (error) {
				if (!this.running) break;
				log('warn', `Telemetry tail failed: ${errorText(error)}`);
			}
			await sleep(TELEMETRY_POLL_MS, this.shutdownController.signal);
		}
	}

	// --- metrics -------------------------------------------------------------

	private metricsText(): string {
		const telemetry = this.telemetry?.stats;
		const measurements: Array<[string, string, 'counter' | 'gauge', number]> = [
			['skiff_agent_caddy_up', 'Whether the Caddy admin API is reachable.', 'gauge', this.caddyOk ? 1 : 0],
			['skiff_agent_routes', 'Routes in the current desired state.', 'gauge', this.desired?.routes.length ?? 0],
			['skiff_agent_releases', 'Verified releases on disk.', 'gauge', this.releases.listReleases().length],
			[
				'skiff_agent_desired_state_version',
				'Version of the last pulled desired state.',
				'gauge',
				this.desired?.version ?? 0,
			],
			['skiff_agent_actual_state_version', 'Version this agent has converged to.', 'gauge', this.actualStateVersion],
			[
				'skiff_agent_reconcile_last_attempt_timestamp_seconds',
				'Unix time of the last reconcile attempt.',
				'gauge',
				this.lastReconcileAttemptAt / 1000,
			],
			[
				'skiff_agent_reconcile_last_success_timestamp_seconds',
				'Unix time of the last successful reconcile.',
				'gauge',
				this.lastReconcileSuccessAt / 1000,
			],
			[
				'skiff_agent_reconcile_failures_total',
				'Desired-state pulls or converges that failed.',
				'counter',
				this.reconcileFailures,
			],
			[
				'skiff_agent_heartbeat_failures_total',
				'Heartbeats that could not be delivered.',
				'counter',
				this.heartbeatFailures,
			],
			[
				'skiff_agent_telemetry_flush_failures_total',
				'Telemetry batches that could not be delivered.',
				'counter',
				telemetry?.flushFailures ?? 0,
			],
			[
				'skiff_agent_telemetry_batches_sent_total',
				'Telemetry batches delivered to the control plane.',
				'counter',
				telemetry?.batchesSent ?? 0,
			],
			[
				'skiff_agent_telemetry_buckets_dropped_total',
				'Telemetry buckets dropped to keep memory bounded.',
				'counter',
				telemetry?.dropped ?? 0,
			],
		];

		const lines: string[] = [];
		for (const [name, help, type, value] of measurements) {
			lines.push(`# HELP ${name} ${help}`);
			lines.push(`# TYPE ${name} ${type}`);
			lines.push(`${name} ${formatMetric(value)}`);
		}
		lines.push('# HELP skiff_agent_build_info Agent build metadata.');
		lines.push('# TYPE skiff_agent_build_info gauge');
		lines.push(`skiff_agent_build_info{version="${escapeLabel(this.config.agentVersion)}"} 1`);
		return `${lines.join('\n')}\n`;
	}
}

function metricsHeaders(): Record<string, string> {
	return { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' };
}

function formatMetric(value: number): string {
	return Number.isFinite(value) ? String(value) : '0';
}

function escapeLabel(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Fall back to stripping the site label from any route host when desired state omits it. */
function deriveContentDomain(state: DesiredState): string {
	const host = state.routes[0] ? normalizeHost(state.routes[0].host) : '';
	const labels = host.split('.');
	if (labels.length < 3) throw new Error('Cannot determine the content domain for TLS');
	return labels.slice(1).join('.');
}

function requestPath(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return '/';
	}
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.name === 'AbortError' ? 'aborted' : error.message;
	return String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			resolve();
		};
		const onAbort = (): void => finish();
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
	const line = `[skiff-agent ${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else console.log(line);
}

async function runJoinCli(args: string[]): Promise<void> {
	if (args.includes('--help') || args.includes('-h')) {
		console.log(JOIN_USAGE);
		return;
	}
	const options = parseJoinArgs(args);
	const joined = await joinNode(options);
	process.stdout.write(formatEnv(joined));
	// Keep stdout machine-readable for `> /etc/skiff/agent.env`.
	console.error(`Wrote ${nodeFilePath(options.dataDir)}`);
}

async function main(): Promise<void> {
	const config = loadConfig();
	const runtime = new AgentRuntime(config);
	await runtime.run();
}

if (import.meta.main) {
	// `bun src/main.ts join …` has the script at argv[1]; a compiled binary may not.
	const joinIndex = process.argv[2] === 'join' ? 2 : process.argv[1] === 'join' ? 1 : -1;
	if (joinIndex >= 0) {
		await runJoinCli(process.argv.slice(joinIndex + 1)).catch((error: unknown) => {
			console.error(`skiff-agent join: ${errorText(error)}`);
			process.exitCode = 1;
		});
	} else {
		main().catch((error: unknown) => {
			console.error(`[skiff-agent] fatal: ${errorText(error)}`);
			process.exitCode = 1;
		});
	}
}
