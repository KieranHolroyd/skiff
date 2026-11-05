import type { DesiredState } from '@skiff/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * Applies `databasePoolerRestarts` from desired state. A pooler-only restart must not bounce
 * Postgres, so it goes through the helper's dedicated fixed verb instead of re-applying the
 * database workload. The node acknowledges each id on its next heartbeat.
 */

export interface DatabasePoolerRestartRunnerOptions {
	helper: Pick<HelperApi, 'restartPooler'>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export class DatabasePoolerRestartRunner {
	private readonly helper: DatabasePoolerRestartRunnerOptions['helper'];
	private readonly log: NonNullable<DatabasePoolerRestartRunnerOptions['log']>;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued = new Set<string>();

	constructor(options: DatabasePoolerRestartRunnerOptions) {
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
	}

	pending(): string[] {
		return [...this.queued].sort();
	}

	acknowledge(ids: readonly string[]): void {
		for (const id of ids) {
			this.queued.delete(id);
			this.completed.add(id);
		}
	}

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		const ids = state.databasePoolerRestarts ?? [];
		const present = new Set(ids);
		for (const id of [...this.completed]) if (!present.has(id)) this.completed.delete(id);
		await Promise.all(
			ids.map((id) => {
				if (this.completed.has(id) || this.inFlight.has(id) || this.queued.has(id)) return undefined;
				return this.execute(id, signal);
			}),
		);
	}

	private async execute(id: string, signal: AbortSignal): Promise<void> {
		this.inFlight.add(id);
		try {
			await this.helper.restartPooler(id);
			this.queued.add(id);
			this.log('info', `Restarted pooler for database ${id}`);
		} catch (error) {
			this.log(
				'warn',
				`Could not restart pooler for ${id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.inFlight.delete(id);
		}
		// The signal is part of the interface for symmetry with the other runners; helper calls are
		// short and cannot be cancelled mid-flight.
		void signal;
	}
}
