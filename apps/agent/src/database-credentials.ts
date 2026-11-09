import {
	databaseCredentialActivationSchema,
	type DatabaseCredentialResult,
	type DesiredState,
} from '@yoal/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * Applies `databaseCredentialTasks` from desired state (plan 04b). The new password never enters
 * desired state or the agent's disk: it is fetched from the node-authenticated credential endpoint
 * and handed straight to the helper, which creates/updates or disables the Postgres role.
 */

export interface DatabaseCredentialRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: Pick<HelperApi, 'applyDatabaseCredential'>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class DatabaseCredentialRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly helper: DatabaseCredentialRunnerOptions['helper'];
	private readonly log: NonNullable<DatabaseCredentialRunnerOptions['log']>;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued = new Map<string, DatabaseCredentialResult>();

	constructor(options: DatabaseCredentialRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
	}

	pendingResults(): DatabaseCredentialResult[] {
		return [...this.queued.values()];
	}

	acknowledge(taskIds: readonly string[]): void {
		for (const id of taskIds) {
			this.queued.delete(id);
			this.completed.add(id);
		}
	}

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		const tasks = state.databaseCredentialTasks ?? [];
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
		task: DesiredState['databaseCredentialTasks'][number],
		signal: AbortSignal,
	): Promise<void> {
		this.inFlight.add(task.id);
		try {
			const response = await fetch(
				`${this.controlUrl}/api/agent/database-credentials/${encodeURIComponent(task.id)}`,
				{
					headers: { authorization: `Bearer ${this.nodeToken}`, accept: 'application/json' },
					signal,
				},
			);
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`credential activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
			}
			const activation = databaseCredentialActivationSchema.parse(await response.json());
			if (activation.id !== task.id || activation.databaseId !== task.databaseId)
				throw new Error('credential activation does not match the desired task');
			if (activation.action !== task.action || activation.role !== task.role)
				throw new Error('credential activation does not match the desired action');
			await this.helper.applyDatabaseCredential(
				task.databaseId,
				activation.action,
				activation.role,
				activation.username,
				activation.password,
			);
			this.queued.set(task.id, {
				taskId: task.id,
				databaseId: task.databaseId,
				status: 'ok',
			});
			this.log(
				'info',
				`${activation.action === 'revoke' ? 'Revoked' : 'Applied'} ${task.role} credential for database ${task.databaseId}`,
			);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.queued.set(task.id, {
				taskId: task.id,
				databaseId: task.databaseId,
				status: 'failed',
				error: detail.slice(0, 2_000),
			});
			this.log('error', `Credential task ${task.id} failed: ${detail}`);
		} finally {
			this.inFlight.delete(task.id);
		}
	}
}
