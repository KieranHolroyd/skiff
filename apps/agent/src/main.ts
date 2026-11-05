import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	desiredStateSchema,
	heartbeatSchema,
	workloadActivationSchema,
	type DesiredState,
	type Heartbeat,
	type NodeStatus,
	type VolumeInventory,
	type WorkloadActivation,
} from '@skiff/contracts';
import type { TlsOptions } from '@skiff/site-config';
import { CaddyAdmin } from './caddy.ts';
import { CertProbe, certProbeTargets, tlsCertReader } from './certs.ts';
import { buildCaddyConfig, isProductionRoute, tlsSubjects } from './caddy-config.ts';
import { loadConfig, type AgentConfig } from './config.ts';
import { DatabaseBackupRunner } from './database-backups.ts';
import { DatabaseCredentialRunner } from './database-credentials.ts';
import { DatabasePoolerRestartRunner } from './database-pooler-restarts.ts';
import { DatabaseRotationRunner } from './database-rotations.ts';
import { DATABASE_STATS_INTERVAL_MS, DatabaseStatsSampler } from './database-stats.ts';
import { HelperClient } from './helper-client.ts';
import { formatEnv, JOIN_USAGE, joinNode, nodeFilePath, parseJoinArgs } from './join.ts';
import { WorkloadLogDrain } from './log-drain.ts';
import { ReleaseManager } from './releases.ts';
import { WorkloadRuntime, workloadHeartbeat } from './runtime.ts';
import { StatsCollector } from './stats.ts';
import { StorageReconciler, STORAGE_RECONCILE_INTERVAL_MS } from './storage-admin.ts';
import { StorageRequester } from './storage.ts';
import { StorageStatsSampler, STORAGE_STATS_INTERVAL_MS } from './storage-stats.ts';
import { DesiredStateStore, desiredStateEtag } from './state.ts';
import { postTelemetryBatch, TelemetryClient } from './telemetry.ts';
import { handleSiteRequest, normalizeHost, UsedTokenCache } from './verify.ts';

const HEARTBEAT_INTERVAL_MS = 10_000;
// Bun's default idle timeout on the control plane is 10 s (adapter-bun CONNECTION_IDLE_TIMEOUT),
// so hold well under it. The server caps `wait` at 25 s for installs that raise the timeout.
const LONG_POLL_SECONDS = 8;
const LONG_POLL_TIMEOUT_MS = (LONG_POLL_SECONDS + 10) * 1_000;
const TELEMETRY_INTERVAL_MS = 60_000;
/** Mounts change rarely; heartbeat every 10 s but re-read the helper's inventory once a minute. */
const VOLUME_INVENTORY_INTERVAL_MS = 60_000;
/** `@id` present in every config the agent loads (site-config's catch-all route). */
const CONVERGED_SENTINEL_ID = 'catch-all';
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
	private readonly certs: CertProbe | null;
	private readonly helper: HelperClient;
	private readonly workloads: WorkloadRuntime;
	private readonly logDrain: WorkloadLogDrain;
	private readonly storage: StorageRequester;
	private readonly databaseStats: DatabaseStatsSampler;
	private readonly databaseBackups: DatabaseBackupRunner;
	private readonly databaseRotations: DatabaseRotationRunner;
	private readonly databaseCredentials: DatabaseCredentialRunner;
	private readonly databasePoolerRestarts: DatabasePoolerRestartRunner;
	private readonly storageAdmin: StorageReconciler;
	private readonly storageStats: StorageStatsSampler;

	private desired: DesiredState | null = null;
	private desiredEtag: string | null = null;
	private convergedVersion: number | null = null;
	private actualStateVersion = 0;
	private projectByHost = new Map<string, string>();
	private readonly usedTokens = new UsedTokenCache();

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
	private volumeInventory: VolumeInventory | null = null;
	private volumeInventoryAt = 0;

	private readonly reconcileBackoff = new Backoff(1_000, 30_000);
	private readonly heartbeatBackoff = new Backoff(5_000, 60_000);

	constructor(config: AgentConfig) {
		this.config = config;
		this.store = new DesiredStateStore(config.dataDir);
		this.releases = new ReleaseManager(config.dataDir);
		this.caddy = new CaddyAdmin(config.caddyAdminSocket);
		this.stats = new StatsCollector(config.dataDir);
		this.certs = config.certProbe
			? new CertProbe(
					() =>
						certProbeTargets(
							this.desired ? this.contentDomain(this.desired) : config.contentDomain,
							config.platformHost,
						),
					tlsCertReader(config.certProbe),
				)
			: null;
		this.helper = new HelperClient(config.helperSocket);
		this.storage = new StorageRequester(config.storageStateFile, config.storageRequestFile);
		this.logDrain = new WorkloadLogDrain({
			helper: this.helper,
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			intervalMs: config.logDrainIntervalMs,
			log,
		});
		this.workloads = new WorkloadRuntime({
			helper: this.helper,
			releases: this.releases,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			sliceMemoryMb: config.workloadSliceMb,
			socketDir: config.workloadSocketDir,
			healthTimeoutMs: config.workloadHealthTimeoutMs,
			statePath: join(config.dataDir, 'workloads-state.json'),
			log,
		});
		this.databaseStats = new DatabaseStatsSampler({ source: this.workloads, log });
		this.databaseBackups = new DatabaseBackupRunner({ helper: this.helper, log });
		this.databaseRotations = new DatabaseRotationRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.databaseCredentials = new DatabaseCredentialRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.databasePoolerRestarts = new DatabasePoolerRestartRunner({ helper: this.helper, log });
		// Buckets and scoped keys are desired state converged over the loopback S3/admin API; the
		// root key and user secrets stay in the workload runtime's memory (S4).
		this.storageAdmin = new StorageReconciler({ source: this.workloads, log });
		this.storageStats = new StorageStatsSampler({ source: this.workloads, log });
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

		this.loops = [
			this.reconcileLoop(),
			this.heartbeatLoop(),
			this.telemetryLoop(),
			this.databaseStatsLoop(),
			this.databaseBackupLoop(),
			this.databaseRotationLoop(),
			this.databaseCredentialLoop(),
			this.databasePoolerRestartLoop(),
			this.storageAdminLoop(),
			this.storageStatsLoop(),
		];
		if (this.config.logDrain)
			this.loops.push(this.logDrain.run(() => this.desired, this.shutdownController.signal));
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
			const reports = this.workloads.currentReports();
			return Response.json({
				ok: true,
				nodeId: this.config.nodeId,
				caddyOk: this.caddyOk,
				desiredStateVersion: this.desired?.version ?? 0,
				actualStateVersion: this.actualStateVersion,
				workloads: {
					total: reports.length,
					running: reports.filter((report) => report.status === 'running').length,
				},
				lastReconcileSuccessAt: this.lastReconcileSuccessAt,
			});
		}
		return handleSiteRequest(request, {
			state: this.desired,
			cookieName: this.config.cookieName,
			insecureHttp: this.config.insecureHttp,
			usedTokens: this.usedTokens,
		});
	}

	// --- desired state -------------------------------------------------------

	private async reconcileLoop(): Promise<void> {
		while (this.running) {
			if (
				this.desired &&
				(this.convergedVersion !== this.desired.version || this.workloads.needsRetry()) &&
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
				// After a failed converge, pull unconditionally: the version may not have changed, but
				// a fresh copy carries freshly presigned release URLs (the old ones expire after 1 h).
				const force = this.pullBeforeConverge;
				const started = Date.now();
				const changed = await this.pullDesiredState(force);
				this.pullBeforeConverge = false;
				this.reconcileBackoff.reset();
				if (!changed) {
					// A control plane that supports long-poll holds the request. If it answered instantly
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

	private async pullDesiredState(force = false): Promise<boolean> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.config.nodeToken}`,
			accept: 'application/json',
		};
		const etag = this.desiredEtag ?? (this.desired ? desiredStateEtag(this.desired) : null);
		if (etag && !force) headers['if-none-match'] = etag;

		const timeout = AbortSignal.timeout(LONG_POLL_TIMEOUT_MS);
		const signal = AbortSignal.any([this.shutdownController.signal, timeout]);

		let response: Response;
		try {
			response = await fetch(
				`${this.config.controlUrl}/api/agent/desired-state?wait=${force ? 0 : LONG_POLL_SECONDS}`,
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

	/**
	 * Secret values are fetched only when a workload is (re)applied, straight from the control
	 * plane, and handed to the helper. They never touch desired-state.json (D18, D23).
	 */
	private async fetchWorkloadActivation(
		id: string,
		signal: AbortSignal,
	): Promise<WorkloadActivation> {
		const response = await fetch(
			`${this.config.controlUrl}/api/agent/workloads/${encodeURIComponent(id)}/activation`,
			{
				headers: {
					authorization: `Bearer ${this.config.nodeToken}`,
					accept: 'application/json',
				},
				signal,
			},
		);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`workload activation -> ${response.status}${text ? `: ${text}` : ''}`);
		}
		const parsed = workloadActivationSchema.safeParse(await response.json());
		if (!parsed.success)
			throw new Error(`workload activation failed validation: ${parsed.error.message}`);
		return parsed.data;
	}

	private async converge(state: DesiredState): Promise<void> {
		const started = Date.now();
		this.lastReconcileAttemptAt = started;

		const specs = new Map(state.releases.map((release) => [release.sha256, release]));
		// Worker-placed routes are proxied over WireGuard; their releases live on the worker.
		const localRoutes = state.routes.filter((route) => !route.upstream);
		for (const release of state.releases) {
			try {
				const downloaded = await this.releases.ensureRelease(release, this.shutdownController.signal);
				if (downloaded) log('info', `Cached release ${release.sha256.slice(0, 12)}`);
			} catch (error) {
				throw new Error(`release ${release.sha256.slice(0, 12)}: ${errorText(error)}`);
			}
		}

		for (const route of localRoutes) {
			if (!(await this.releases.hasRelease(route.release))) {
				const spec = specs.get(route.release);
				if (!spec)
					throw new Error(`route ${route.host} references unknown release ${route.release.slice(0, 12)}`);
				await this.releases.ensureRelease(spec, this.shutdownController.signal);
			}
			// Previews are rooted at their own release; only production goes through the
			// per-project symlink, so promote/rollback is an atomic swap.
			if (isProductionRoute(route, state.contentDomain))
				await this.releases.activate(route.projectId, route.release);
		}

		// The helper needs the registered volumes before it can resolve a volume-backed data dir
		// (D74). A failure is logged; affected workloads then fail closed at start (D76).
		try {
			await this.helper.syncVolumes(state.volumes, this.shutdownController.signal);
		} catch (error) {
			log('error', `Volume registry sync failed: ${errorText(error)}`);
		}

		// Tier 2/3 workloads converge before Caddy loads their upstreams. A helper outage or a
		// broken workload must never take static serving down, so failures are logged inside the
		// runtime and this call is defensive as well.
		try {
			await this.workloads.converge(state, this.shutdownController.signal);
		} catch (error) {
			log('error', `Workload converge failed: ${errorText(error)}`);
		}

		const tls = this.config.tls ? this.tlsOptions(state) : undefined;
		const caddyConfig = buildCaddyConfig({
			state,
			// With TLS enabled Caddy owns :443 and site-config adds the :80 redirect server.
			listen: tls ? [':443'] : this.config.caddyListen,
			dataDir: this.config.dataDir,
			agentSocket: this.config.agentSocket,
			caddyAdminSocket: this.config.caddyAdminSocket,
			accessLog: this.config.caddyAccessLog,
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

		// Bucket and key changes are desired state too (S4): converge them now instead of waiting
		// for the minute loop. The reconciler never throws and coalesces overlapping rounds.
		void this.storageAdmin.reconcile();
	}

	/** Best-effort content domain for the cert probe; never throws. */
	private contentDomain(state: DesiredState): string | null {
		try {
			return this.config.contentDomain ?? (state.contentDomain || deriveContentDomain(state));
		} catch {
			return null;
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

	/** Dump/restore tasks run beside the normal reconcile loop; they never block static serving. */
	private async databaseBackupLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				const running = new Set(
					this.workloads
						.currentReports()
						.filter((report) => report.status === 'running')
						.map((report) => report.id),
				);
				await this.databaseBackups.runOnce(state, (id) => running.has(id), this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database backup task failed: ${errorText(error)}`);
			}
		}
	}

	private async databasePoolerRestartLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databasePoolerRestarts.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database pooler restart failed: ${errorText(error)}`);
			}
		}
	}

	private async databaseRotationLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databaseRotations.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database rotation task failed: ${errorText(error)}`);
			}
		}
	}

	private async databaseCredentialLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databaseCredentials.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database credential task failed: ${errorText(error)}`);
			}
		}
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
		// Cached; refreshed in the background at most every ~6 h (cert-expiry alert, DESIGN §8).
		const certs = this.certs?.current() ?? [];
		if (certs.length > 0) stats.certs = certs;
		// Actual unit state, so restart loops and OOM kills show up in the fleet view.
		const reports = await this.workloads.refreshReports();
		const storage = await this.storage.status();
		// Purged data dirs (D59, S8); cleared only once the control plane accepts this heartbeat.
		const purgedDatabases = this.workloads.pendingPurgedDatabases();
		const purgedStorage = this.workloads.pendingPurgedStorage();
		const volumeInventory = await this.volumeInventoryForHeartbeat();
		const backupResults = this.databaseBackups.pendingResults();
		const rotationResults = this.databaseRotations.pendingResults();
		const credentialResults = this.databaseCredentials.pendingResults();
		const poolerRestarted = this.databasePoolerRestarts.pending();
		// Bucket deletions are reported once, capped by the heartbeat schema (S8).
		const storageBucketDeletions = this.storageAdmin.pendingBucketDeletions().slice(0, 500);
		// A storage move happens outside the agent's sandbox (D48); ask for it while it is due.
		await this.storage
			.reconcile(this.desired?.storage, storage)
			.then((requested) => {
				if (requested) log('info', 'Requested a storage move from skiff-storage.service');
			})
			.catch((error: unknown) => log('warn', `Could not request a storage move: ${errorText(error)}`));
		const body: Heartbeat = {
			nodeId: this.config.nodeId,
			agentVersion: this.config.agentVersion,
			actualStateVersion: this.actualStateVersion,
			status: requestedStatus === 'draining' ? 'draining' : this.caddyOk ? 'online' : 'offline',
			caddyOk: this.caddyOk,
			stats,
			releases: this.releases.listReleases(),
			...(storage ? { storage } : {}),
			...(reports.length > 0 ? { workloads: workloadHeartbeat(reports) } : {}),
			...(backupResults.length > 0 ? { databaseBackupResults: backupResults } : {}),
			...(rotationResults.length > 0 ? { databaseRotationResults: rotationResults } : {}),
			...(credentialResults.length > 0 ? { databaseCredentialResults: credentialResults } : {}),
			...(poolerRestarted.length > 0 ? { databasePoolerRestarted: poolerRestarted } : {}),
			...(purgedDatabases.length > 0 ? { purgedDatabases } : {}),
			...(purgedStorage.length > 0 ? { purgedStorage } : {}),
			...(storageBucketDeletions.length > 0 ? { storageBucketDeletions } : {}),
			...(volumeInventory ? { volumes: volumeInventory } : {}),
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
		this.databaseBackups.acknowledge(backupResults.map((result) => result.taskId));
		this.databaseRotations.acknowledge(rotationResults.map((result) => result.taskId));
		this.databaseCredentials.acknowledge(credentialResults.map((result) => result.taskId));
		this.databasePoolerRestarts.acknowledge(poolerRestarted);
		this.workloads.acknowledgePurgedDatabases(purgedDatabases);
		this.workloads.acknowledgePurgedStorage(purgedStorage);
		this.storageAdmin.acknowledgeBucketDeletions(storageBucketDeletions);
		return true;
	}

	/** Cached mount/device inventory (D72, D80); a failure keeps the last report and retries later. */
	private async volumeInventoryForHeartbeat(): Promise<VolumeInventory | null> {
		if (this.volumeInventory && Date.now() - this.volumeInventoryAt < VOLUME_INVENTORY_INTERVAL_MS)
			return this.volumeInventory;
		try {
			this.volumeInventory = await this.helper.volumes(this.shutdownController.signal);
		} catch (error) {
			log('warn', `Volume inventory failed: ${errorText(error)}`);
		} finally {
			// Throttle retries too: the helper may be down, and the next heartbeat is 10 s away.
			this.volumeInventoryAt = Date.now();
		}
		return this.volumeInventory;
	}

	private async checkCaddy(): Promise<void> {
		try {
			await this.caddy.health(this.shutdownController.signal);
			this.caddyOk = true;
		} catch {
			this.caddyOk = false;
			return;
		}
		// A restarted Caddy comes back with the bootstrap Caddyfile and none of our routes. Our
		// config always carries the `catch-all` id, so its absence means we must re-apply.
		if (this.convergedVersion === null) return;
		try {
			if (!(await this.caddy.hasId(CONVERGED_SENTINEL_ID, this.shutdownController.signal))) {
				log('warn', 'Caddy lost the Skiff config (restart?); re-applying routes');
				this.convergedVersion = null;
			}
		} catch {
			// A transient admin error is not proof of a restart; the next check will tell.
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

	/**
	 * Managed database samples (D57). Independent of the access-log tail, so a node without Caddy
	 * access logging still reports its databases. Credentials stay in the runtime's memory.
	 */
	private async databaseStatsLoop(): Promise<void> {
		while (this.running) {
			await sleep(DATABASE_STATS_INTERVAL_MS, this.shutdownController.signal);
			if (!this.running) break;
			try {
				await this.databaseStats.sample();
			} catch (error) {
				log('warn', `Database sampling failed: ${errorText(error)}`);
			}
			try {
				await this.databaseStats.flush((payload) =>
					postTelemetryBatch(
						{
							controlUrl: this.config.controlUrl,
							nodeToken: this.config.nodeToken,
							nodeId: this.config.nodeId,
						},
						payload,
					),
				);
			} catch (error) {
				log('warn', `Database telemetry flush failed: ${errorText(error)}`);
			}
		}
	}

	/**
	 * Bucket and scoped-key convergence (S4, S8). Desired-state changes also trigger a round at
	 * the end of `converge`, so this loop is the repair/retry path.
	 */
	private async storageAdminLoop(): Promise<void> {
		while (this.running) {
			try {
				await this.storageAdmin.reconcile();
			} catch (error) {
				log('warn', `Storage reconcile failed: ${errorText(error)}`);
			}
			if (!this.running) break;
			await sleep(STORAGE_RECONCILE_INTERVAL_MS, this.shutdownController.signal);
		}
	}

	/** Object storage usage and per-bucket snapshots (S7), riding the telemetry batch. */
	private async storageStatsLoop(): Promise<void> {
		while (this.running) {
			await sleep(STORAGE_STATS_INTERVAL_MS, this.shutdownController.signal);
			if (!this.running) break;
			try {
				await this.storageStats.sample();
			} catch (error) {
				log('warn', `Storage sampling failed: ${errorText(error)}`);
			}
			try {
				await this.storageStats.flush((payload) =>
					postTelemetryBatch(
						{
							controlUrl: this.config.controlUrl,
							nodeToken: this.config.nodeToken,
							nodeId: this.config.nodeId,
						},
						payload,
					),
				);
			} catch (error) {
				log('warn', `Storage telemetry flush failed: ${errorText(error)}`);
			}
		}
	}

	// --- metrics -------------------------------------------------------------

	private metricsText(): string {
		const telemetry = this.telemetry?.stats;
		const workloadReports = this.workloads.currentReports();
		const measurements: Array<[string, string, 'counter' | 'gauge', number]> = [
			['skiff_agent_caddy_up', 'Whether the Caddy admin API is reachable.', 'gauge', this.caddyOk ? 1 : 0],
			['skiff_agent_routes', 'Routes in the current desired state.', 'gauge', this.desired?.routes.length ?? 0],
			['skiff_agent_releases', 'Verified releases on disk.', 'gauge', this.releases.listReleases().length],
			[
				'skiff_agent_workloads_total',
				'Workloads reported by this node.',
				'gauge',
				workloadReports.length,
			],
			[
				'skiff_agent_workloads_running',
				'Workloads currently running.',
				'gauge',
				workloadReports.filter((report) => report.status === 'running').length,
			],
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
			[
				'skiff_agent_database_samples_dropped_total',
				'Database samples and snapshots dropped to keep memory bounded.',
				'counter',
				this.databaseStats.dropped,
			],
			[
				'skiff_agent_storage_samples_dropped_total',
				'Storage samples and snapshots dropped to keep memory bounded.',
				'counter',
				this.storageStats.dropped,
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
	const subcommand = (name: string) => (process.argv[2] === name ? 2 : process.argv[1] === name ? 1 : -1);
	const joinIndex = subcommand('join');
	const storageIndex = subcommand('storage');
	if (storageIndex >= 0) {
		// Root-only node storage moves (D48), run by skiff-storage.service.
		const { runStorageCli } = await import('./storage-apply.ts');
		process.exitCode = await runStorageCli(process.argv.slice(storageIndex + 1));
	} else if (subcommand('builder') >= 0) {
		// The git Builder ships inside the agent binary so every node can build (D47). It runs as its
		// own unit (`skiff-builder.service`), never inside the agent's sandbox or memory budget.
		const { runBuilder } = await import('@skiff/builder');
		await runBuilder().catch((error: unknown) => {
			console.error(`[skiff-agent builder] fatal: ${errorText(error)}`);
			process.exitCode = 1;
		});
	} else if (joinIndex >= 0) {
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
