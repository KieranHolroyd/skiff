import { existsSync, promises as fs, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	desiredStateSchema,
	heartbeatSchema,
	nodeCapabilities,
	FUNCTIONS_PYTHON_CAPABILITY,
	PROCESS_NODE_CAPABILITY,
	WORKERD_INSTALL_DIR,
	WORKERD_PINNED_VERSION,
	workloadActivationSchema,
	type DesiredState,
	type Heartbeat,
	type NodeStudioDesired,
	type NodeContainerConsoleDesired,
	type NodeStatus,
	type VolumeInventory,
	type WireguardStatus,
	type WorkloadActivation,
} from '@skiff/contracts';
import type { TlsOptions } from '@skiff/site-config';
import { startAnalyticsSink, type AnalyticsSink } from './analytics-sink.ts';
import { CaddyAdmin } from './caddy.ts';
import { CertProbe, certProbeTargets, tlsCertReader } from './certs.ts';
import { buildCaddyConfig, isProductionRoute, tlsSubjects } from './caddy-config.ts';
import { loadConfig, type AgentConfig } from './config.ts';
import { controlSocketFetch } from './control-socket.ts';
import { DatabaseBackupRunner } from './database-backups.ts';
import { AppVolumeRunner } from './app-volumes.ts';
import { ShareMountRunner } from './share-mounts.ts';
import { DiskMountRunner } from './disk-mounts.ts';
import { VolumeProfileRunner } from './volume-profiles.ts';
import { DatabasePitrRunner } from './database-pitr.ts';
import { DatabaseCredentialRunner } from './database-credentials.ts';
import { StudioPrincipalRunner } from './studio/principal.ts';
import { MailBridge } from './mail-bridge.ts';
import { NodeUpdateRunner } from './node-update.ts';
import { DatabasePoolerRestartRunner } from './database-pooler-restarts.ts';
import { DatabaseReplicationRunner } from './database-replication.ts';
import { ReplicaLinkForwarder } from './replica-links.ts';
import { DatabaseRotationRunner } from './database-rotations.ts';
import { DATABASE_STATS_INTERVAL_MS, DatabaseStatsSampler } from './database-stats.ts';
import { FunctionScheduler } from './function-scheduler.ts';
import { FunctionQueueConsumers } from './function-queues.ts';
import { EventPublisher } from './event-publisher.ts';
import { NodeTaskRunner } from './node-tasks.ts';
import { JobRunner } from './jobs.ts';
import { HelperClient } from './helper-client.ts';
import { formatEnv, JOIN_USAGE, joinNode, nodeFilePath, parseJoinArgs } from './join.ts';
import { WorkloadLogDrain } from './log-drain.ts';
import { ReleaseManager } from './releases.ts';
import { databaseTlsHeartbeat, WorkloadRuntime, workloadHeartbeat } from './runtime.ts';
import { HardwareCollector } from './hardware.ts';
import { ServiceForwarder } from './endpoints.ts';
import { NodeCertificateManager } from './node-cert.ts';
import { StatsCollector } from './stats.ts';
import { StorageReconciler, STORAGE_RECONCILE_INTERVAL_MS } from './storage-admin.ts';
import { StorageRequester } from './storage.ts';
import { StorageStatsSampler, STORAGE_STATS_INTERVAL_MS } from './storage-stats.ts';
import { StorageReplicator } from './storage-replicator.ts';
import { BROKER_STATS_INTERVAL_MS, BrokerStatsSampler } from './broker-stats.ts';
import { DesiredStateStore, desiredStateEtag, desiredStateRequest } from './state.ts';
import { postTelemetryBatch, TelemetryClient } from './telemetry.ts';
import { handleSiteRequest, normalizeHost, UsedTokenCache } from './verify.ts';
import type { StudioFront } from './studio/front.ts';
import { ConsoleFront, controlPlaneConsoleActivationFetcher } from './console-front.ts';

const HEARTBEAT_INTERVAL_MS = 10_000;
// Bun's default idle timeout on the control plane is 10 s (adapter-bun CONNECTION_IDLE_TIMEOUT),
// so hold well under it. The server caps `wait` at 25 s for installs that raise the timeout.
const LONG_POLL_SECONDS = 8;
const LONG_POLL_TIMEOUT_MS = (LONG_POLL_SECONDS + 10) * 1_000;
const TELEMETRY_INTERVAL_MS = 60_000;
/** Unreferenced images are pruned at most this often (docs/REGISTRY.md R3). */
const IMAGE_PRUNE_INTERVAL_MS = 60 * 60_000;
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
	private readonly hardware: HardwareCollector;
	private readonly serviceForwarder: ServiceForwarder;
	private readonly nodeCertificate: NodeCertificateManager;
	private wireguardStatus: WireguardStatus | null = null;
	private wireguardStatusAt = 0;
	private readonly certs: CertProbe | null;
	private readonly helper: HelperClient;
	/** Email (docs/EMAIL.md): runs and feeds skiff-mail when this node is the mail node. */
	private readonly mail: MailBridge;
	private readonly workloads: WorkloadRuntime;
	private readonly logDrain: WorkloadLogDrain;
	private readonly storage: StorageRequester;
	private readonly databaseStats: DatabaseStatsSampler;
	private readonly databaseBackups: DatabaseBackupRunner;
	/** App-volume usage, purges, snapshots and restores (docs/VOLUMES.md §14). */
	private readonly appVolumes: AppVolumeRunner;
	/** Network share mounts under /mnt/skiff-shares (docs/VOLUMES.md §5). */
	private readonly shareMounts: ShareMountRunner;
	private readonly diskMounts: DiskMountRunner;
	/** Storage benchmarks of node volumes (docs/STORAGE.md §5). */
	private readonly volumeProfiles: VolumeProfileRunner;
	private readonly databasePitr: DatabasePitrRunner;
	private readonly databaseRotations: DatabaseRotationRunner;
	private readonly databaseCredentials: DatabaseCredentialRunner;
	private readonly studioPrincipals: StudioPrincipalRunner;
	private readonly nodeUpdate: NodeUpdateRunner;
	private readonly databasePoolerRestarts: DatabasePoolerRestartRunner;
	/** Primary-side configure/sample and replica promotion (C7). */
	private readonly databaseReplication: DatabaseReplicationRunner;
	/** Unix sockets the replica containers stream through (C7). */
	private readonly replicaLinks: ReplicaLinkForwarder;
	private readonly storageAdmin: StorageReconciler;
	private readonly storageStats: StorageStatsSampler;
	private readonly storageReplicator: StorageReplicator;
	private readonly brokerStats: BrokerStatsSampler;
	private readonly functions: FunctionScheduler;
	private readonly functionQueues: FunctionQueueConsumers;
	private readonly eventPublisher: EventPublisher;
	private readonly nodeTasks: NodeTaskRunner;
	/** App cron jobs and one-off commands (plan 09). */
	private readonly jobs: JobRunner;

	private desired: DesiredState | null = null;
	private desiredEtag: string | null = null;
	/** Whether this process has pulled a full desired state yet; see `desiredStateRequest`. */
	private desiredPulledThisRun = false;
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
	/** The registry mirror last applied (G4); `undefined` until the first reconcile checks it. */
	private appliedMirror: string | undefined;
	private appliedMirrorHost: string | undefined;

	/** Image prune (docs/REGISTRY.md R3): at most hourly, after a reconcile, never two at once. */
	private lastImagePruneAt = 0;
	private imagePruneRunning = false;
	private imagePruneWarned = false;
	private lastReconcileSuccessAt = 0;
	private reconcileFailures = 0;
	private heartbeatFailures = 0;

	private telemetry: TelemetryClient | null = null;
	private telemetryStartWarned = false;
	/** Loopback sink function hosts POST Analytics Engine datapoints to (docs/FUNCTIONS.md §4.5). */
	private analyticsSink: AnalyticsSink | null = null;
	private heartbeatWasFailing = false;
	private pullBeforeConverge = false;
	private volumeInventory: VolumeInventory | null = null;
	private volumeInventoryAt = 0;
	/** Native studio front (plan 22), loaded only once desired state first enables it. */
	private studioFront: Promise<StudioFront> | null = null;
	private studioUpdates: Promise<void> = Promise.resolve();
	/** Container console front (D127), created once desired state first opens it. */
	private consoleFront: ConsoleFront | null = null;

	private readonly reconcileBackoff = new Backoff(1_000, 30_000);
	private readonly heartbeatBackoff = new Backoff(5_000, 60_000);

	constructor(config: AgentConfig) {
		this.config = config;
		this.store = new DesiredStateStore(config.dataDir);
		this.releases = new ReleaseManager(config.dataDir);
		this.caddy = new CaddyAdmin(config.caddyAdminSocket);
		this.stats = new StatsCollector(config.dataDir);
		this.hardware = new HardwareCollector();
		this.nodeCertificate = new NodeCertificateManager(config.dataDir, config.nodeId);
		this.serviceForwarder = new ServiceForwarder({
			log: (level, message) => log(level, message),
			...(this.nodeCertificate.ensure() ? { certificate: this.nodeCertificate.ensure()! } : {}),
		});
		this.certs = config.certProbe
			? new CertProbe(
					() =>
						certProbeTargets(
							this.desired ? this.contentDomain(this.desired) : config.contentDomain,
							config.platformHost,
							// Verified custom domains: a certificate here is what makes them `active`.
							(this.desired?.domains ?? []).map((domain) => domain.host),
						),
					tlsCertReader(config.certProbe),
				)
			: null;
		this.helper = new HelperClient(config.helperSocket);
		this.mail = new MailBridge({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			socketPath: process.env.SKIFF_MAIL_SOCKET?.trim() || '/run/skiff/mail.sock',
			helper: this.helper,
			log,
		});
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
		this.appVolumes = new AppVolumeRunner({ helper: this.helper, log });
		this.volumeProfiles = new VolumeProfileRunner({ helper: this.helper, log });
		this.shareMounts = new ShareMountRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.diskMounts = new DiskMountRunner({ helper: this.helper, log });
		this.databasePitr = new DatabasePitrRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
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
		this.studioPrincipals = new StudioPrincipalRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			log,
		});
		this.databasePoolerRestarts = new DatabasePoolerRestartRunner({ helper: this.helper, log });
		this.databaseReplication = new DatabaseReplicationRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			runtime: this.workloads,
			log,
		});
		// Must equal the helper's SKIFF_HELPER_REPLICATION_DIR (the installer uses /var/lib/skiff/agent).
		this.replicaLinks = new ReplicaLinkForwarder({
			root: join(config.dataDir, 'replication'),
			log: (level, message) => log(level, message),
			...(this.nodeCertificate.ensure() ? { certificate: this.nodeCertificate.ensure()! } : {}),
		});
		this.nodeUpdate = new NodeUpdateRunner({
			helper: this.helper,
			currentVersion: config.agentVersion,
			statePath: join(config.dataDir, 'node-update.json'),
			log,
		});
		// Buckets and scoped keys are desired state converged over the loopback S3/admin API; the
		// root key and user secrets stay in the workload runtime's memory (S4).
		this.storageAdmin = new StorageReconciler({ source: this.workloads, log });
		this.storageStats = new StorageStatsSampler({ source: this.workloads, log });
		// Bucket replication links this node runs (§12): copies objects to or from a peer instance
		// through the peer node's gateway, with each link's scoped key. Progress rides the heartbeat.
		this.storageReplicator = new StorageReplicator({
			source: this.workloads,
			statePath: join(config.dataDir, 'storage-replication.json'),
			log,
		});
		// Broker samples (D123) over each broker's own client connection; the password is fetched
		// from the activation on demand and kept only in the open connection.
		this.brokerStats = new BrokerStatsSampler({
			source: this.workloads,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			log,
		});
		// Scale to zero, the runaway watchdog and cron all run on the node (FN4, FN5, FN9).
		this.functions = new FunctionScheduler({
			helper: this.helper,
			socketDir: config.workloadSocketDir,
			statePath: join(config.dataDir, 'function-cron-state.json'),
			// Without the access log there is no request signal; never idle-stop a serving host.
			activityEnabled: Boolean(config.caddyAccessLog),
			log,
		});
		// Function queues on managed brokers (D112): pull batches and deliver them to the shim.
		this.functionQueues = new FunctionQueueConsumers({
			socketDir: config.workloadSocketDir,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			noteActivity: (projectId) => this.functions.noteActivity(projectId),
			log,
		});
		// Event notifications (D122): publish the control plane's outbox into local brokers.
		this.eventPublisher = new EventPublisher({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			log,
		});
		// Queue and function tools (D124): run the control plane's one-shot tasks for this node.
		this.nodeTasks = new NodeTaskRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			socketDir: config.workloadSocketDir,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			workloadStatus: async (id) => (await this.helper.status(id)).status,
			noteActivity: (projectId) => this.functions.noteActivity(projectId),
			log,
		});
		// Job runs (plan 09): lease, start through the helper, watch, drain output, report.
		this.jobs = new JobRunner({
			controlUrl: config.controlUrl,
			nodeToken: config.nodeToken,
			helper: this.helper,
			fetchActivation: (id, signal) => this.fetchWorkloadActivation(id, signal),
			statePath: join(config.dataDir, 'jobs-state.json'),
			log,
		});
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
				this.applyStudio(cached.state.studio);
				this.applyConsole(cached.state.containerConsole);
				this.mail.apply(cached.state.mail);
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
				// Access-log aggregation is the request signal scale-to-zero measures (FN4). Resolve
				// first, then record activity, so telemetry behaviour itself is unchanged.
				resolveProject: (host) => {
					const projectId = this.projectByHost.get(normalizeHost(host)) ?? null;
					if (projectId) this.functions.noteActivity(projectId);
					return projectId;
				},
			});
		}

		// Function hosts POST Analytics Engine datapoints and tail events here over an `external`
		// service. The sink is independent of the access-log tail (a binding writes even with no
		// Caddy log configured) and a bind failure is logged, not fatal: telemetry must never keep
		// the agent from booting.
		try {
			this.analyticsSink = startAnalyticsSink({
				port: this.config.functionAnalyticsPort,
				record: (event) => this.telemetry?.recordAnalytics(event),
				recordTail: (event) => this.telemetry?.recordTail(event),
				log,
			});
		} catch (error) {
			log(
				'warn',
				`Analytics Engine sink unavailable on 127.0.0.1:${this.config.functionAnalyticsPort}: ${errorText(error)}`,
			);
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
			this.appVolumeLoop(),
			this.shareMountLoop(),
			this.volumeProfileLoop(),
			this.databasePitrLoop(),
			this.databaseRotationLoop(),
			this.databaseCredentialLoop(),
			this.databasePoolerRestartLoop(),
			this.databaseReplicationLoop(),
			this.nodeUpdateLoop(),
			this.storageAdminLoop(),
			this.storageStatsLoop(),
			this.storageReplicator.run(this.shutdownController.signal),
			this.brokerStatsLoop(),
			this.functions.run(() => this.desired, this.shutdownController.signal),
			this.functionQueues.run(() => this.desired, this.shutdownController.signal),
			this.eventPublisher.run(() => this.desired, this.shutdownController.signal),
			this.nodeTasks.run(() => this.desired, this.shutdownController.signal),
			this.jobs.run(() => this.desired, this.shutdownController.signal),
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
		this.brokerStats.close();
		// Stop the sink before the telemetry client so its last flush carries any buffered events.
		this.analyticsSink?.stop();
		this.analyticsSink = null;
		await this.telemetry?.stop().catch(() => undefined);
		await this.studioUpdates;
		if (this.studioFront) (await this.studioFront.catch(() => null))?.stop();
		this.consoleFront?.stop();
		await this.mail.close();
		this.serviceForwarder.close();
		await this.replicaLinks.close();
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
		const request = desiredStateRequest({
			etag: this.desiredEtag ?? (this.desired ? desiredStateEtag(this.desired) : null),
			force,
			pulledThisRun: this.desiredPulledThisRun,
			longPollSeconds: LONG_POLL_SECONDS,
		});
		if (request.ifNoneMatch) headers['if-none-match'] = request.ifNoneMatch;

		const timeout = AbortSignal.timeout(LONG_POLL_TIMEOUT_MS);
		const signal = AbortSignal.any([this.shutdownController.signal, timeout]);

		let response: Response;
		try {
			response = await fetch(
				`${this.config.controlUrl}/api/agent/desired-state?wait=${request.waitSeconds}`,
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
		// Same version as the cache but different content: the cache lost fields this build applies.
		const content = (value: DesiredState) => JSON.stringify({ ...value, generatedAt: '' });
		if (!this.desiredPulledThisRun && this.desired && content(this.desired) !== content(state))
			this.convergedVersion = null;
		this.desired = state;
		this.desiredEtag = etagHeader;
		this.desiredPulledThisRun = true;
		this.applyStudio(state.studio);
		this.applyConsole(state.containerConsole);
		this.mail.apply(state.mail);
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
	 * Point the studio front at the desired port and live sessions. Updates are serialised and
	 * never block convergence; the front module is imported only once a studio is enabled.
	 */
	private applyStudio(desired: NodeStudioDesired | null): void {
		if (!desired && !this.studioFront) return;
		this.studioFront ??= import('./studio/front.ts').then(
			({ StudioFront, controlPlaneActivationFetcher }) =>
				new StudioFront({
					fetchActivation: controlPlaneActivationFetcher({
						controlUrl: this.config.controlUrl,
						nodeToken: this.config.nodeToken,
						signal: this.shutdownController.signal,
					}),
					helper: this.helper,
					log,
				}),
		);
		const front = this.studioFront;
		this.studioUpdates = this.studioUpdates
			.then(async () => (await front).update(desired))
			.catch((error: unknown) => log('error', `Studio front update failed: ${errorText(error)}`));
	}

	/** Open, move or close the container console front (D127). Never blocks convergence. */
	private applyConsole(desired: NodeContainerConsoleDesired | null): void {
		if (!desired && !this.consoleFront) return;
		this.consoleFront ??= new ConsoleFront({
			fetchActivation: controlPlaneConsoleActivationFetcher({
				controlUrl: this.config.controlUrl,
				nodeToken: this.config.nodeToken,
				signal: this.shutdownController.signal,
			}),
			helper: this.helper,
			log,
		});
		try {
			this.consoleFront.update(desired);
		} catch (error) {
			log('error', `Container console front update failed: ${errorText(error)}`);
		}
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

		// Shares and partitions first: a volume on one must be mounted before a workload on it starts.
		await this.convergeShareMounts(state);
		await this.convergeDiskMounts(state);

		// The helper needs the registered volumes before it can resolve a volume-backed data dir
		// (D74). A failure is logged; affected workloads then fail closed at start (D76).
		try {
			await this.helper.syncVolumes(state.volumes, this.shutdownController.signal);
		} catch (error) {
			log('error', `Volume registry sync failed: ${errorText(error)}`);
		}

		// Consumer loopback endpoints and provider overlay listeners (C2). Harmless when empty.
		try {
			this.serviceForwarder.converge(state.serviceEndpoints, state.serviceProviders);
		} catch (error) {
			log('error', `Service endpoint converge failed: ${errorText(error)}`);
		}
		// Replica link sockets before the replica workloads, whose units mount their directories (C7).
		try {
			await this.replicaLinks.converge(state.databaseReplicaLinks ?? []);
		} catch (error) {
			log('error', `Replica link converge failed: ${errorText(error)}`);
		}

		// The overlay must be up before a workload tries a cross-node service endpoint (C1).
		if (state.wireguard) {
			try {
				await this.helper.wireguardApply(state.wireguard);
			} catch (error) {
				log('error', `WireGuard apply failed: ${errorText(error)}`);
			}
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
		void this.maybePruneImages();
		void this.applyRegistryMirror(state);

		// Bucket and key changes are desired state too (S4): converge them now instead of waiting
		// for the minute loop. The reconciler never throws and coalesces overlapping rounds.
		void this.storageAdmin.reconcile();
	}

	/**
	 * The platform registry's pull-through cache (G4): Podman mirrors for docker.io/ghcr.io/quay.io
	 * point at the registry, and root logs in there with this node's token. Re-applied when the
	 * desired mirror changes and once after every agent start (the auth file lives in /run).
	 */
	private async applyRegistryMirror(state: DesiredState): Promise<void> {
		const mirror = state.registryMirror ?? null;
		const key = JSON.stringify(mirror);
		if (key === this.appliedMirror) return;
		try {
			await this.helper.applyRegistryMirror({
				// Removing uses the host last applied, so its login leaves root's auth file too.
				host: mirror?.host ?? this.appliedMirrorHost ?? 'registry.invalid',
				upstreams: mirror?.upstreams ?? [],
				username: `node.${this.config.nodeId}`,
				password: this.config.nodeToken,
			});
			this.appliedMirror = key;
			this.appliedMirrorHost = mirror?.host;
			if (mirror) log('info', `Registry mirror for ${mirror.upstreams.join(', ')} → ${mirror.host}`);
		} catch (error) {
			// Older helpers lack the verb: nothing to undo, pulls go straight upstream.
			log('warn', `Registry mirror not applied: ${errorText(error)}`);
			this.appliedMirror = key;
		}
	}

	/**
	 * Ask the helper to drop images no unit or container references (R3). Every deploy of a new
	 * digest otherwise leaves the old image on disk. Failures are logged once and retried next hour.
	 */
	private async maybePruneImages(): Promise<void> {
		if (this.imagePruneRunning || Date.now() - this.lastImagePruneAt < IMAGE_PRUNE_INTERVAL_MS) return;
		this.imagePruneRunning = true;
		this.lastImagePruneAt = Date.now();
		try {
			const result = await this.helper.pruneImages();
			this.imagePruneWarned = false;
			if (result.removed > 0)
				log('info', `Image prune removed ${result.removed} image(s), ${Math.round(result.reclaimedBytes / 1048576)} MiB; kept ${result.kept}`);
		} catch (error) {
			if (!this.imagePruneWarned) log('warn', `Image prune failed: ${errorText(error)}`);
			this.imagePruneWarned = true;
		} finally {
			this.imagePruneRunning = false;
		}
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

	/** Mount missing shares and unmount removed ones; a change refreshes the volume inventory. */
	private async convergeShareMounts(state: DesiredState): Promise<void> {
		try {
			// Share linking keys off the inventory, so re-read it on the next heartbeat.
			if (await this.shareMounts.runOnce(state, this.shutdownController.signal)) this.volumeInventoryAt = 0;
		} catch (error) {
			log('error', `Share mount converge failed: ${errorText(error)}`);
		}
	}

	/** Mount missing partitions and unmount removed ones; a change refreshes the volume inventory. */
	private async convergeDiskMounts(state: DesiredState): Promise<void> {
		try {
			// Adoption keys off the inventory, so re-read it on the next heartbeat.
			if (await this.diskMounts.runOnce(state, this.shutdownController.signal)) this.volumeInventoryAt = 0;
		} catch (error) {
			log('error', `Partition mount converge failed: ${errorText(error)}`);
		}
	}

	/** Re-check share and partition mounts between reconciles: retries failures, notices drops. */
	private async shareMountLoop(): Promise<void> {
		while (this.running) {
			await sleep(15_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			if (state.shareMounts.length > 0 || state.shareUnmounts.length > 0) await this.convergeShareMounts(state);
			if (state.diskMounts.length > 0 || state.diskUnmounts.length > 0) await this.convergeDiskMounts(state);
		}
	}

	/** Starts the next storage benchmark; it runs in the background and reports in the heartbeat. */
	private async volumeProfileLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state || state.volumeProfileTasks.length === 0) continue;
			void this.volumeProfiles.runOnce(state, this.shutdownController.signal)?.catch((error) => {
				log('warn', `Volume profile round failed: ${errorText(error)}`);
			});
		}
	}

	/** App-volume work beside the reconcile loop; snapshots and restores run in the background. */
	private async appVolumeLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.appVolumes.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `App volume round failed: ${errorText(error)}`);
			}
		}
	}

	/** PITR tasks are additive to the logical backup loop and only exist when the flag is on. */
	private async databasePitrLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state || state.databasePitrTasks.length === 0) continue;
			try {
				// Ready = running on its current activation (the sampler's targets carry that check).
				const ready = new Set(
					this.workloads
						.databaseTargets()
						.filter((target) => target.status === 'running')
						.map((target) => target.id),
				);
				await this.databasePitr.runOnce(state, (id) => ready.has(id), this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database PITR task failed: ${errorText(error)}`);
			}
		}
	}

	/** Dashboard node updates (D99); its own loop because a download can take minutes. */
	private async nodeUpdateLoop(): Promise<void> {
		while (this.running) {
			await sleep(10_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.nodeUpdate.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Node update failed: ${errorText(error)}`);
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

	private async databaseReplicationLoop(): Promise<void> {
		while (this.running) {
			await sleep(5_000, this.shutdownController.signal).catch(() => undefined);
			if (!this.running) break;
			const state = this.desired;
			if (!state) continue;
			try {
				await this.databaseReplication.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Database replication task failed: ${errorText(error)}`);
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
			// Read-only studio principals (plan 22 track G) ride the same loop.
			try {
				await this.studioPrincipals.runOnce(state, this.shutdownController.signal);
			} catch (error) {
				log('warn', `Studio principal task failed: ${errorText(error)}`);
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
		const hardware = await this.hardware.collect();
		const nodeCertificate = this.nodeCertificate.ensure();
		if (this.desired?.wireguard && Date.now() - this.wireguardStatusAt > 30_000) {
			try {
				this.wireguardStatus = await this.helper.wireguardStatus();
				this.wireguardStatusAt = Date.now();
			} catch {
				// A helper that predates the overlay simply reports no peer health.
			}
		}
		// Cached; refreshed in the background at most every ~6 h (cert-expiry alert, DESIGN §8), and
		// sooner for a custom domain that just arrived (its report moves the domain to `active`).
		const certs = this.certs?.current() ?? [];
		if (certs.length > 0) stats.certs = certs;
		// Actual unit state, so restart loops and OOM kills show up in the fleet view.
		const reports = await this.workloads.refreshReports();
		const storage = await this.storage.status();
		// Purged data dirs (D59, S8); cleared only once the control plane accepts this heartbeat.
		const purgedDatabases = this.workloads.pendingPurgedDatabases();
		const purgedStorage = this.workloads.pendingPurgedStorage();
		const purgedBrokers = this.workloads.pendingPurgedBrokers();
		const appVolumeReport = this.appVolumes.pending();
		const shareMountReport = this.shareMounts.report();
		const diskMountReport = this.diskMounts.report();
		const volumeProfileResults = this.volumeProfiles.results();
		const volumeInventory = await this.volumeInventoryForHeartbeat();
		const backupResults = this.databaseBackups.pendingResults();
		const pitrResults = this.databasePitr.pendingResults();
		const rotationResults = this.databaseRotations.pendingResults();
		const credentialResults = this.databaseCredentials.pendingResults();
		const studioPrincipalResults = this.studioPrincipals.pendingResults();
		const poolerRestarted = this.databasePoolerRestarts.pending();
		const databaseReplication = this.databaseReplication.reports();
		const promotionResults = this.databaseReplication.pendingPromotionResults();
		const nodeUpdateResult = this.nodeUpdate.pendingResult();
		const databaseTls = databaseTlsHeartbeat(reports);
		// Bucket deletions and config convergence are reported once, capped by the heartbeat schema.
		const storageBucketDeletions = this.storageAdmin.pendingBucketDeletions().slice(0, 500);
		const storageBucketConfigs = this.storageAdmin.pendingBucketConfigs().slice(0, 500);
		// Root keys proved or refused (staged rotation, §5) and replication progress (§12).
		const storageRootKeys = this.storageAdmin.pendingRootKeyReports().slice(0, 200);
		const storageReplication = this.storageReplicator.pendingReports();
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
			capabilities: advertisedCapabilities(),
			stats,
			...(hardware ? { hardware } : {}),
			...(nodeCertificate ? { nodeCertificate } : {}),
			...(this.desired?.wireguard && this.wireguardStatus ? { wireguard: this.wireguardStatus } : {}),
			releases: this.releases.listReleases(),
			...(storage ? { storage } : {}),
			...(reports.length > 0 ? { workloads: workloadHeartbeat(reports) } : {}),
			...(backupResults.length > 0 ? { databaseBackupResults: backupResults } : {}),
			...(pitrResults.length > 0 ? { databasePitrResults: pitrResults } : {}),
			...(rotationResults.length > 0 ? { databaseRotationResults: rotationResults } : {}),
			...(credentialResults.length > 0 ? { databaseCredentialResults: credentialResults } : {}),
			...(studioPrincipalResults.length > 0 ? { databaseStudioPrincipalResults: studioPrincipalResults } : {}),
			...(poolerRestarted.length > 0 ? { databasePoolerRestarted: poolerRestarted } : {}),
			...(databaseReplication.length > 0 ? { databaseReplication } : {}),
			...(promotionResults.length > 0 ? { databaseReplicaPromotionResults: promotionResults } : {}),
			...(nodeUpdateResult ? { nodeUpdateResult } : {}),
			...(databaseTls.length > 0 ? { databaseTls } : {}),
			...(purgedDatabases.length > 0 ? { purgedDatabases } : {}),
			...(purgedStorage.length > 0 ? { purgedStorage } : {}),
			...(purgedBrokers.length > 0 ? { purgedBrokers } : {}),
			...(appVolumeReport.purged.length > 0 ? { purgedAppVolumes: appVolumeReport.purged } : {}),
			...(appVolumeReport.usage.length > 0 ? { appVolumeUsage: appVolumeReport.usage } : {}),
			...(appVolumeReport.results.length > 0 ? { appVolumeTaskResults: appVolumeReport.results } : {}),
			...(storageBucketDeletions.length > 0 ? { storageBucketDeletions } : {}),
			...(storageBucketConfigs.length > 0 ? { storageBucketConfigs } : {}),
			...(storageRootKeys.length > 0 ? { storageRootKeys } : {}),
			...(storageReplication.length > 0 ? { storageReplication } : {}),
			...(volumeInventory ? { volumes: volumeInventory } : {}),
			...(shareMountReport.shareMounts.length > 0 ? { shareMounts: shareMountReport.shareMounts } : {}),
			...(shareMountReport.unmountedShares.length > 0 ? { unmountedShares: shareMountReport.unmountedShares } : {}),
			...(diskMountReport.diskMounts.length > 0 ? { diskMounts: diskMountReport.diskMounts } : {}),
			...(diskMountReport.unmountedDisks.length > 0 ? { unmountedDisks: diskMountReport.unmountedDisks } : {}),
			...(volumeProfileResults.length > 0 ? { volumeProfileResults } : {}),
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
		this.databasePitr.acknowledge(pitrResults.map((result) => result.taskId));
		this.databaseRotations.acknowledge(rotationResults.map((result) => result.taskId));
		this.databaseCredentials.acknowledge(credentialResults.map((result) => result.taskId));
		this.studioPrincipals.acknowledge(studioPrincipalResults);
		this.databasePoolerRestarts.acknowledge(poolerRestarted);
		this.databaseReplication.acknowledgePromotions(promotionResults.map((result) => result.failoverId));
		await this.nodeUpdate.acknowledge(nodeUpdateResult);
		this.workloads.acknowledgePurgedDatabases(purgedDatabases);
		this.workloads.acknowledgePurgedStorage(purgedStorage);
		this.workloads.acknowledgePurgedBrokers(purgedBrokers);
		this.appVolumes.acknowledge(appVolumeReport);
		this.shareMounts.acknowledgeUnmounted(shareMountReport.unmountedShares);
		this.diskMounts.acknowledgeUnmounted(diskMountReport.unmountedDisks);
		this.volumeProfiles.acknowledge(volumeProfileResults);
		this.storageAdmin.acknowledgeBucketDeletions(storageBucketDeletions);
		this.storageAdmin.acknowledgeBucketConfigs(storageBucketConfigs);
		this.storageAdmin.acknowledgeRootKeyReports(storageRootKeys);
		this.storageReplicator.acknowledgeReports(storageReplication);
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

	/** Managed broker samples and stream listings (D123), riding the telemetry batch. */
	private async brokerStatsLoop(): Promise<void> {
		while (this.running) {
			await sleep(BROKER_STATS_INTERVAL_MS, this.shutdownController.signal);
			if (!this.running) break;
			try {
				await this.brokerStats.sample(this.shutdownController.signal);
			} catch (error) {
				log('warn', `Broker sampling failed: ${errorText(error)}`);
			}
			try {
				await this.brokerStats.flush((payload) =>
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
				log('warn', `Broker telemetry flush failed: ${errorText(error)}`);
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
			[
				'skiff_agent_broker_samples_dropped_total',
				'Broker samples and stream listings dropped to keep memory bounded.',
				'counter',
				this.brokerStats.dropped,
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
	if (options.networkMode === 'skiff' && !options.wireguardPublicKey) {
		// The private key stays on the node: the helper generates it and returns only the public key.
		const helper = new HelperClient(process.env.SKIFF_HELPER_SOCKET?.trim() || '/run/skiff-helper/helper.sock');
		options.wireguardPublicKey = (await helper.wireguardKeygen()).publicKey;
	}
	const joined = await joinNode(options);
	process.stdout.write(formatEnv(joined));
	// Keep stdout machine-readable for `> /etc/skiff/agent.env`.
	console.error(`Wrote ${nodeFilePath(options.dataDir)}`);
}

async function main(): Promise<void> {
	const config = loadConfig();
	// Edge node: reach the control plane on its socket, never through our own Caddy (D105).
	if (config.controlSocket) globalThis.fetch = controlSocketFetch(globalThis.fetch, config.controlUrl, config.controlSocket);
	const runtime = new AgentRuntime(config);
	await runtime.run();
}

if (import.meta.main) {
	// `bun src/main.ts join …` has the script at argv[1]; a compiled binary may not.
	const subcommand = (name: string) => (process.argv[2] === name ? 2 : process.argv[1] === name ? 1 : -1);
	const joinIndex = subcommand('join');
	const storageIndex = subcommand('storage');
	if (subcommand('mail') >= 0) {
		// Email's MTA (docs/EMAIL.md), run by skiff-mail.service in its own cgroup. It reads no agent
		// config and never sees the node token: the agent feeds it over /run/skiff/mail.sock.
		const { runMailProcess } = await import('@skiff/mail/process');
		await runMailProcess().catch((error: unknown) => {
			console.error(`[skiff-agent mail] fatal: ${errorText(error)}`);
			process.exit(1);
		});
	} else if (subcommand('studio') >= 0) {
		// The native database studio process (plan 22), run by skiff-studio.service in its own
		// cgroup. It reads no agent config and never sees the node token.
		const { runStudioProcess } = await import('./studio/process.ts');
		await runStudioProcess().catch((error: unknown) => {
			console.error(`[skiff-agent studio] fatal: ${errorText(error)}`);
			process.exit(1);
		});
	} else if (storageIndex >= 0) {
		// Root-only node storage moves (D48), run by skiff-storage.service.
		const { runStorageCli } = await import('./storage-apply.ts');
		process.exitCode = await runStorageCli(process.argv.slice(storageIndex + 1));
	} else if (subcommand('pipeline-step') >= 0) {
		// The in-job Pipelines step runner (docs/PIPELINES.md W5), started by the Builder inside a job
		// container or sandbox unit. It reads no agent config: only job.json and the job token.
		const { runPipelineStep } = await import('@skiff/builder');
		const code = await runPipelineStep(process.argv[subcommand('pipeline-step') + 1]).catch((error: unknown) => {
			console.error(`[skiff-agent pipeline-step] fatal: ${errorText(error)}`);
			return 1;
		});
		process.exit(code);
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

/**
 * The static capabilities plus `functions-python` when the warmed Pyodide cache for the pinned
 * workerd is on disk (D121), and `process-node` when the node has Node.js (D125). Checked on every heartbeat, so installing the cache later takes effect
 * without restarting the agent.
 */
export function advertisedCapabilities(
	pyodideDir: string = process.env.SKIFF_PYODIDE_CACHE_DIR ?? `${WORKERD_INSTALL_DIR}/${WORKERD_PINNED_VERSION}/pyodide`,
	nodeBinary: string = process.env.SKIFF_NODE_PATH ?? '/usr/local/bin/node',
): string[] {
	let python = false;
	try {
		python = existsSync(pyodideDir) && readdirSync(pyodideDir).some((name) => name.endsWith('.capnp.bin'));
	} catch {
		python = false;
	}
	const capabilities: string[] = [...nodeCapabilities];
	if (python) capabilities.push(FUNCTIONS_PYTHON_CAPABILITY);
	// Node.js process apps (D125) need the pinned node the installer links onto every unit's PATH.
	if (existsSync(nodeBinary)) capabilities.push(PROCESS_NODE_CAPABILITY);
	return capabilities;
}
