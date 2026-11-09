import {
	identityDesiredSchema,
	identityHealthSchema,
	identitySecretsSchema,
	type IdentityDesired,
	type IdentityHealth,
	type IdentitySecrets,
	type IdentityUnitStatus,
} from '@yoal/contracts';

/**
 * The agent's side of the separate identity process (docs/IAM.md §11.2). On the identity node only,
 * it starts `yoal-identity` through the helper, pushes the non-secret pool projection, fetches the
 * authenticated secret bundle (confidential OIDC clients and social providers) from the control
 * plane, and restarts the unit when it stops answering. It stops the unit when this node is no
 * longer assigned.
 *
 * Like `yoal-mail`, the process never dials the control plane: state, secrets and health cross the
 * node's private unix socket. Secrets are relayed straight through and never logged.
 */

export interface HelperIdentityApi {
	identityStart(): Promise<void>;
	identityStop(): Promise<void>;
	/** Optional helper verb; without it the bridge restarts with stop + start. */
	identityRestart?(): Promise<void>;
}

type Fetch = (input: string, init?: RequestInit & { unix?: string }) => Promise<Response>;
type Log = (level: 'info' | 'warn' | 'error', message: string) => void;
type UnitState = 'starting' | 'running' | 'unhealthy' | 'stopped';

export interface IdentityBridgeOptions {
	/** `yoal-identity`'s control socket. */
	socketPath: string;
	helper: HelperIdentityApi;
	/** Control plane base URL and node token for the authenticated secret fetch. */
	controlUrl?: string;
	nodeToken?: string;
	/** Process build, reported in the heartbeat (`YOAL_IDENTITY_VERSION`). */
	version?: string;
	fetch?: Fetch;
	log: Log;
	/** Health/state cadence. */
	intervalMs?: number;
	/** Secret refresh cadence, so a rotated client secret reaches the pool within a minute. */
	secretsIntervalMs?: number;
	/** Unhealthy ticks before restarting the unit (default 3). */
	restartAfter?: number;
	/** Called when the unit's health changes, so the agent can recompile the fallback routes. */
	onStatusChange?: () => void;
	/** false: no background loop; the caller drives `tick` (tests). */
	loops?: boolean;
}

export class IdentityBridge {
	private desired: IdentityDesired | null = null;
	private active = false;
	private started = false;
	private controller: AbortController | null = null;
	private ticking = false;
	private unhealthy = 0;
	private restarts = 0;
	private state: UnitState = 'stopped';
	private processVersion: string | null = null;	private generation: number | null = null;
	private pools = 0;
	private secretsGeneration: number | null = null;
	private lastSecretsAt = 0;
	private readonly fetch: Fetch;

	constructor(private readonly options: IdentityBridgeOptions) {
		this.fetch = options.fetch ?? (fetch as Fetch);
	}

	/** Called with every desired state. Starting and stopping are idempotent. */
	apply(desired: IdentityDesired | null): void {
		this.desired = desired;
		if (desired && !this.active) this.activate();
		else if (!desired && this.active) void this.deactivate();
	}

	get isActive(): boolean {
		return this.active;
	}

	/** Whether the assigned pools should stay on the identity route or fall back to the control plane. */
	get isHealthy(): boolean {
		return this.active && this.state === 'running';
	}

	/** Heartbeat view: status, build and last applied state. */
	status(): IdentityUnitStatus {
		return {
			status: this.state,
			version: this.processVersion ?? this.options.version ?? null,
			generation: this.generation,
			pools: this.pools,
			restarts: this.restarts,
		};
	}

	async close(): Promise<void> {
		this.controller?.abort();
		this.controller = null;
		this.active = false;
		this.setState('stopped');
	}

	private activate(): void {
		this.active = true;
		this.setState('starting');
		this.controller = new AbortController();
		if (this.options.loops === false) return;
		void this.loop(this.controller.signal);
	}

	private setState(state: UnitState): void {
		if (this.state === state) return;
		this.state = state;
		this.options.onStatusChange?.();
	}

	private async deactivate(): Promise<void> {
		this.active = false;
		this.controller?.abort();
		this.controller = null;
		this.started = false;
		this.setState('stopped');
		this.unhealthy = 0;
		try {
			await this.options.helper.identityStop();
			this.options.log('info', 'This node is no longer the identity node: stopped yoal-identity');
		} catch (error) {
			this.options.log('warn', `Stopping yoal-identity failed: ${String(error)}`);
		}
	}

	private async loop(signal: AbortSignal): Promise<void> {
		const interval = this.options.intervalMs ?? 3000;
		while (!signal.aborted) {
			await this.tick().catch((error) => this.options.log('warn', `Identity bridge: ${String(error)}`));
			await sleep(interval, signal);
		}
	}

	/** One pass: make sure the unit runs, has the current generation and has current secrets. */
	async tick(): Promise<void> {
		if (this.ticking || !this.desired) return;
		this.ticking = true;
		try {
			if (!this.started) {
				await this.options.helper.identityStart();
				this.started = true;
				this.setState('starting');
				this.options.log('info', 'Started yoal-identity (this node is the identity node)');
			}
			const health = await this.health();
			if (!health || !health.ready) {
				this.unhealthy += 1;
				this.setState('unhealthy');
				if (this.unhealthy >= (this.options.restartAfter ?? 3)) await this.restart('health check failed');
				return;
			}
			this.unhealthy = 0;
			this.setState('running');
			this.processVersion = health.version;
			this.generation = health.generation;
			this.pools = health.pools;
			if (health.generation === null || health.generation !== this.desired.generation) {
				await this.pushState();
			}
			await this.refreshSecrets(health);
		} finally {
			this.ticking = false;
		}
	}

	/** Stop and start the unit (or use a helper verb when it has one). Exposed for tests. */
	async restart(reason = 'requested'): Promise<void> {
		this.options.log('warn', `Restarting yoal-identity (${reason})`);
		this.restarts += 1;
		this.unhealthy = 0;
		this.setState('starting');
		this.started = false;
		try {
			if (this.options.helper.identityRestart) await this.options.helper.identityRestart();
			else {
				await this.options.helper.identityStop();
				await this.options.helper.identityStart();
			}
			this.started = true;
			this.secretsGeneration = null;
		} catch (error) {
			this.setState('unhealthy');
			this.options.log('warn', `Restarting yoal-identity failed: ${String(error)}`);
		}
	}

	private identity(path: string, init: RequestInit = {}): Promise<Response> {
		return this.fetch(`http://yoal-identity${path}`, {
			...init,
			unix: this.options.socketPath,
			headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
		});
	}

	private control(path: string, init: RequestInit = {}): Promise<Response> {
		return this.fetch(`${this.options.controlUrl}/api/agent/${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${this.options.nodeToken}`,
				accept: 'application/json',
				...(init.headers as Record<string, string> | undefined),
			},
		});
	}

	private async health(): Promise<IdentityHealth | null> {
		try {
			const response = await this.identity('/health');
			if (!response.ok) return null;
			return identityHealthSchema.parse(await response.json());
		} catch {
			return null;
		}
	}

	private async pushState(): Promise<void> {
		const state = identityDesiredSchema.parse(this.desired);
		const pushed = await this.identity('/state', { method: 'PUT', body: JSON.stringify(state) });
		if (!pushed.ok) throw new Error(`yoal-identity refused the state: ${pushed.status} ${await pushed.text().catch(() => '')}`);
		this.generation = state.generation;
		// A new projection may add a client or provider; fetch its secret on this same pass.
		this.secretsGeneration = null;
		this.options.log('info', `Pushed identity state g${state.generation} (${state.pools.length} pools)`);
	}

	/**
	 * Fetch the opened client/social secrets from the control plane and hand them to the process.
	 * The bundle is refreshed on every restart and at most once a minute, because a rotated client
	 * secret does not change the non-secret projection.
	 */
	private async refreshSecrets(health: IdentityHealth): Promise<void> {
		if (!this.options.controlUrl || !this.options.nodeToken) return;
		const interval = this.options.secretsIntervalMs ?? 60_000;
		const unknown = health.secretsGeneration === null;
		const stale = unknown || health.secretsGeneration !== this.secretsGeneration;
		if (!stale && Date.now() - this.lastSecretsAt < interval) return;
		// A process that never reports a generation (or an older build) is retried on the normal
		// interval rather than on every 3 s health tick.
		if (unknown && this.lastSecretsAt > 0 && Date.now() - this.lastSecretsAt < interval) return;
		this.lastSecretsAt = Date.now();
		try {
			const response = await this.control('identity/secrets');
			if (!response.ok) throw new Error(`identity/secrets -> ${response.status}`);
			const secrets: IdentitySecrets = identitySecretsSchema.parse(await response.json());
			const pushed = await this.identity('/secrets', { method: 'PUT', body: JSON.stringify(secrets) });
			if (!pushed.ok) throw new Error(`yoal-identity refused secrets: ${pushed.status}`);
			this.secretsGeneration = secrets.generation;
			const clients = secrets.pools.reduce((total, pool) => total + pool.clients.length, 0);
			this.options.log('info', `Pushed identity secrets g${secrets.generation} (${secrets.pools.length} pools, ${clients} clients)`);
		} catch (error) {
			// Public PKCE clients keep working; confidential clients fail closed until the next pass.
			this.options.log('warn', `Identity secret refresh failed: ${String(error)}`);
		}
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}
