import {
	identityDesiredSchema,
	identityHealthSchema,
	type IdentityDesired,
	type IdentityHealth,
} from '@skiff/contracts';

/**
 * The agent's side of the separate identity process (docs/IAM.md §11.2). On the identity node only,
 * it starts `skiff-identity` through the helper and pushes the non-secret pool projection the
 * control plane put in desired state. It stops the unit when this node is no longer assigned.
 *
 * Like `skiff-mail`, the process never dials the control plane: state and health cross the node's
 * private unix socket.
 */

export interface HelperIdentityApi {
	identityStart(): Promise<void>;
	identityStop(): Promise<void>;
}

type Fetch = (input: string, init?: RequestInit & { unix?: string }) => Promise<Response>;
type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface IdentityBridgeOptions {
	/** `skiff-identity`'s control socket. */
	socketPath: string;
	helper: HelperIdentityApi;
	fetch?: Fetch;
	log: Log;
	/** Health/state cadence. */
	intervalMs?: number;
	/** false: no background loop; the caller drives `tick` (tests). */
	loops?: boolean;
}

export class IdentityBridge {
	private desired: IdentityDesired | null = null;
	private active = false;
	private started = false;
	private controller: AbortController | null = null;
	private ticking = false;
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

	async close(): Promise<void> {
		this.controller?.abort();
		this.controller = null;
		this.active = false;
	}

	private activate(): void {
		this.active = true;
		this.controller = new AbortController();
		if (this.options.loops === false) return;
		void this.loop(this.controller.signal);
	}

	private async deactivate(): Promise<void> {
		this.active = false;
		this.controller?.abort();
		this.controller = null;
		this.started = false;
		try {
			await this.options.helper.identityStop();
			this.options.log('info', 'This node is no longer the identity node: stopped skiff-identity');
		} catch (error) {
			this.options.log('warn', `Stopping skiff-identity failed: ${String(error)}`);
		}
	}

	private async loop(signal: AbortSignal): Promise<void> {
		const interval = this.options.intervalMs ?? 3000;
		while (!signal.aborted) {
			await this.tick().catch((error) => this.options.log('warn', `Identity bridge: ${String(error)}`));
			await sleep(interval, signal);
		}
	}

	/** One pass: make sure the unit runs and has the current generation. Exposed for tests. */
	async tick(): Promise<void> {
		if (this.ticking || !this.desired) return;
		this.ticking = true;
		try {
			if (!this.started) {
				await this.options.helper.identityStart();
				this.started = true;
				this.options.log('info', 'Started skiff-identity (this node is the identity node)');
			}
			const health = await this.health();
			if (!health) return; // Still starting; the next tick tries again.
			if (health.generation === null || health.generation !== this.desired.generation) {
				await this.pushState();
			}
		} finally {
			this.ticking = false;
		}
	}

	private identity(path: string, init: RequestInit = {}): Promise<Response> {
		return this.fetch(`http://skiff-identity${path}`, {
			...init,
			unix: this.options.socketPath,
			headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
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
		if (!pushed.ok) throw new Error(`skiff-identity refused the state: ${pushed.status} ${await pushed.text().catch(() => '')}`);
		this.options.log('info', `Pushed identity state g${state.generation} (${state.pools.length} pools)`);
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
