import {
	DATABASE_STUDIO_READONLY_USER,
	databaseStudioPrincipalActivationSchema,
	type DatabaseStudioPrincipalResult,
	type DatabaseStudioPrincipalTask,
	type DesiredState,
} from '@yoal/contracts';
import type { HelperStudioPrincipalApi } from '../helper-client.ts';

/**
 * Applies `databaseStudioPrincipals` from desired state (plan 22 track G), like the named
 * credential runner: the password is fetched from the node-authenticated activation and handed
 * straight to the helper's fixed `studio-principal` verb. It never touches desired state, disk or
 * a log line.
 *
 * A task is keyed by database and generation. A failure is retried a few times first, because a
 * task can race the database's own restart (a version change, a restore); only then is it
 * reported, and the control plane waits for a new generation (the dashboard's retry).
 */

export interface StudioPrincipalRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: HelperStudioPrincipalApi;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	/** Attempts before a failure is reported. */
	attempts?: number;
	/** Wait between attempts. */
	retryDelayMs?: number;
}

interface Attempt {
	count: number;
	nextAt: number;
	error: string;
}

export class StudioPrincipalRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly helper: HelperStudioPrincipalApi;
	private readonly log: NonNullable<StudioPrincipalRunnerOptions['log']>;
	private readonly now: () => number;
	private readonly attempts: number;
	private readonly retryDelayMs: number;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly failures = new Map<string, Attempt>();
	private readonly queued = new Map<string, DatabaseStudioPrincipalResult>();

	constructor(options: StudioPrincipalRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.attempts = Math.max(1, options.attempts ?? 3);
		this.retryDelayMs = options.retryDelayMs ?? 10_000;
	}

	pendingResults(): DatabaseStudioPrincipalResult[] {
		return [...this.queued.values()].slice(0, 50);
	}

	/** After the control plane accepted a heartbeat carrying these results. */
	acknowledge(results: readonly DatabaseStudioPrincipalResult[]): void {
		for (const [key, result] of this.queued) {
			if (!results.includes(result)) continue;
			this.queued.delete(key);
			this.completed.add(key);
		}
	}

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		const tasks = state.databaseStudioPrincipals ?? [];
		const present = new Set(tasks.map(taskKey));
		for (const key of [...this.completed]) if (!present.has(key)) this.completed.delete(key);
		for (const key of [...this.failures.keys()]) if (!present.has(key)) this.failures.delete(key);
		const now = this.now();
		await Promise.all(
			tasks.map((task) => {
				const key = taskKey(task);
				if (this.completed.has(key) || this.inFlight.has(key) || this.queued.has(key)) return undefined;
				const failure = this.failures.get(key);
				if (failure && failure.nextAt > now) return undefined;
				return this.execute(task, key, signal);
			}),
		);
	}

	private async execute(task: DatabaseStudioPrincipalTask, key: string, signal: AbortSignal): Promise<void> {
		this.inFlight.add(key);
		let generation = task.generation;
		try {
			const response = await fetch(
				`${this.controlUrl}/api/agent/database-studio-principal/${encodeURIComponent(task.databaseId)}`,
				{ headers: { authorization: `Bearer ${this.nodeToken}`, accept: 'application/json' }, signal },
			);
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`studio principal activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
			}
			const activation = databaseStudioPrincipalActivationSchema.parse(await response.json());
			if (activation.databaseId !== task.databaseId)
				throw new Error('studio principal activation does not match the desired task');
			// The control plane may have moved on; the password is the same, so report the newer one.
			generation = Math.max(task.generation, activation.generation);
			await this.helper.ensureStudioPrincipal(task.databaseId, DATABASE_STUDIO_READONLY_USER, activation.password);
			this.failures.delete(key);
			this.queued.set(key, { databaseId: task.databaseId, generation, status: 'ok' });
			this.log('info', `Read-only studio principal ready for database ${task.databaseId} (generation ${generation})`);
		} catch (error) {
			if (signal.aborted) return;
			const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
			const count = (this.failures.get(key)?.count ?? 0) + 1;
			if (count < this.attempts) {
				this.failures.set(key, { count, nextAt: this.now() + this.retryDelayMs, error: detail });
				this.log('warn', `Read-only studio principal for ${task.databaseId} failed (attempt ${count}/${this.attempts}): ${detail}`);
				return;
			}
			this.failures.delete(key);
			this.queued.set(key, { databaseId: task.databaseId, generation, status: 'failed', error: detail });
			this.log('error', `Read-only studio principal for ${task.databaseId} failed: ${detail}`);
		} finally {
			this.inFlight.delete(key);
		}
	}
}

function taskKey(task: DatabaseStudioPrincipalTask): string {
	return `${task.databaseId}@${task.generation}`;
}
