import {
	levelForPriority,
	type DesiredState,
	type RuntimeLogBatch,
	type WorkloadDesired,
} from '@skiff/contracts';
import type { HelperApi } from './helper-client.ts';

const DEFAULT_INTERVAL_MS = 2_000;
const LINES_PER_READ = 200;
const LINES_PER_POST = 400;

export interface LogDrainOptions {
	helper: HelperApi;
	controlUrl: string;
	nodeToken: string;
	intervalMs?: number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/** Test seam. */
	fetch?: typeof fetch;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Runtime log drain (DESIGN §8). The agent does not run as root and never talks to journald
 * directly: it asks the helper for new entries after a cursor and forwards ordered batches to the
 * control plane. Cursors are only advanced after a successful POST, so a flaky link retries
 * instead of losing lines. The cursor map is in memory; a restart re-reads the last page and may
 * duplicate a few lines, which is preferable to a gap.
 */
export class WorkloadLogDrain {
	private readonly cursors = new Map<string, string>();
	private readonly warned = new Set<string>();
	private readonly helper: HelperApi;
	private readonly controlUrl: string;
	private readonly nodeToken: string;
	private readonly intervalMs: number;
	private readonly log: NonNullable<LogDrainOptions['log']>;
	private readonly doFetch: typeof fetch;
	private readonly doSleep: (ms: number, signal: AbortSignal) => Promise<void>;

	constructor(options: LogDrainOptions) {
		this.helper = options.helper;
		this.controlUrl = options.controlUrl.replace(/\/+$/, '');
		this.nodeToken = options.nodeToken;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.log = options.log ?? (() => undefined);
		this.doFetch = options.fetch ?? fetch;
		this.doSleep = options.sleep ?? sleep;
	}

	async run(
		getState: () => DesiredState | null,
		signal: AbortSignal,
	): Promise<void> {
		while (!signal.aborted) {
			await this.drain(getState()).catch((error: unknown) => {
				this.log('warn', `Log drain failed: ${errorText(error)}`);
			});
			await this.doSleep(this.intervalMs, signal);
		}
	}

	/** Drain every workload currently placed on this node. Returns the number of lines stored. */
	async drain(state: DesiredState | null): Promise<number> {
		if (!state) return 0;
		const desired = state.workloads.filter(
			(workload) => workload.status !== 'stopped',
		);
		const ids = new Set(desired.map((workload) => workload.id));
		for (const id of this.cursors.keys())
			if (!ids.has(id)) this.cursors.delete(id);

		let stored = 0;
		for (const workload of desired) stored += await this.drainOne(workload);
		return stored;
	}

	private async drainOne(workload: WorkloadDesired): Promise<number> {
		const cursor = this.cursors.get(workload.id);
		let result;
		try {
			result = await this.helper.logs(workload.id, {
				...(cursor ? { cursor } : {}),
				lines: LINES_PER_READ,
			});
		} catch (error) {
			// A missing unit or an old helper is expected in dev. Warn once per workload, not every 2 s.
			if (!this.warned.has(workload.id)) {
				this.warned.add(workload.id);
				this.log(
					'warn',
					`Could not read logs for ${workload.projectSlug}: ${errorText(error)}`,
				);
			}
			return 0;
		}
		this.warned.delete(workload.id);
		if (result.entries.length === 0) {
			if (result.nextCursor) this.cursors.set(workload.id, result.nextCursor);
			return 0;
		}

		const lines = result.entries.map((entry) => ({
			ts: entry.ts,
			stream: (entry.priority <= 3 ? 'stderr' : 'stdout') as
				| 'stdout'
				| 'stderr',
			level: levelForPriority(entry.priority),
			message: entry.message,
		}));

		let sent = 0;
		for (let index = 0; index < lines.length; index += LINES_PER_POST) {
			const batch: RuntimeLogBatch = {
				workloadId: workload.id,
				lines: lines.slice(index, index + LINES_PER_POST),
				...(index + LINES_PER_POST >= lines.length && result.nextCursor
					? { cursor: result.nextCursor }
					: {}),
			};
			await this.post(batch);
			sent += batch.lines.length;
		}
		if (result.nextCursor) this.cursors.set(workload.id, result.nextCursor);
		return sent;
	}

	private async post(batch: RuntimeLogBatch): Promise<void> {
		const response = await this.doFetch(`${this.controlUrl}/api/agent/logs`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${this.nodeToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(batch),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(
				`log drain -> ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
			);
		}
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener('abort', finish, { once: true });
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
