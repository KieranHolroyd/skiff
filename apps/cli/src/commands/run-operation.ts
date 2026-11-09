/**
 * Shared plumbing for commands that drive an operation: create a plan, confirm, apply, and show
 * progress until it settles. Three output modes: a redrawn TTY region, one line per phase change
 * when stderr isn't a terminal, and NDJSON events on stdout with `--json`.
 */
import { randomUUID } from 'node:crypto';
import type { ApiClient, OperationCreateInput } from '../api.ts';
import { CliError } from '../errors.ts';
import { followOperation } from '../follow.ts';
import {
	LiveRegion,
	ProgressTracker,
	exitCodeFor,
	failureLine,
	isPlanning,
	isTerminal,
	phaseLine,
	progressLines,
	watchHint,
	type OperationView,
} from '../operations.ts';
import { askTerminal } from '../prompt.ts';

export type OutputMode = 'tty' | 'plain' | 'json';

/** The workspace's Bun typings only declare `memoryPressure` on `process`; signals work at runtime. */
const signals = process as unknown as {
	on(event: 'SIGINT', listener: () => void): unknown;
	off(event: 'SIGINT', listener: () => void): unknown;
};

export function outputMode(json: boolean): OutputMode {
	if (json) return 'json';
	return process.stderr.isTTY ? 'tty' : 'plain';
}

/** One NDJSON event per line on stdout (`--json`). */
export function emit(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Create a plan and wait for it. Bulk plans are quick, so the request itself waits; anything
 * still planning after that (a big prune scan) is followed with progress.
 */
export async function createPlan(
	client: ApiClient,
	input: Omit<OperationCreateInput, 'stage'>,
	mode: OutputMode,
	options: { waitSeconds?: number; showProgress?: boolean } = {},
): Promise<OperationView> {
	const created = await client.createOperation(
		{ ...input, stage: 'plan' },
		{ idempotencyKey: `yoal-${randomUUID()}`, waitSeconds: options.waitSeconds ?? 10 },
	);
	if (!isPlanning(created.status)) return created;
	if (!options.showProgress) return followOperation(client, created, { untilDone: false });
	return followWithProgress(client, created, mode, { untilDone: false });
}

/**
 * Ask for confirmation. Off a terminal (pipes, CI) there's no one to ask, so refuse unless
 * `--yes` was given; the caller cancels the plan.
 */
export async function confirmOrRefuse(
	question: string,
	options: { yes: boolean; accept?: (answer: string) => boolean; refusal: string },
): Promise<boolean> {
	if (options.yes) return true;
	if (!process.stdin.isTTY)
		throw new CliError(options.refusal, {
			code: 'confirmation_required',
			suggestions: ['Re-run with --yes to confirm without a prompt.'],
		});
	const answer = await askTerminal(question);
	return (options.accept ?? ((value) => /^(y|yes)$/i.test(value)))(answer);
}

/** Cancel a plan nobody will apply. Best effort: it expires on its own anyway. */
export async function discardPlan(client: ApiClient, id: string): Promise<void> {
	await client.cancelOperation(id).catch(() => undefined);
}

/**
 * Follow an operation with live progress. Ctrl-C detaches (the server keeps going) and prints
 * how to pick it up again.
 */
export async function followWithProgress(
	client: ApiClient,
	start: OperationView,
	mode: OutputMode,
	options: { untilDone: boolean; tracker?: ProgressTracker },
): Promise<OperationView> {
	const tracker = options.tracker ?? new ProgressTracker(start);
	tracker.update(start);
	const region = mode === 'tty' ? new LiveRegion((text) => process.stderr.write(text)) : undefined;
	let lastPhase = '';

	const frame = (): string[] => {
		const view = tracker.view;
		if (isPlanning(view.status)) return [`Scanning… ${view.phase ?? view.status}`];
		if (view.status === 'planned' || view.total === 0) return [];
		return progressLines(tracker.rows());
	};
	const say = (line: string) => {
		if (region) region.log(line, frame());
		else process.stderr.write(`${line}\n`);
	};

	const onInterrupt = (): void => {
		region?.done();
		if (mode === 'json') emit({ type: 'detached', id: start.id, hint: `yoal operations watch ${start.id}` });
		process.stderr.write(`\n${watchHint(start.id)}\n`);
		process.exit(130);
	};
	signals.on('SIGINT', onInterrupt);

	try {
		const final = await followOperation(client, start, {
			untilDone: options.untilDone,
			handlers: {
				progress(view) {
					tracker.update(view);
					if (mode === 'json') {
						if (!isTerminal(view.status)) emit({ type: 'progress', operation: view });
						return;
					}
					if (region) {
						region.render(frame());
						return;
					}
					const line = phaseLine(view);
					if (line !== lastPhase && !isTerminal(view.status) && view.status !== 'planned') {
						lastPhase = line;
						process.stderr.write(`${line}\n`);
					}
				},
				items(items) {
					const failures = tracker.items(items);
					if (mode === 'json') {
						emit({ type: 'items', items });
						return;
					}
					for (const failure of failures) say(failureLine(failure));
					region?.render(frame());
				},
				reconnecting(attempt, how) {
					if (mode === 'json') emit({ type: 'reconnecting', attempt, mode: how });
					else say(how === 'poll' ? 'Progress stream unavailable; polling instead.' : `Progress stream dropped; reconnecting (${attempt})…`);
				},
			},
		});
		tracker.update(final);
		if (region) {
			region.render(frame());
			region.done();
		}
		return final;
	} finally {
		signals.off('SIGINT', onInterrupt);
	}
}

/** Exit code for a finished operation; also used as the process exit code. */
export function settleExitCode(view: OperationView): void {
	if (isTerminal(view.status)) process.exitCode = exitCodeFor(view.status);
}
