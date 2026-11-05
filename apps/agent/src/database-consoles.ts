import {
	databaseConsoleActivationSchema,
	type DatabaseConsoleResult,
	type DatabaseConsoleTask,
	type DesiredState
} from '@skiff/contracts';
import type { HelperApi } from './helper-client.ts';

/**
 * Executes `databaseConsoles` from desired state (D60). A console is a separate DBGate sidecar:
 * starting or stopping it goes through the helper's fixed console verbs and never re-applies the
 * Postgres workload, so the database is not restarted.
 *
 * The start activation (database credentials and the per-session basic-auth password) is fetched
 * from the node-authenticated control endpoint just before the helper call and never enters the
 * agent's desired-state cache. Results ride the next heartbeat; a failed task is reported, not
 * retried forever, because the control plane owns the session generation and will enqueue a new
 * task when it wants another attempt.
 */

export interface DatabaseConsoleRunnerOptions {
	controlUrl: string;
	nodeToken: string;
	helper: Pick<HelperApi, 'startConsole' | 'stopConsole'>;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Injected for tests; defaults to the global fetch. */
	fetch?: typeof fetch;
	/** Injected readiness probe; defaults to the global fetch. */
	probe?: typeof fetch;
}

function taskKey(id: string, generation: number): string {
	return `${id}:${generation}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(new Error('aborted'));
			},
			{ once: true }
		);
	});
}

/** How long a cold DBGate start (image pull included) may take before the result is reported. */
const READY_TIMEOUT_MS = 120_000;

export class DatabaseConsoleRunner {
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly helper: DatabaseConsoleRunnerOptions['helper'];
	private readonly log: NonNullable<DatabaseConsoleRunnerOptions['log']>;
	private readonly fetchImpl: typeof fetch;
	private readonly probe: typeof fetch;
	private readonly completed = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly queued = new Map<string, DatabaseConsoleResult>();

	constructor(options: DatabaseConsoleRunnerOptions) {
		this.controlUrl = options.controlUrl;
		this.nodeToken = options.nodeToken;
		this.helper = options.helper;
		this.log = options.log ?? (() => undefined);
		this.fetchImpl = options.fetch ?? fetch;
		this.probe = options.probe ?? fetch;
	}

	pendingResults(): DatabaseConsoleResult[] {
		return [...this.queued.values()];
	}

	acknowledge(results: readonly DatabaseConsoleResult[]): void {
		for (const result of results) {
			const key = taskKey(result.id, result.generation);
			this.queued.delete(key);
			this.completed.add(key);
		}
	}

	async runOnce(state: DesiredState, signal: AbortSignal): Promise<void> {
		const tasks = state.databaseConsoles ?? [];
		const present = new Set(tasks.map((task) => taskKey(task.id, task.generation)));
		for (const key of [...this.completed]) if (!present.has(key)) this.completed.delete(key);
		await Promise.all(
			tasks.map((task) => {
				const key = taskKey(task.id, task.generation);
				if (this.completed.has(key) || this.inFlight.has(key) || this.queued.has(key))
					return undefined;
				return this.execute(task, state, signal);
			})
		);
	}

	private async execute(
		task: DatabaseConsoleTask,
		state: DesiredState,
		signal: AbortSignal
	): Promise<void> {
		const key = taskKey(task.id, task.generation);
		this.inFlight.add(key);
		try {
			if (task.action === 'start') {
				const workload = state.workloads.find(
					(candidate) => candidate.id === task.id && candidate.database
				);
				if (!workload)
					throw new Error(`Database ${task.id} is not a managed database on this node`);
				const response = await this.fetchImpl(
					`${this.controlUrl}/api/agent/database-consoles/${encodeURIComponent(task.id)}`,
					{
						headers: {
							authorization: `Bearer ${this.nodeToken}`,
							accept: 'application/json'
						},
						signal
					}
				);
				if (!response.ok) {
					const text = await response.text().catch(() => '');
					throw new Error(
						`console activation -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`
					);
				}
				const activation = databaseConsoleActivationSchema.parse(await response.json());
				if (activation.databaseId !== task.id)
					throw new Error('console activation does not match the desired task');
				await this.helper.startConsole(workload, activation);
				// Report `running` only once DBGate answers. Any HTTP status (including the 401 for an
				// unauthenticated probe) means the process is up; the helper returns after systemd has
				// queued the start, which can be well before the image has finished booting.
				await this.waitUntilReady(activation.port, signal);
			} else {
				await this.helper.stopConsole(task.id);
			}
			this.queued.set(key, {
				id: task.id,
				action: task.action,
				generation: task.generation,
				status: 'ok'
			});
			this.log('info', `Database console ${task.action} for ${task.id} completed`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.queued.set(key, {
				id: task.id,
				action: task.action,
				generation: task.generation,
				status: 'failed',
				error: detail.slice(0, 2_000)
			});
			this.log('error', `Database console ${task.action} for ${task.id} failed: ${detail}`);
		} finally {
			this.inFlight.delete(key);
		}
	}

	private async waitUntilReady(port: number, signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (Date.now() < deadline && !signal.aborted) {
			try {
				const response = await this.probe(`http://127.0.0.1:${port}/`, {
					method: 'GET',
					redirect: 'manual',
					headers: { accept: 'text/html' },
					signal
				});
				await response.body?.cancel().catch(() => undefined);
				return;
			} catch {
				// Not listening yet: the container is still pulling or booting.
			}
			await sleep(500, signal).catch(() => undefined);
		}
		if (!signal.aborted)
			throw new Error(
				`DBGate did not answer on port ${port} within ${Math.round(READY_TIMEOUT_MS / 1000)}s. The image may still be pulling; open the studio again to retry.`
			);
	}
}
