import type { Permission } from '@yoal/contracts';
import type { CoreContext } from '../context.ts';

/**
 * What a step handler decides. The engine, never the handler, writes the transition, so a run
 * always reaches a terminal status even when a handler throws or its process dies (docs/FLOWS.md §3).
 */
export type FlowOutcome =
	/** Enter another step now (its `run` is called in the same drive). */
	| { type: 'next'; step: string; state?: Record<string, unknown>; detail?: string }
	/** Park until `signal` arrives, or call `onTimeout` after `timeoutMs`. */
	| { type: 'wait'; signal: string; timeoutMs?: number; state?: Record<string, unknown>; detail?: string }
	| { type: 'succeed'; result?: unknown; state?: Record<string, unknown>; detail?: string }
	| { type: 'fail'; error: string; state?: Record<string, unknown> }
	/** Only from a definition's `cancel` hook: the run ends `cancelled`. */
	| { type: 'cancel'; detail?: string };

/** Outcome builders, so definitions read as a state machine. */
export const flow = {
	next: (step: string, options: { state?: Record<string, unknown>; detail?: string } = {}): FlowOutcome => ({
		type: 'next',
		step,
		...options,
	}),
	wait: (
		signal: string,
		options: { timeoutMs?: number; state?: Record<string, unknown>; detail?: string } = {},
	): FlowOutcome => ({ type: 'wait', signal, ...options }),
	succeed: (result?: unknown, detail?: string): FlowOutcome => ({ type: 'succeed', result, detail }),
	fail: (error: string): FlowOutcome => ({ type: 'fail', error }),
	cancel: (detail?: string): FlowOutcome => ({ type: 'cancel', detail }),
};

export interface FlowRunRef {
	id: string;
	kind: string;
	key: string;
	orgId: string | null;
	step: string;
	attempt: number;
	createdBy: string | null;
	subject: { kind: string; id: string } | null;
}

export interface FlowStepContext<S> {
	ctx: CoreContext;
	run: FlowRunRef;
	/** The run's accumulated state (the start input plus every `state` patch). */
	state: S;
	now: number;
}

export interface FlowSignal {
	name: string;
	payload: unknown;
}

type MaybePromise<T> = T | Promise<T>;

export interface FlowStepDefinition<S> {
	/**
	 * Enter the step. Must be idempotent: after a crash the engine calls it again. Throwing retries
	 * the step with backoff; after the last attempt the run fails and `onFailure` compensates.
	 */
	run(step: FlowStepContext<S>): MaybePromise<FlowOutcome>;
	/** The awaited signal arrived. Return null to ignore it and keep waiting (same deadline). */
	onSignal?(step: FlowStepContext<S>, signal: FlowSignal): MaybePromise<FlowOutcome | null>;
	/** The wait deadline passed. Without a handler the run fails with a timeout error. */
	onTimeout?(step: FlowStepContext<S>): MaybePromise<FlowOutcome>;
}

export interface FlowDefinition<S = Record<string, unknown>> {
	kind: string;
	title: string;
	steps: Record<string, FlowStepDefinition<S>>;
	/** Handler errors are retried this many times per step (default `flowLimits.maxAttempts`). */
	maxAttempts?: number;
	/**
	 * Cancellation (compensation included). Return the outcome, typically `flow.cancel()`, or null
	 * when the current step cannot be cancelled. Without a hook the flow is not cancellable.
	 */
	cancel?(step: FlowStepContext<S>): MaybePromise<FlowOutcome | null>;
	/**
	 * Compensation when the engine fails the run: retries exhausted, a lost lease past its attempts,
	 * the run deadline, or a missing step. Not called when a step itself returns `fail` (it has
	 * already compensated). Errors here are logged in the step log, never rethrown.
	 */
	onFailure?(step: FlowStepContext<S>, error: string): MaybePromise<void>;
}

export interface FlowStartInput<S> {
	kind: string;
	/** Idempotency key: while a run with this kind + key is active, `start` returns it. */
	key: string;
	input: S;
	orgId?: string | null;
	subject?: { kind: string; id: string } | null;
	/** Permission a principal needs to read the run (its org must match too). */
	readPermission?: Permission | null;
	/** Permission a principal needs to cancel it. */
	cancelPermission?: Permission | null;
	createdBy?: string | null;
	/** Absolute deadline for the whole run, epoch ms. */
	deadlineAt?: number | null;
	/** First step; defaults to the definition's first step. */
	step?: string;
	/**
	 * Start parked in `step`, already waiting for `signal` (adopting work that began before flows
	 * existed). The step's `run` is not called.
	 */
	waiting?: { signal: string; deadline?: number | null };
	detail?: string;
}

export interface FlowStartResult {
	id: string;
	/** False when an active run with the same kind + key already existed. */
	created: boolean;
}

export interface FlowDriveResult {
	/** Runs claimed and processed (synchronous handlers have finished by the time this returns). */
	processed: number;
	/** Settles when every asynchronous handler started by this drive has finished. */
	settled: Promise<void>;
}
