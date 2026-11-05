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
 */

export interface DatabasePitrRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: Pick<HelperApi, 'pitrConfigure' | 'pitrBaseBackup' | 'pitrRestore' | 'pitrStatus'>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class DatabasePitrRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly helper: DatabasePitrRunnerOptions['helper'];
	private readonly log: NonNullable<DatabasePitrRunnerOptions['log']>;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued = new Map<string, DatabasePitrResult>();

	constructor(options: DatabasePitrRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
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

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		const tasks = state.databasePitrTasks ?? [];
		const present = new Set(tasks.map((task) => task.id));
		for (const id of [...this.completed]) if (!present.has(id)) this.completed.delete(id);
		await Promise.all(
			tasks.map((task) => {
				if (this.completed.has(task.id) || this.inFlight.has(task.id) || this.queued.has(task.id))
					return undefined;
				return this.execute(task, signal);
			}),
		);
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
				const status = await this.helper.pitrStatus(task.databaseId);
				this.queued.set(task.id, {
					taskId: task.id,
					action: 'status',
					databaseId: task.databaseId,
					targetDatabaseId: null,
					status: 'ok',
					archiveStatus: status.archiveStatus,
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
