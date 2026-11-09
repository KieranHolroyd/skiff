import { readFile } from 'node:fs/promises';
import { compareSemver, parseSemver, type DesiredState, type NodeUpdateTask } from '@yoal/contracts';
import { atomicWriteFile } from './state.ts';

/**
 * Applies `nodeUpdate` from desired state (D99). The agent cannot replace its own binary (its
 * sandbox makes /opt read-only and it is not root), so it hands the version to the helper's fixed
 * `node/update` verb, which verifies the signed release, swaps both binaries and restarts the
 * services. Success needs no report: the restarted agent's heartbeat carries the new version.
 *
 * Each generation is attempted once. The attempt is written to disk before the helper is called,
 * so an agent restarted mid-update (or one that came back on the old version) reports a failure
 * instead of retrying in a loop. Retrying is an operator decision: a new generation.
 */

export interface HelperNodeUpdateApi {
	updateNode(input: { version: string; repo: string }, signal?: AbortSignal): Promise<{ version: string }>;
}

export interface NodeUpdateResult {
	generation: number;
	error: string;
}

interface Attempt {
	generation: number;
	/** When the helper reported the install; the restart follows within seconds. */
	installedAt?: number;
	error?: string;
	reported?: boolean;
}

export interface NodeUpdateRunnerOptions {
	helper: HelperNodeUpdateApi;
	/** This binary's version (embedded at build time). */
	currentVersion: string;
	/** `${dataDir}/node-update.json`. */
	statePath: string;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	/** How long after a successful install to wait for the restart before calling it a failure. */
	restartGraceMs?: number;
}

export class NodeUpdateRunner {
	private readonly log: NonNullable<NodeUpdateRunnerOptions['log']>;
	private readonly now: () => number;
	private readonly restartGraceMs: number;
	private pending: NodeUpdateResult | null = null;
	private running = false;

	constructor(private readonly options: NodeUpdateRunnerOptions) {
		this.log = options.log ?? (() => undefined);
		this.now = options.now ?? Date.now;
		this.restartGraceMs = options.restartGraceMs ?? 120_000;
	}

	pendingResult(): NodeUpdateResult | null {
		return this.pending;
	}

	/** After the control plane accepted a heartbeat carrying `result`. */
	async acknowledge(result: NodeUpdateResult | null): Promise<void> {
		if (!result || this.pending !== result) return;
		this.pending = null;
		const attempt = await this.read();
		if (attempt?.generation === result.generation) await this.write({ ...attempt, reported: true });
	}

	async runOnce(state: DesiredState, signal?: AbortSignal): Promise<void> {
		const task = state.nodeUpdate;
		if (!task || this.running) return;
		const current = parseSemver(this.options.currentVersion);
		// Already there (the control plane settles it from the heartbeat), or nothing to compare.
		if (!current || compareSemver(current, task.version) >= 0) return;

		const attempt = await this.read();
		if (attempt && attempt.generation >= task.generation) {
			this.reportStale(task, attempt);
			return;
		}
		this.running = true;
		try {
			await this.write({ generation: task.generation });
			this.log('info', `Updating this node from ${current.version} to ${task.version} (signed release from ${task.repo})`);
			await this.options.helper.updateNode({ version: task.version, repo: task.repo }, signal);
			await this.write({ generation: task.generation, installedAt: this.now() });
			this.log('info', `The helper installed ${task.version}; the agent restarts now`);
		} catch (error) {
			if (signal?.aborted) return;
			const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
			this.log('warn', `Node update to ${task.version} failed: ${message}`);
			await this.write({ generation: task.generation, error: message });
			this.pending = { generation: task.generation, error: message };
		} finally {
			this.running = false;
		}
	}

	/** An attempted generation that never produced the new version: report it once. */
	private reportStale(task: NodeUpdateTask, attempt: Attempt): void {
		if (attempt.reported || this.pending?.generation === task.generation) return;
		if (attempt.installedAt !== undefined && this.now() - attempt.installedAt < this.restartGraceMs) return;
		const error =
			attempt.error ??
			(attempt.installedAt !== undefined
				? `${task.version} was installed, but the agent still runs ${this.options.currentVersion} after a restart. Check that yoal-agent.service runs the binary the helper replaced.`
				: `The update to ${task.version} was interrupted (the agent restarted before the helper answered). Retry it from the node list.`);
		this.pending = { generation: task.generation, error };
	}

	private async read(): Promise<Attempt | null> {
		try {
			const value = JSON.parse(await readFile(this.options.statePath, 'utf8')) as Attempt;
			return Number.isInteger(value?.generation) ? value : null;
		} catch {
			return null;
		}
	}

	private async write(attempt: Attempt): Promise<void> {
		await atomicWriteFile(this.options.statePath, `${JSON.stringify(attempt)}\n`);
	}
}
