import {
	databasePitrActivationSchema,
	type DatabasePitrResult,
	type DatabasePitrTask,
	type DesiredState,
} from '@skiff/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * Executes `databasePitrTasks` from desired state (docs/PITR.md). Additive to the logical backup
 * runner: the same node runs both, but PITR work only appears when `SKIFF_FEATURE_PITR` is on in
 * the control plane. Repository credentials are fetched from the node-authenticated activation
 * endpoint just before each task and are never written to the agent's desired-state cache.
 *
 * A task waits until every database it touches is ready: running on its current activation for
 * `settleMs`. Backups and status checks `podman exec` into the source's container, which must be
 * the PITR image (enabling PITR restarts it on that image); a restore needs the target applied
 * (env file, data dir, unit) before the helper replaces its data.
 */

/** How long a database must have been ready before a PITR task touches it (restart settle). */
export const PITR_SETTLE_MS = 30_000;

export interface DatabasePitrRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: Pick<HelperApi, 'pitrConfigure' | 'pitrBaseBackup' | 'pitrRestore' | 'pitrStatus'>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	settleMs?: number;
	now?: () => number;
}

export class DatabasePitrRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly helper: DatabasePitrRunnerOptions['helper'];
	private readonly log: NonNullable<DatabasePitrRunnerOptions['log']>;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued = new Map<string, DatabasePitrResult>();
	/** When each database was first seen ready in the current run of readiness. */
	private readonly readySince = new Map<string, number>();
	private readonly settleMs: number;
	private readonly now: () => number;

	constructor(options: DatabasePitrRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
		this.settleMs = options.settleMs ?? PITR_SETTLE_MS;
		this.now = options.now ?? Date.now;
	}

	pendingResults(): DatabasePitrResult[] {
		return [...this.queued.values()];
	}

	acknowledge(taskIds: readonly string[]): void {
		for (const id of taskIds) {
			this.queued.delete(id);
			this.completed.add(id);
		}
	}

	/**
	 * Start every task whose databases are ready. `isReady(id)` is true while the database runs on
	 * its current activation; a task that is not ready yet stays in desired state for a later pass.
	 */
	async runOnce(state: DesiredState, isReady: (id: string) => boolean, signal: AbortSignal): Promise<void> {
		const tasks = state.databasePitrTasks ?? [];
		const present = new Set(tasks.map((task) => task.id));
		for (const id of [...this.completed]) if (!present.has(id)) this.completed.delete(id);
		const now = this.now();
		const involved = new Set(tasks.flatMap((task) => this.databasesOf(task)));
		for (const id of [...this.readySince.keys()]) if (!involved.has(id)) this.readySince.delete(id);
		for (const id of involved) {
			if (!isReady(id)) this.readySince.delete(id);
			else if (!this.readySince.has(id)) this.readySince.set(id, now);
		}
		const settled = (id: string) => {
			const since = this.readySince.get(id);
			return since !== undefined && now - since >= this.settleMs;
		};
		await Promise.all(
			tasks.map((task) => {
				if (this.completed.has(task.id) || this.inFlight.has(task.id) || this.queued.has(task.id))
					return undefined;
				if (!this.databasesOf(task).every(settled)) return undefined;
				return this.execute(task, signal);
			}),
		);
	}

	private databasesOf(task: DatabasePitrTask): string[] {
		return task.action === 'restore' && task.targetDatabaseId ? [task.databaseId, task.targetDatabaseId] : [task.databaseId];
	}

	private async execute(task: DatabasePitrTask, signal: AbortSignal): Promise<void> {
		this.inFlight.add(task.id);
		try {
			const response = await fetch(
				`${this.controlUrl}/api/agent/database-pitr/${encodeURIComponent(task.id)}`,
				{
					headers: { authorization: `Bearer ${this.nodeToken}`, accept: 'application/json' },
					signal,
				},
			);
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`PITR activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
			}
			const activation = databasePitrActivationSchema.parse(await response.json());
			if (activation.taskId !== task.id || activation.databaseId !== task.databaseId)
				throw new Error('PITR activation does not match the desired task');

			if (task.action === 'basebackup') {
				await this.helper.pitrConfigure(task.databaseId, activation.repo);
				const backup = await this.helper.pitrBaseBackup(task.databaseId, task.baseBackupType ?? 'full');
				this.queued.set(task.id, {
					taskId: task.id,
					action: 'basebackup',
					databaseId: task.databaseId,
					targetDatabaseId: null,
					status: 'ok',
					baseBackupType: backup.type as DatabasePitrResult['baseBackupType'],
				});
				this.log('info', `PITR ${backup.type} backup for database ${task.databaseId} completed`);
			} else if (task.action === 'restore') {
				if (!task.targetDatabaseId || task.targetTime === null)
					throw new Error('PITR restore task is missing its target database or timestamp');
				await this.helper.pitrConfigure(task.databaseId, activation.repo);
				const restored = await this.helper.pitrRestore(task.databaseId, {
					targetDatabaseId: task.targetDatabaseId,
					targetTime: task.targetTime,
				});
				this.queued.set(task.id, {
					taskId: task.id,
					action: 'restore',
					databaseId: task.databaseId,
					targetDatabaseId: restored.targetDatabaseId,
					status: 'ok',
					targetTime: restored.targetTime,
					verified: restored.verified,
				});
				this.log('info', `PITR restore of database ${task.databaseId} into ${restored.targetDatabaseId} verified`);
			} else {
				// `/run` is a tmpfs: rewriting the config here is what brings archiving back after a
				// reboot, before the check reads the repository.
				await this.helper.pitrConfigure(task.databaseId, activation.repo);
				const status = await this.helper.pitrStatus(task.databaseId);
				this.queued.set(task.id, {
					taskId: task.id,
					action: 'status',
					databaseId: task.databaseId,
					targetDatabaseId: null,
					status: 'ok',
					archiveStatus: status.archiveStatus,
					window: {
						recoverableFrom: status.recoverableFrom,
						recoverableTo: status.recoverableTo,
						backupCount: status.backupCount,
						newestBackupAt: status.newestBackupAt,
						newestBackupType: status.newestBackupType,
						lastArchivedAt: status.lastArchivedAt,
						repoMessage: status.repoMessage,
					},
				});
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.queued.set(task.id, {
				taskId: task.id,
				action: task.action,
				databaseId: task.databaseId,
				targetDatabaseId: task.targetDatabaseId ?? null,
				status: 'failed',
				error: detail.slice(0, 2_000),
			});
			this.log('error', `PITR ${task.action} for database ${task.databaseId} failed: ${detail}`);
		} finally {
			this.inFlight.delete(task.id);
		}
	}
}
