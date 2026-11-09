import { createHash } from 'node:crypto';
import type { DatabaseBackupResult, DatabaseBackupTask, DesiredState } from '@yoal/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * Executes `databaseBackupTasks` from desired state on the node (docs/DATABASES.md §9). The helper
 * produces or consumes the dump; this runner streams it to/from the presigned object-store URL,
 * hashes the uploaded bytes and queues a result for the next heartbeat. Nothing is written to the
 * agent's disk.
 */

export interface DatabaseBackupRunnerOptions {
	helper: Pick<HelperApi, 'dumpDatabase' | 'restoreDatabase'>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class DatabaseBackupRunner {
	private readonly helper: DatabaseBackupRunnerOptions['helper'];
	private readonly log: NonNullable<DatabaseBackupRunnerOptions['log']>;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued = new Map<string, DatabaseBackupResult>();

	constructor(options: DatabaseBackupRunnerOptions) {
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
	}

	/** Results not yet acknowledged by an accepted heartbeat. */
	pendingResults(): DatabaseBackupResult[] {
		return [...this.queued.values()];
	}

	/** Call only after the control plane accepted the heartbeat carrying these task ids. */
	acknowledge(taskIds: readonly string[]): void {
		for (const id of taskIds) {
			this.queued.delete(id);
			this.completed.add(id);
		}
	}

	async runOnce(state: DesiredState, isRunning: (id: string) => boolean, signal: AbortSignal): Promise<void> {
		const tasks = state.databaseBackupTasks ?? [];
		const present = new Set(tasks.map((task) => task.id));
		for (const id of [...this.completed]) if (!present.has(id)) this.completed.delete(id);
		await Promise.all(
			tasks.map((task) => {
				if (this.completed.has(task.id) || this.inFlight.has(task.id) || this.queued.has(task.id)) return undefined;
				if (!isRunning(task.databaseId)) return undefined;
				return this.execute(task, signal);
			}),
		);
	}

	private async execute(task: DatabaseBackupTask, signal: AbortSignal): Promise<void> {
		this.inFlight.add(task.id);
		const started = Date.now();
		try {
			if (task.action === 'backup') {
				const dump = await this.helper.dumpDatabase(task.databaseId);
				const hash = createHash('sha256');
				let size = 0;
				const transform = new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						hash.update(chunk);
						size += chunk.byteLength;
						controller.enqueue(chunk);
					},
				});
				const upload = await fetch(task.url, {
					method: 'PUT',
					headers: { 'content-type': 'application/octet-stream' },
					body: dump.body.pipeThrough(transform) as never,
					duplex: 'half',
					signal,
				} as RequestInit & { duplex: 'half' });
				if (!upload.ok) {
					const detail = await upload.text().catch(() => '');
					throw new Error(`object upload -> ${upload.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
				}
				this.queued.set(task.id, {
					taskId: task.id,
					action: 'backup',
					databaseId: task.databaseId,
					backupId: null,
					status: 'ok',
					sizeBytes: size,
					sha256: hash.digest('hex'),
				});
				this.log('info', `Backed up database ${task.databaseId} (${size} bytes) in ${Date.now() - started}ms`);
			} else {
				const download = await fetch(task.url, { signal });
				if (!download.ok || !download.body)
					throw new Error(`object download -> ${download.status}`);
				await this.helper.restoreDatabase(task.databaseId, download.body);
				this.queued.set(task.id, {
					taskId: task.id,
					action: 'restore',
					databaseId: task.databaseId,
					backupId: task.backupId,
					status: 'ok',
				});
				this.log('info', `Restored database ${task.databaseId} in ${Date.now() - started}ms`);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.queued.set(task.id, {
				taskId: task.id,
				action: task.action,
				databaseId: task.databaseId,
				backupId: task.backupId,
				status: 'failed',
				error: detail.slice(0, 2_000),
			});
			this.log('error', `Database ${task.action} ${task.databaseId} failed: ${detail}`);
		} finally {
			this.inFlight.delete(task.id);
		}
	}
}
