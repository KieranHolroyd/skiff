import type { DesiredState, VolumeProfileResult, VolumeProfileTask } from '@skiff/contracts';

/**
 * Runs `volumeProfileTasks` (docs/STORAGE.md §5.1) one at a time through the helper's
 * `/v1/volumes/profile` verb, so two benchmarks never compete for the same node's I/O. Each task
 * reports `running` when it starts and its numbers (or error) when it ends; results are kept until
 * a heartbeat delivers them, and a finished task is never run again while it stays in desired state.
 */

export interface HelperVolumeProfileApi {
	profileVolume(
		input: { volumeId: string; sizeMb: number; runtimeSeconds: number },
		signal?: AbortSignal,
	): Promise<Omit<VolumeProfileResult, 'taskId' | 'status' | 'error'>>;
}

export class VolumeProfileRunner {
	private readonly pending = new Map<string, VolumeProfileResult>();
	private readonly finished = new Set<string>();
	private active: string | null = null;
	private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;

	constructor(
		private readonly options: {
			helper: HelperVolumeProfileApi;
			log?: (level: 'info' | 'warn' | 'error', message: string) => void;
		},
	) {
		this.log = options.log ?? (() => undefined);
	}

	/** Start the next task if none is running. Returns immediately; the benchmark runs in the background. */
	runOnce(state: DesiredState, signal?: AbortSignal): Promise<void> | null {
		const tasks = state.volumeProfileTasks ?? [];
		const present = new Set(tasks.map((task) => task.id));
		for (const id of [...this.finished]) if (!present.has(id)) this.finished.delete(id);
		if (this.active) return null;
		const next = tasks.find((task) => !this.finished.has(task.id));
		if (!next) return null;
		return this.execute(next, signal);
	}

	/** Results for the next heartbeat. */
	results(): VolumeProfileResult[] {
		return [...this.pending.values()];
	}

	/** The control plane accepted these results; final ones are dropped, `running` is re-sent only once. */
	acknowledge(results: readonly VolumeProfileResult[]): void {
		for (const result of results) {
			const current = this.pending.get(result.taskId);
			if (current && current.status === result.status) this.pending.delete(result.taskId);
		}
	}

	private async execute(task: VolumeProfileTask, signal?: AbortSignal): Promise<void> {
		this.active = task.id;
		this.pending.set(task.id, blank(task.id, 'running'));
		this.log('info', `Profiling volume ${task.volumeId} (${task.sizeMb} MiB, ${task.runtimeSeconds}s per job)`);
		try {
			const profile = await this.options.helper.profileVolume(
				{ volumeId: task.volumeId, sizeMb: task.sizeMb, runtimeSeconds: task.runtimeSeconds },
				signal,
			);
			this.pending.set(task.id, { ...blank(task.id, 'succeeded'), ...profile });
			this.log('info', `Profiled volume ${task.volumeId} with ${profile.method}`);
		} catch (error) {
			const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
			this.pending.set(task.id, { ...blank(task.id, 'failed'), error: detail });
			this.log('warn', `Profiling volume ${task.volumeId} failed: ${detail}`);
		} finally {
			this.finished.add(task.id);
			this.active = null;
		}
	}
}

function blank(taskId: string, status: VolumeProfileResult['status']): VolumeProfileResult {
	return {
		taskId,
		status,
		method: null,
		seqReadMBps: null,
		seqWriteMBps: null,
		randReadIops: null,
		randWriteIops: null,
		syncWriteIops: null,
		syncWriteLatencyUs: null,
		direct: null,
		notes: [],
		error: null,
	};
}
