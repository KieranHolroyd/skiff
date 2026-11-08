import {
	shareMountCredentialsSchema,
	type DesiredState,
	type ShareMountDesired,
	type ShareMountReport,
} from '@skiff/contracts';

/**
 * Keeps `shareMounts` mounted and `shareUnmounts` unmounted (docs/STORAGE.md §3, D143).
 *
 * Every round asks the helper which shares are mounted (no credentials needed), mounts the
 * missing ones and unmounts the ones the control plane removed. SMB credentials are fetched from
 * the node-authenticated endpoint for one mount call and handed straight to the helper; they never
 * touch the agent's disk or desired-state cache. Failures back off 5 s, 15 s, 45 s, then every
 * 5 minutes, and a new share generation (credentials rotated) retries at once.
 */

export interface HelperShareApi {
	shareStatus(ids: string[], signal?: AbortSignal): Promise<Array<{ id: string; mounted: boolean }>>;
	mountShare(
		share: {
			id: string;
			protocol: 'nfs' | 'smb';
			server: string;
			exportPath: string;
			readOnly: boolean;
			username?: string;
			password?: string;
			domain?: string;
		},
		signal?: AbortSignal,
	): Promise<{ id: string; mounted: boolean; error: string | null }>;
	unmountShare(id: string, signal?: AbortSignal): Promise<{ id: string; mounted: boolean; error: string | null }>;
}

export interface ShareMountRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: HelperShareApi;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	fetch?: typeof fetch;
	now?: () => number;
}

interface MountState {
	mounted: boolean;
	error: string | null;
	generation: string;
	attempts: number;
	nextAttemptAt: number;
}

const BACKOFF_MS = [5_000, 15_000, 45_000];
const BACKOFF_CAP_MS = 5 * 60_000;

export class ShareMountRunner {
	private readonly states = new Map<string, MountState>();
	private readonly unmounted = new Set<string>();
	private readonly log: NonNullable<ShareMountRunnerOptions['log']>;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private running: Promise<boolean> | null = null;

	constructor(private readonly options: ShareMountRunnerOptions) {
		this.log = options.log ?? (() => undefined);
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}

	/** One round; concurrent callers share it. Resolves true when any mount appeared or went away. */
	runOnce(state: DesiredState, signal?: AbortSignal): Promise<boolean> {
		if (!this.running)
			this.running = this.round(state, signal).finally(() => {
				this.running = null;
			});
		return this.running;
	}

	/** What the next heartbeat reports. */
	report(): { shareMounts: ShareMountReport[]; unmountedShares: string[] } {
		return {
			shareMounts: [...this.states.entries()].map(([id, state]) => ({ id, mounted: state.mounted, error: state.error })),
			unmountedShares: [...this.unmounted],
		};
	}

	/** The control plane accepted these unmount confirmations. */
	acknowledgeUnmounted(ids: readonly string[]): void {
		for (const id of ids) this.unmounted.delete(id);
	}

	private async round(state: DesiredState, signal?: AbortSignal): Promise<boolean> {
		const desired = state.shareMounts ?? [];
		const unmounts = state.shareUnmounts ?? [];
		const wanted = new Set(desired.map((mount) => mount.id));
		for (const id of [...this.states.keys()]) if (!wanted.has(id)) this.states.delete(id);
		if (desired.length === 0 && unmounts.length === 0) return false;

		let changed = false;
		const statuses = desired.length
			? new Map((await this.options.helper.shareStatus(desired.map((mount) => mount.name), signal)).map((item) => [item.id, item.mounted]))
			: new Map<string, boolean>();

		for (const mount of desired) {
			const previous = this.states.get(mount.id);
			if (statuses.get(mount.name)) {
				if (!previous?.mounted) changed = true;
				this.states.set(mount.id, { mounted: true, error: null, generation: mount.generation, attempts: 0, nextAttemptAt: 0 });
				continue;
			}
			if (previous?.mounted) {
				changed = true;
				this.log('warn', `Share ${mount.name} is no longer mounted; remounting`);
			}
			const retryNow = !previous || previous.mounted || previous.generation !== mount.generation;
			if (!retryNow && this.now() < previous.nextAttemptAt) continue;
			const attempts = retryNow ? 0 : previous.attempts;
			const result = await this.mount(mount, signal);
			if (result.mounted) {
				changed = true;
				this.log('info', `Mounted share ${mount.name}`);
				this.states.set(mount.id, { mounted: true, error: null, generation: mount.generation, attempts: 0, nextAttemptAt: 0 });
			} else {
				const delay = BACKOFF_MS[attempts] ?? BACKOFF_CAP_MS;
				this.log('warn', `Mounting share ${mount.name} failed: ${result.error}`);
				this.states.set(mount.id, {
					mounted: false,
					error: result.error,
					generation: mount.generation,
					attempts: attempts + 1,
					nextAttemptAt: this.now() + delay,
				});
			}
		}

		for (const item of unmounts) {
			if (this.unmounted.has(item.id)) continue;
			try {
				const result = await this.options.helper.unmountShare(item.name, signal);
				if (result.mounted) {
					this.log('warn', `Unmounting share ${item.name} failed: ${result.error ?? 'still mounted'}; retrying`);
					continue;
				}
				changed = true;
				this.unmounted.add(item.id);
				this.log('info', `Unmounted share ${item.name}`);
			} catch (error) {
				this.log('warn', `Unmounting share ${item.name} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return changed;
	}

	private async mount(mount: ShareMountDesired, signal?: AbortSignal): Promise<{ mounted: boolean; error: string | null }> {
		try {
			const credentials = mount.credentials ? await this.credentials(mount.id, signal) : null;
			const result = await this.options.helper.mountShare(
				{
					id: mount.name,
					protocol: mount.protocol,
					server: mount.server,
					exportPath: mount.exportPath,
					readOnly: mount.readOnly,
					...(credentials
						? {
								username: credentials.username,
								password: credentials.password,
								...(credentials.domain ? { domain: credentials.domain } : {}),
							}
						: {}),
				},
				signal,
			);
			return { mounted: result.mounted, error: result.mounted ? null : (result.error ?? 'mount failed') };
		} catch (error) {
			return { mounted: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) };
		}
	}

	private async credentials(mountId: string, signal?: AbortSignal) {
		const response = await this.fetchImpl(
			`${this.options.controlUrl}/api/agent/share-mounts/${encodeURIComponent(mountId)}/credentials`,
			{ headers: { authorization: `Bearer ${this.options.nodeToken}`, accept: 'application/json' }, signal },
		);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`share credentials -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
		}
		const credentials = shareMountCredentialsSchema.parse(await response.json());
		if (credentials.id !== mountId) throw new Error('share credentials do not match the mount');
		return credentials;
	}
}
