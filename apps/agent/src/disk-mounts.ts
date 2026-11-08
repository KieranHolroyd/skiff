import type { DesiredState, DiskMountDesired, DiskMountReport } from '@skiff/contracts';

/**
 * Keeps `diskMounts` mounted and `diskUnmounts` unmounted (docs/STORAGE.md §3.1).
 *
 * Every round asks the helper which disks are mounted at `/mnt/skiff-disks/<name>`, mounts the
 * missing ones (after a reboot too: Skiff writes no fstab entry) and unmounts the ones the control
 * plane removed. The helper re-checks the UUID against its own `lsblk` before each mount. Failures
 * back off 5 s, 15 s, 45 s, then every 5 minutes.
 */

export interface HelperDiskApi {
	diskStatus(ids: string[], signal?: AbortSignal): Promise<Array<{ id: string; mounted: boolean }>>;
	mountDisk(
		disk: { id: string; fsUuid: string; fsType: string },
		signal?: AbortSignal,
	): Promise<{ id: string; mounted: boolean; error: string | null }>;
	unmountDisk(id: string, signal?: AbortSignal): Promise<{ id: string; mounted: boolean; error: string | null }>;
}

export interface DiskMountRunnerOptions {
	helper: HelperDiskApi;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
}

interface MountState {
	mounted: boolean;
	error: string | null;
	attempts: number;
	nextAttemptAt: number;
}

const BACKOFF_MS = [5_000, 15_000, 45_000];
const BACKOFF_CAP_MS = 5 * 60_000;

export class DiskMountRunner {
	private readonly states = new Map<string, MountState>();
	private readonly unmounted = new Set<string>();
	private readonly log: NonNullable<DiskMountRunnerOptions['log']>;
	private readonly now: () => number;
	private running: Promise<boolean> | null = null;

	constructor(private readonly options: DiskMountRunnerOptions) {
		this.log = options.log ?? (() => undefined);
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
	report(): { diskMounts: DiskMountReport[]; unmountedDisks: string[] } {
		return {
			diskMounts: [...this.states.entries()].map(([id, state]) => ({ id, mounted: state.mounted, error: state.error })),
			unmountedDisks: [...this.unmounted],
		};
	}

	/** The control plane accepted these unmount confirmations. */
	acknowledgeUnmounted(ids: readonly string[]): void {
		for (const id of ids) this.unmounted.delete(id);
	}

	private async round(state: DesiredState, signal?: AbortSignal): Promise<boolean> {
		const desired = state.diskMounts ?? [];
		const unmounts = state.diskUnmounts ?? [];
		const wanted = new Set(desired.map((mount) => mount.id));
		for (const id of [...this.states.keys()]) if (!wanted.has(id)) this.states.delete(id);
		if (desired.length === 0 && unmounts.length === 0) return false;

		let changed = false;
		const statuses = desired.length
			? new Map((await this.options.helper.diskStatus(desired.map((mount) => mount.name), signal)).map((item) => [item.id, item.mounted]))
			: new Map<string, boolean>();

		for (const mount of desired) {
			const previous = this.states.get(mount.id);
			if (statuses.get(mount.name)) {
				if (!previous?.mounted) changed = true;
				this.states.set(mount.id, { mounted: true, error: null, attempts: 0, nextAttemptAt: 0 });
				continue;
			}
			if (previous?.mounted) {
				changed = true;
				this.log('warn', `Partition ${mount.name} is no longer mounted; remounting`);
			}
			const retryNow = !previous || previous.mounted;
			if (!retryNow && this.now() < previous.nextAttemptAt) continue;
			const attempts = retryNow ? 0 : previous.attempts;
			const result = await this.mount(mount, signal);
			if (result.mounted) {
				changed = true;
				this.log('info', `Mounted partition ${mount.fsUuid} at ${mount.name}`);
				this.states.set(mount.id, { mounted: true, error: null, attempts: 0, nextAttemptAt: 0 });
			} else {
				const delay = BACKOFF_MS[attempts] ?? BACKOFF_CAP_MS;
				this.log('warn', `Mounting partition ${mount.name} failed: ${result.error}`);
				this.states.set(mount.id, {
					mounted: false,
					error: result.error,
					attempts: attempts + 1,
					nextAttemptAt: this.now() + delay,
				});
			}
		}

		for (const item of unmounts) {
			if (this.unmounted.has(item.id)) continue;
			try {
				const result = await this.options.helper.unmountDisk(item.name, signal);
				if (result.mounted) {
					this.log('warn', `Unmounting partition ${item.name} failed: ${result.error ?? 'still mounted'}; retrying`);
					continue;
				}
				changed = true;
				this.unmounted.add(item.id);
				this.log('info', `Unmounted partition ${item.name}`);
			} catch (error) {
				this.log('warn', `Unmounting partition ${item.name} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return changed;
	}

	private async mount(mount: DiskMountDesired, signal?: AbortSignal): Promise<{ mounted: boolean; error: string | null }> {
		try {
			const result = await this.options.helper.mountDisk({ id: mount.name, fsUuid: mount.fsUuid, fsType: mount.fsType }, signal);
			return { mounted: result.mounted, error: result.mounted ? null : (result.error ?? 'mount failed') };
		} catch (error) {
			return { mounted: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) };
		}
	}
}
