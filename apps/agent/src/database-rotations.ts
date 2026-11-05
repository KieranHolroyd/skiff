import {
	databaseRotationActivationSchema,
	type DatabaseRotationResult,
	type DesiredState,
} from '@skiff/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * Applies `databaseRotations` from desired state (docs/DATABASES.md §4). The new password never
 * enters desired state or the agent's disk: it is fetched from the node-authenticated rotation
 * endpoint just before `ALTER ROLE`, and the control plane swaps the live secret only on success.
 */

export interface DatabaseRotationRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: Pick<HelperApi, 'rotateDatabaseRole'>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class DatabaseRotationRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly helper: DatabaseRotationRunnerOptions['helper'];
	private readonly log: NonNullable<DatabaseRotationRunnerOptions['log']>;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued = new Map<string, DatabaseRotationResult>();

	constructor(options: DatabaseRotationRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
	}

	pendingResults(): DatabaseRotationResult[] {
		return [...this.queued.values()];
	}

	acknowledge(taskIds: readonly string[]): void {
		for (const id of taskIds) {
			this.queued.delete(id);
			this.completed.add(id);
		}
	}

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		const tasks = state.databaseRotations ?? [];
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

	private async execute(
		task: DesiredState['databaseRotations'][number],
		signal: AbortSignal,
	): Promise<void> {
		this.inFlight.add(task.id);
		try {
			const response = await fetch(
				`${this.controlUrl}/api/agent/database-rotations/${encodeURIComponent(task.id)}`,
				{
					headers: { authorization: `Bearer ${this.nodeToken}`, accept: 'application/json' },
					signal,
				},
			);
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`rotation activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
			}
			const activation = databaseRotationActivationSchema.parse(await response.json());
			if (activation.id !== task.id || activation.databaseId !== task.databaseId)
				throw new Error('rotation activation does not match the desired task');
			await this.helper.rotateDatabaseRole(task.databaseId, activation.role, activation.password);
			this.queued.set(task.id, {
				taskId: task.id,
				databaseId: task.databaseId,
				role: task.role,
				status: 'ok',
			});
			this.log('info', `Rotated ${task.role} credential for database ${task.databaseId}`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.queued.set(task.id, {
				taskId: task.id,
				databaseId: task.databaseId,
				role: task.role,
				status: 'failed',
				error: detail.slice(0, 2_000),
			});
			this.log('error', `Credential rotation ${task.id} failed: ${detail}`);
		} finally {
			this.inFlight.delete(task.id);
		}
	}
}
