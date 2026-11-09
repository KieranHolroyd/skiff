import { createHash } from 'node:crypto';
import type {
	AppVolumeNodeRef,
	AppVolumeTask,
	AppVolumeTaskResult,
	AppVolumeUsageSample,
	DesiredState,
} from '@yoal/contracts';
import type { HelperAppVolumeApi } from './helper-client.ts';

/**
 * App volumes on the node (docs/VOLUMES.md). Three jobs, all driven by desired state and
 * answered in the heartbeat:
 *
 * - **usage**: every `usageIntervalMs` the helper measures `appVolumes` (`du -B1`); the latest
 *   samples ride the next heartbeat.
 * - **purge**: each `appVolumePurges` entry's directory is deleted, then reported as purged.
 * - **tasks**: a snapshot asks the helper for the archive (it pauses the read-write writers named in
 *   `workloads[].volumes` unless `quiesce` is off) and streams it to the presigned PUT, hashing
 *   it on the way; a restore streams the presigned GET into the helper, checking the recorded
 *   sha256 before the last byte is handed over, so a mismatch aborts the extract and the helper
 *   empties the volume again.
 *
 * Nothing is written to the agent's disk.
 */

export const APP_VOLUME_USAGE_INTERVAL_MS = 5 * 60_000;
/** The heartbeat schema's cap on usage samples. */
const MAX_USAGE_SAMPLES = 1_000;
const ARCHIVE_CONTENT_TYPE = 'application/gzip';

export interface AppVolumeRunnerOptions {
	helper: HelperAppVolumeApi;
	usageIntervalMs?: number;
	now?: () => number;
	fetch?: typeof fetch;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface AppVolumeReport {
	usage: AppVolumeUsageSample[];
	purged: string[];
	results: AppVolumeTaskResult[];
}

export class AppVolumeRunner {
	private readonly helper: HelperAppVolumeApi;
	private readonly usageIntervalMs: number;
	private readonly now: () => number;
	private readonly fetch: typeof fetch;
	private readonly log: NonNullable<AppVolumeRunnerOptions['log']>;
	private lastUsageAt = Number.NEGATIVE_INFINITY;
	private readonly usage = new Map<string, AppVolumeUsageSample>();
	private readonly purged = new Set<string>();
	private readonly purging = new Set<string>();
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued = new Map<string, AppVolumeTaskResult>();
	private readonly running = new Set<Promise<void>>();

	constructor(options: AppVolumeRunnerOptions) {
		this.helper = options.helper;
		this.usageIntervalMs = options.usageIntervalMs ?? APP_VOLUME_USAGE_INTERVAL_MS;
		this.now = options.now ?? Date.now;
		this.fetch = options.fetch ?? fetch;
		this.log = options.log ?? (() => undefined);
	}

	/** What the next heartbeat carries; cleared only by `acknowledge`. */
	pending(): AppVolumeReport {
		return {
			usage: [...this.usage.values()].slice(0, MAX_USAGE_SAMPLES),
			purged: [...this.purged].slice(0, 500),
			results: [...this.queued.values()].slice(0, 50),
		};
	}

	/** Call only after the control plane accepted the heartbeat that carried `report`. */
	acknowledge(report: AppVolumeReport): void {
		for (const sample of report.usage) if (this.usage.get(sample.id) === sample) this.usage.delete(sample.id);
		for (const id of report.purged) this.purged.delete(id);
		for (const result of report.results) {
			this.queued.delete(result.taskId);
			this.completed.add(result.taskId);
		}
	}

	/**
	 * One round: purges and usage run inline; tasks start in the background (a snapshot can take
	 * hours) and only one runs per task id. Never throws.
	 */
	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		await this.purge(state.appVolumePurges ?? [], signal);
		this.startTasks(state, signal);
		await this.measure(state.appVolumes ?? [], signal);
	}

	/** Resolves when every task started so far has settled (tests and shutdown). */
	async idle(): Promise<void> {
		while (this.running.size > 0) await Promise.all([...this.running]);
	}

	private async purge(refs: AppVolumeNodeRef[], signal: AbortSignal): Promise<void> {
		const wanted = new Set(refs.map((ref) => ref.id));
		// The control plane dropped the row: forget the report so the set does not grow forever.
		for (const id of [...this.purged]) if (!wanted.has(id)) this.purged.delete(id);
		for (const ref of refs) {
			if (this.purged.has(ref.id) || this.purging.has(ref.id)) continue;
			this.purging.add(ref.id);
			try {
				await this.helper.purgeAppVolume(ref, signal);
				this.purged.add(ref.id);
				this.log('info', `Purged app volume ${ref.id}`);
			} catch (error) {
				this.log('warn', `Could not purge app volume ${ref.id}: ${errorText(error)}`);
			} finally {
				this.purging.delete(ref.id);
			}
		}
	}

	private async measure(refs: AppVolumeNodeRef[], signal: AbortSignal): Promise<void> {
		if (refs.length === 0 || this.now() - this.lastUsageAt < this.usageIntervalMs) return;
		this.lastUsageAt = this.now();
		try {
			const usage = await this.helper.appVolumeUsage(refs.slice(0, MAX_USAGE_SAMPLES), signal);
			for (const sample of usage) {
				if (sample.usedBytes === null) {
					if (sample.error) this.log('warn', `App volume ${sample.id}: usage unavailable (${sample.error})`);
					continue;
				}
				this.usage.set(sample.id, { id: sample.id, usedBytes: sample.usedBytes });
			}
		} catch (error) {
			this.log('warn', `App volume usage failed: ${errorText(error)}`);
		}
	}

	private startTasks(state: DesiredState, signal: AbortSignal): void {
		const tasks = state.appVolumeTasks ?? [];
		const present = new Set(tasks.map((task) => task.id));
		for (const id of [...this.completed]) if (!present.has(id)) this.completed.delete(id);
		for (const task of tasks) {
			if (this.completed.has(task.id) || this.inFlight.has(task.id) || this.queued.has(task.id)) continue;
			const run = this.execute(task, writersOf(state, task.volume.id), signal).finally(() => this.running.delete(run));
			this.running.add(run);
		}
	}

	private async execute(task: AppVolumeTask, writers: string[], signal: AbortSignal): Promise<void> {
		this.inFlight.add(task.id);
		const started = this.now();
		try {
			if (task.action === 'snapshot') {
				const archive = await this.helper.snapshotAppVolume(
					{ volume: task.volume, snapshotId: task.snapshotId, quiesce: task.quiesce, writers },
					signal,
				);
				const hash = createHash('sha256');
				let size = 0;
				const counted = archive.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							hash.update(chunk);
							size += chunk.byteLength;
							controller.enqueue(chunk);
						},
					}),
				);
				const upload = await this.fetch(task.url, {
					method: 'PUT',
					headers: { 'content-type': ARCHIVE_CONTENT_TYPE },
					body: counted as never,
					duplex: 'half',
					signal,
				} as RequestInit & { duplex: 'half' });
				if (!upload.ok) {
					const detail = await upload.text().catch(() => '');
					throw new Error(`object upload -> ${upload.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
				}
				this.queued.set(task.id, {
					taskId: task.id,
					action: 'snapshot',
					snapshotId: task.snapshotId,
					volumeId: task.volume.id,
					status: 'ok',
					sizeBytes: size,
					sha256: hash.digest('hex'),
					method: archive.method,
				});
				this.log(
					'info',
					`Snapshot ${task.snapshotId} of ${task.volume.id} (${archive.method}, ${size} bytes) in ${this.now() - started}ms`,
				);
			} else {
				const download = await this.fetch(task.url, { signal });
				if (!download.ok || !download.body) throw new Error(`object download -> ${download.status}`);
				const verified = verifyStream(download.body, task.checksum);
				try {
					await this.helper.restoreAppVolume(task.volume, verified.body, signal);
				} catch (error) {
					// The helper only sees its request body break; say why it broke.
					throw verified.mismatch() ?? error;
				}
				const mismatch = verified.mismatch();
				if (mismatch) throw mismatch;
				this.queued.set(task.id, {
					taskId: task.id,
					action: 'restore',
					snapshotId: task.snapshotId,
					volumeId: task.volume.id,
					status: 'ok',
					sizeBytes: verified.size(),
				});
				this.log('info', `Restored snapshot ${task.snapshotId} into ${task.volume.id} in ${this.now() - started}ms`);
			}
		} catch (error) {
			const detail = errorText(error);
			this.queued.set(task.id, {
				taskId: task.id,
				action: task.action,
				snapshotId: task.snapshotId,
				volumeId: task.volume.id,
				status: 'failed',
				error: detail.slice(0, 2_000),
			});
			this.log('error', `App volume ${task.action} ${task.snapshotId} (${task.volume.id}) failed: ${detail}`);
		} finally {
			this.inFlight.delete(task.id);
		}
	}
}

/** Workloads in desired state with a read-write mount of `volumeId`: the units a snapshot pauses. */
export function writersOf(state: Pick<DesiredState, 'workloads'>, volumeId: string): string[] {
	const ids = new Set<string>();
	for (const workload of state.workloads ?? [])
		if (workload.volumes?.some((mount) => mount.id === volumeId && !mount.readOnly)) ids.add(workload.id);
	return [...ids].sort().slice(0, 20);
}

/**
 * Hash a download while it streams. With an expected digest the stream errors in `flush`, before
 * it closes, so the consumer (the helper's tar) never sees a clean end of a corrupted archive.
 */
export function verifyStream(
	body: ReadableStream<Uint8Array>,
	expected: string | null,
): { body: ReadableStream<Uint8Array>; mismatch: () => Error | null; size: () => number } {
	const hash = createHash('sha256');
	let size = 0;
	let mismatch: Error | null = null;
	const verified = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				hash.update(chunk);
				size += chunk.byteLength;
				controller.enqueue(chunk);
			},
			flush(controller) {
				const actual = hash.digest('hex');
				if (expected && actual !== expected) {
					mismatch = new Error(`checksum mismatch: the archive is ${actual}, the snapshot recorded ${expected}`);
					controller.error(mismatch);
				}
			},
		}),
	);
	return { body: verified, mismatch: () => mismatch, size: () => size };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
