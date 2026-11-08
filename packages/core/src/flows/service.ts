import { randomBytes } from 'node:crypto';
import {
	FLOW_ID_PREFIX,
	flowLimits,
	isTerminalFlow,
	requirePermission,
	type FlowRunView,
	type FlowStatus,
	type FlowStepEvent,
	type FlowStepLogEntry,
	type Permission,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { newId, parseJson } from '../util.ts';
import {
	flow,
	type FlowDefinition,
	type FlowDriveResult,
	type FlowOutcome,
	type FlowStartInput,
	type FlowStartResult,
	type FlowStepContext,
} from './types.ts';

/**
 * The flow engine (docs/FLOWS.md, D167): durable, resumable step machines in SQLite.
 *
 * - A run is claimed with a time lease before any handler runs, and every transition is written
 *   with `lease_owner = me`, so a run whose lease was taken over by another process cannot be
 *   advanced twice.
 * - The engine writes every transition, including the terminal one. A handler that throws is
 *   retried with backoff; when attempts run out the run fails and the definition compensates.
 * - Handlers may be synchronous. Then `start`, `signal` and `cancel` finish their transitions
 *   before returning, which keeps request paths (a heartbeat that delivers a backup result)
 *   exactly as immediate as the hand-written state machines flows replace.
 */

interface FlowRunRow {
	id: string;
	kind: string;
	key: string;
	org_id: string | null;
	subject_kind: string | null;
	subject_id: string | null;
	read_permission: string | null;
	cancel_permission: string | null;
	status: FlowStatus;
	step: string;
	state_json: string;
	attempt: number;
	wake_at: number | null;
	waiting_for: string | null;
	wait_deadline: number | null;
	deadline_at: number | null;
	lease_owner: string | null;
	lease_until: number | null;
	cancel_requested: number;
	detail: string | null;
	result_json: string | null;
	error: string | null;
	created_by: string | null;
	created_at: number;
	updated_at: number;
	finished_at: number | null;
}

interface SignalRow {
	id: number;
	name: string;
	payload_json: string | null;
}

type Trigger =
	| { type: 'enter' }
	| { type: 'signal'; signalId: number; name: string; payload: unknown }
	| { type: 'timeout' }
	| { type: 'cancel' }
	| { type: 'deadline' };

type Continuation = { row: FlowRunRow; trigger: Trigger } | null;
type MaybePromise<T> = T | Promise<T>;
// biome-ignore lint/suspicious/noExplicitAny: definitions are stored type-erased and called with their own state.
type AnyDefinition = FlowDefinition<any>;

const DETAIL_MAX = 1_000;
const RESOLVED = Promise.resolve();

export interface FlowListFilter {
	kind?: string;
	status?: FlowStatus;
	subject?: { kind: string; id: string };
	limit?: number;
}

export class FlowService {
	/** Identifies this process's leases; a restarted control plane gets a new one. */
	readonly workerId = `cp-${process.pid}-${randomBytes(4).toString('hex')}`;
	private readonly definitions = new Map<string, AnyDefinition>();
	private readonly listeners = new Map<string, Set<() => void>>();

	constructor(private readonly ctx: CoreContext) {}

	// ------------------------------------------------------------- definitions

	register<S>(definition: FlowDefinition<S>): void {
		if (this.definitions.has(definition.kind)) throw new Error(`Flow "${definition.kind}" is already registered.`);
		if (Object.keys(definition.steps).length === 0) throw new Error(`Flow "${definition.kind}" has no steps.`);
		this.definitions.set(definition.kind, definition as AnyDefinition);
	}

	kinds(): string[] {
		return [...this.definitions.keys()].sort();
	}

	// ----------------------------------------------------------------- start

	/**
	 * Start a run, or return the active one with the same kind + key. Synchronous steps run before
	 * this returns; `settled` resolves once any asynchronous handler finishes.
	 */
	start<S>(input: FlowStartInput<S>): FlowStartResult & { settled: Promise<void> } {
		const definition = this.requireDefinition(input.kind);
		const step = input.step ?? Object.keys(definition.steps)[0]!;
		if (!definition.steps[step]) throw new ValidationError(`Flow "${input.kind}" has no step "${step}".`);
		const key = input.key.trim();
		if (!key) throw new ValidationError('A flow key must not be empty.');
		const existing = this.activeRow(input.kind, key);
		if (existing) return { id: existing.id, created: false, settled: RESOLVED };

		const now = this.ctx.now();
		const id = newId(FLOW_ID_PREFIX);
		const waiting = input.waiting ?? null;
		try {
			this.ctx.sqlite.run(
				`INSERT INTO flow_runs
				   (id, kind, key, org_id, subject_kind, subject_id, read_permission, cancel_permission, status, step,
				    state_json, attempt, waiting_for, wait_deadline, deadline_at, detail, created_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					input.kind,
					key,
					input.orgId ?? null,
					input.subject?.kind ?? null,
					input.subject?.id ?? null,
					input.readPermission ?? null,
					input.cancelPermission ?? null,
					waiting ? 'waiting' : 'queued',
					step,
					serializeState(input.input),
					waiting?.signal ?? null,
					waiting?.deadline ?? null,
					input.deadlineAt ?? null,
					clip(input.detail ?? null),
					input.createdBy ?? null,
					now,
					now,
				],
			);
		} catch (error) {
			// Another process started the same key between our read and insert.
			const raced = isUniqueViolation(error) ? this.activeRow(input.kind, key) : null;
			if (raced) return { id: raced.id, created: false, settled: RESOLVED };
			throw error;
		}
		this.log(id, step, 0, 'started', waiting ? `Adopted while waiting for ${waiting.signal}.` : (input.detail ?? null), now);
		this.notify(id);
		// A parked start can still be due at once (a deadline already in the past).
		return { id, created: true, settled: this.driveRun(id) };
	}

	// ---------------------------------------------------------------- signals

	/**
	 * Deliver an external event to the active run with this kind + key. Returns false when there is
	 * none. A run that is not waiting for `name` yet keeps the signal until it is.
	 */
	signal(kind: string, key: string, name: string, payload?: unknown): boolean {
		const row = this.activeRow(kind, key);
		if (!row) return false;
		this.signalRun(row.id, name, payload);
		return true;
	}

	signalRun(id: string, name: string, payload?: unknown): Promise<void> {
		const now = this.ctx.now();
		this.ctx.sqlite.run('INSERT INTO flow_signals (run_id, name, payload_json, created_at) VALUES (?, ?, ?, ?)', [
			id,
			name,
			payload === undefined ? null : JSON.stringify(payload),
			now,
		]);
		this.notify(id);
		return this.driveRun(id);
	}

	// ----------------------------------------------------------------- cancel

	cancel(principal: Principal, id: string): FlowRunView {
		const row = this.requireReadable(principal, id);
		requirePermission(principal, (row.cancel_permission ?? row.read_permission ?? 'project:update') as Permission);
		const definition = this.definitions.get(row.kind);
		const title = definition?.title ?? row.kind;
		if (!definition?.cancel) throw new ConflictError(`A ${title.toLowerCase()} cannot be cancelled.`);
		if (row.status === 'cancelled') return this.view(row);
		if (isTerminalFlow(row.status)) throw new ConflictError(`This ${title.toLowerCase()} already ${row.status}.`);
		const now = this.ctx.now();
		this.ctx.sqlite.run('UPDATE flow_runs SET cancel_requested = 1, updated_at = ? WHERE id = ?', [now, id]);
		this.log(id, row.step, row.attempt, 'cancel-requested', `Requested by ${principal.userId}.`, now);
		this.notify(id);
		void this.driveRun(id).catch((error: unknown) => console.error('[flows] cancel', error));
		const after = this.requireRow(id);
		// A refusal is logged; a cancel that moved into a compensation step is not one.
		if (this.lastEvent(id) === 'cancel-refused')
			throw new ConflictError(`This ${title.toLowerCase()} cannot be cancelled while it is in step "${after.step}".`);
		return this.view(after);
	}

	// ------------------------------------------------------------------ drive

	/**
	 * Advance every due run: queued ones, waiting ones whose signal arrived or whose deadline
	 * passed, and cancels. The control plane calls this every few seconds and from maintenance.
	 */
	drive(options: { kind?: string; limit?: number } = {}): FlowDriveResult {
		const now = this.ctx.now();
		const kind = options.kind ?? null;
		const rows = this.ctx.sqlite
			.query<{ id: string }, (string | number | null)[]>(
				`SELECT r.id FROM flow_runs r
				 WHERE r.status IN ('queued', 'waiting') AND (? IS NULL OR r.kind = ?) AND (
				   (r.deadline_at IS NOT NULL AND r.deadline_at <= ?)
				   OR r.cancel_requested = 1
				   OR ((r.wake_at IS NULL OR r.wake_at <= ?) AND (
				     r.status = 'queued'
				     OR (r.wait_deadline IS NOT NULL AND r.wait_deadline <= ?)
				     OR EXISTS (SELECT 1 FROM flow_signals s
				                WHERE s.run_id = r.id AND s.name = r.waiting_for AND s.consumed_at IS NULL)))
				 )
				 ORDER BY r.updated_at ASC
				 LIMIT ?`,
			)
			.all(kind, kind, now, now, now, Math.max(1, options.limit ?? 50));
		let processed = 0;
		const pending: Promise<void>[] = [];
		for (const { id } of rows) {
			const row = this.getRow(id);
			if (!row) continue;
			const trigger = this.triggerFor(row, now);
			if (!trigger) continue;
			const claimed = this.claim(id, now);
			if (!claimed) continue;
			processed += 1;
			const result = this.process(claimed, trigger, 0);
			if (isPromise(result)) pending.push(result.catch((error: unknown) => console.error('[flows]', error)));
		}
		return { processed, settled: Promise.all(pending).then(() => undefined) };
	}

	/**
	 * Recover runs whose handler never returned (the process died mid-step): they go back to their
	 * step, or fail once the step has used its attempts. Idempotent.
	 */
	tick(now = this.ctx.now()): { resumed: number; failed: number } {
		let resumed = 0;
		let failed = 0;
		const lost = this.ctx.sqlite
			.query<FlowRunRow, [number]>(
				"SELECT * FROM flow_runs WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?)",
			)
			.all(now);
		for (const row of lost) {
			const definition = this.definitions.get(row.kind);
			const attempt = row.attempt + 1;
			if (definition && attempt >= (definition.maxAttempts ?? flowLimits.maxAttempts)) {
				const claimed = this.ctx.sqlite
					.query<FlowRunRow, [string, number, number, string, number]>(
						`UPDATE flow_runs SET lease_owner = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?
						 WHERE id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?) RETURNING *`,
					)
					.get(this.workerId, now + flowLimits.leaseMs, now, row.id, now);
				if (!claimed) continue;
				failed += 1;
				void Promise.resolve(this.failRun(definition, claimed, 'The step was interrupted too many times.')).catch(
					(error: unknown) => console.error('[flows] tick', error),
				);
				continue;
			}
			const status: FlowStatus = row.waiting_for ? 'waiting' : 'queued';
			const changed = this.ctx.sqlite.run(
				`UPDATE flow_runs SET status = ?, attempt = ?, wake_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
				 WHERE id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?)`,
				[status, attempt, now, now, row.id, now],
			).changes;
			if (!changed) continue;
			resumed += 1;
			this.log(row.id, row.step, attempt, 'resumed', 'The previous attempt lost its lease.', now);
			this.notify(row.id);
		}
		return { resumed, failed };
	}

	/** Maintenance: drop finished runs, their step logs and signals after the retention window. */
	prune(now = this.ctx.now()): number {
		const cutoff = now - flowLimits.retentionDays * 86_400_000;
		const ids = this.ctx.sqlite
			.query<{ id: string }, [number]>(
				"SELECT id FROM flow_runs WHERE status IN ('succeeded', 'failed', 'cancelled') AND finished_at <= ? LIMIT 500",
			)
			.all(cutoff)
			.map((row) => row.id);
		if (ids.length === 0) return 0;
		const marks = ids.map(() => '?').join(', ');
		this.ctx.sqlite.transaction(() => {
			this.ctx.sqlite.run(`DELETE FROM flow_steps WHERE run_id IN (${marks})`, ids);
			this.ctx.sqlite.run(`DELETE FROM flow_signals WHERE run_id IN (${marks})`, ids);
			this.ctx.sqlite.run(`DELETE FROM flow_runs WHERE id IN (${marks})`, ids);
		})();
		return ids.length;
	}

	// ----------------------------------------------------------------- reads

	get(principal: Principal, id: string, options: { steps?: boolean } = {}): FlowRunView {
		return this.view(this.requireReadable(principal, id), options);
	}

	list(principal: Principal, filter: FlowListFilter = {}): FlowRunView[] {
		const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
		const rows = this.ctx.sqlite
			.query<FlowRunRow, (string | number | null)[]>(
				`SELECT * FROM flow_runs
				 WHERE (org_id = ? OR (org_id IS NULL AND ? = 1))
				   AND (? IS NULL OR kind = ?) AND (? IS NULL OR status = ?)
				   AND (? IS NULL OR (subject_kind = ? AND subject_id = ?))
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT ?`,
			)
			.all(
				principal.orgId,
				principal.platformAdmin ? 1 : 0,
				filter.kind ?? null,
				filter.kind ?? null,
				filter.status ?? null,
				filter.status ?? null,
				filter.subject?.kind ?? null,
				filter.subject?.kind ?? null,
				filter.subject?.id ?? null,
				limit,
			);
		return rows.filter((row) => this.canRead(principal, row)).map((row) => this.view(row));
	}

	/** The newest run (any status) for this kind + key, for linking a domain row to its run. */
	idFor(kind: string, key: string): string | null {
		return (
			this.ctx.sqlite
				.query<{ id: string }, [string, string]>(
					'SELECT id FROM flow_runs WHERE kind = ? AND key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
				)
				.get(kind, key)?.id ?? null
		);
	}

	/** The active run for this kind + key, if any. */
	findActive(kind: string, key: string): { id: string; step: string; status: FlowStatus } | null {
		const row = this.activeRow(kind, key);
		return row ? { id: row.id, step: row.step, status: row.status } : null;
	}

	/**
	 * Resolve once the run is terminal or `timeoutMs` passed, with its latest view. Wakes on
	 * in-process transitions and polls once a second for ones another process makes.
	 */
	async wait(principal: Principal, id: string, timeoutMs: number): Promise<FlowRunView> {
		let row = this.requireReadable(principal, id);
		const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), flowLimits.maxWaitMs);
		while (!isTerminalFlow(row.status) && Date.now() < deadline) {
			await this.changed(id, Math.min(1_000, deadline - Date.now()));
			row = this.requireRow(id);
		}
		return this.view(row);
	}

	/** Progress events for one run: `progress` on every change, then `done` once it is terminal. */
	async *events(
		principal: Principal,
		id: string,
		options: { signal?: AbortSignal } = {},
	): AsyncGenerator<{ type: 'progress' | 'done'; flow: FlowRunView }> {
		let row = this.requireReadable(principal, id);
		let last = '';
		while (!options.signal?.aborted) {
			const view = this.view(row);
			const fingerprint = `${row.updated_at}:${row.status}:${row.step}`;
			if (fingerprint !== last) {
				last = fingerprint;
				if (isTerminalFlow(row.status)) {
					yield { type: 'done', flow: view };
					return;
				}
				yield { type: 'progress', flow: view };
			}
			await this.changed(id, 1_000);
			row = this.requireRow(id);
		}
	}

	// ------------------------------------------------------------- internals

	private driveRun(id: string): Promise<void> {
		const now = this.ctx.now();
		const row = this.getRow(id);
		if (!row) return RESOLVED;
		const trigger = this.triggerFor(row, now);
		if (!trigger) return RESOLVED;
		const claimed = this.claim(id, now);
		if (!claimed) return RESOLVED;
		const result = this.process(claimed, trigger, 0);
		return isPromise(result) ? result : RESOLVED;
	}

	private triggerFor(row: FlowRunRow, now: number): Trigger | null {
		if (row.status !== 'queued' && row.status !== 'waiting') return null;
		if (row.deadline_at !== null && row.deadline_at <= now) return { type: 'deadline' };
		if (row.cancel_requested) return { type: 'cancel' };
		if (row.wake_at !== null && row.wake_at > now) return null;
		if (row.status === 'queued') return { type: 'enter' };
		const signal = row.waiting_for ? this.pendingSignal(row.id, row.waiting_for) : null;
		if (signal)
			return { type: 'signal', signalId: signal.id, name: signal.name, payload: parseJson(signal.payload_json, null) };
		if (row.wait_deadline !== null && row.wait_deadline <= now) return { type: 'timeout' };
		return null;
	}

	private claim(id: string, now: number): FlowRunRow | null {
		return (
			this.ctx.sqlite
				.query<FlowRunRow, [string, number, number, string]>(
					`UPDATE flow_runs SET status = 'running', lease_owner = ?, lease_until = ?, updated_at = ?
					 WHERE id = ? AND status IN ('queued', 'waiting') RETURNING *`,
				)
				.get(this.workerId, now + flowLimits.leaseMs, now, id) ?? null
		);
	}

	/** Run handlers for a claimed run until it parks, finishes or yields. */
	private process(row: FlowRunRow, trigger: Trigger, hops: number): void | Promise<void> {
		const definition = this.definitions.get(row.kind);
		if (!definition) {
			this.finish(row, 'failed', { error: `No flow definition is registered for "${row.kind}".` });
			return;
		}
		if (trigger.type === 'deadline') return this.failRun(definition, row, 'The run passed its deadline.');
		if (hops >= flowLimits.maxHopsPerDrive) {
			this.park(row, { status: 'queued', wakeAt: this.ctx.now() }, 'retry', 'Yielded to other runs.');
			return;
		}
		let outcome: MaybePromise<FlowOutcome | null>;
		try {
			outcome = this.invoke(definition, row, trigger);
		} catch (error) {
			return this.handleError(definition, row, trigger, error);
		}
		if (isPromise(outcome))
			return outcome.then(
				(value) => this.continueWith(definition, row, trigger, value, hops),
				(error: unknown) => this.handleError(definition, row, trigger, error),
			);
		return this.continueWith(definition, row, trigger, outcome, hops);
	}

	private continueWith(
		definition: AnyDefinition,
		row: FlowRunRow,
		trigger: Trigger,
		outcome: FlowOutcome | null,
		hops: number,
	): void | Promise<void> {
		let next: Continuation;
		try {
			next = this.apply(definition, row, trigger, outcome);
		} catch (error) {
			return this.handleError(definition, row, trigger, error);
		}
		if (!next) return;
		return this.process(next.row, next.trigger, hops + 1);
	}

	private invoke(definition: AnyDefinition, row: FlowRunRow, trigger: Trigger): MaybePromise<FlowOutcome | null> {
		const context = this.stepContext(row);
		if (trigger.type === 'cancel') return definition.cancel ? definition.cancel(context) : null;
		const step = definition.steps[row.step];
		if (!step) throw new Error(`Flow "${row.kind}" has no step "${row.step}".`);
		switch (trigger.type) {
			case 'enter':
				return step.run(context);
			case 'signal':
				if (!step.onSignal) return flow.fail(`Step "${row.step}" cannot handle the signal "${trigger.name}".`);
				return step.onSignal(context, { name: trigger.name, payload: trigger.payload });
			case 'timeout':
				return step.onTimeout
					? step.onTimeout(context)
					: flow.fail(`Timed out waiting for ${row.waiting_for ?? 'a signal'} in step "${row.step}".`);
			default:
				return null;
		}
	}

	/** Write the transition an outcome asks for. Returns what to process next in this drive. */
	private apply(
		definition: AnyDefinition,
		row: FlowRunRow,
		trigger: Trigger,
		outcome: FlowOutcome | null,
	): Continuation {
		const now = this.ctx.now();
		const signalId = trigger.type === 'signal' ? trigger.signalId : null;

		if (outcome === null) {
			if (trigger.type === 'cancel') {
				this.park(row, { status: row.waiting_for ? 'waiting' : 'queued', clearCancel: true }, 'cancel-refused', `Step "${row.step}" cannot be cancelled.`);
				return this.followUp(row.id);
			}
			// The handler ignored the signal: consume it and keep waiting with the same deadline.
			this.park(row, { status: 'waiting', signalId }, 'signal', `Ignored ${trigger.type === 'signal' ? trigger.name : 'signal'}.`);
			return this.followUp(row.id);
		}

		if (outcome.type === 'next' && !definition.steps[outcome.step])
			throw new Error(`Flow "${row.kind}" has no step "${outcome.step}".`);
		const state = outcome.type === 'cancel' ? row.state_json : mergeState(row.state_json, outcome.state);
		const clearCancel = trigger.type === 'cancel';

		switch (outcome.type) {
			case 'next': {
				const moved = this.ctx.sqlite.transaction(() => {
					this.consumeSignal(signalId, now);
					const changed = this.ctx.sqlite.run(
						`UPDATE flow_runs
						 SET step = ?, attempt = 0, state_json = ?, waiting_for = NULL, wait_deadline = NULL, wake_at = NULL,
						     detail = COALESCE(?, detail), cancel_requested = CASE WHEN ? THEN 0 ELSE cancel_requested END,
						     lease_until = ?, updated_at = ?
						 WHERE id = ? AND status = 'running' AND lease_owner = ?`,
						[outcome.step, state, clip(outcome.detail ?? null), clearCancel ? 1 : 0, now + flowLimits.leaseMs, now, row.id, this.workerId],
					).changes;
					if (changed) this.log(row.id, outcome.step, 0, 'next', this.describe(trigger, outcome.detail), now);
					return changed > 0;
				})();
				this.notify(row.id);
				if (!moved) return null;
				const fresh = this.requireRow(row.id);
				return { row: fresh, trigger: fresh.cancel_requested ? { type: 'cancel' } : { type: 'enter' } };
			}
			case 'wait': {
				const deadline = outcome.timeoutMs !== undefined ? now + outcome.timeoutMs : null;
				const parked = this.ctx.sqlite.transaction(() => {
					this.consumeSignal(signalId, now);
					const changed = this.ctx.sqlite.run(
						`UPDATE flow_runs
						 SET status = 'waiting', attempt = 0, state_json = ?, waiting_for = ?, wait_deadline = ?, wake_at = NULL,
						     detail = COALESCE(?, detail), cancel_requested = CASE WHEN ? THEN 0 ELSE cancel_requested END,
						     lease_owner = NULL, lease_until = NULL, updated_at = ?
						 WHERE id = ? AND status = 'running' AND lease_owner = ?`,
						[state, outcome.signal, deadline, clip(outcome.detail ?? null), clearCancel ? 1 : 0, now, row.id, this.workerId],
					).changes;
					if (changed) this.log(row.id, row.step, 0, 'wait', outcome.detail ?? `Waiting for ${outcome.signal}.`, now);
					return changed > 0;
				})();
				this.notify(row.id);
				return parked ? this.followUp(row.id) : null;
			}
			case 'succeed':
				this.finish(row, 'succeeded', { result: outcome.result, state, signalId, detail: outcome.detail });
				return null;
			case 'fail':
				this.finish(row, 'failed', { error: outcome.error, state, signalId });
				return null;
			case 'cancel':
				this.finish(row, 'cancelled', { state, signalId, detail: outcome.detail ?? 'Cancelled.' });
				return null;
		}
	}

	/** After parking, pick the run straight back up if a signal or cancel is already waiting. */
	private followUp(id: string): Continuation {
		const now = this.ctx.now();
		const row = this.getRow(id);
		if (!row) return null;
		const trigger = this.triggerFor(row, now);
		if (!trigger) return null;
		const claimed = this.claim(id, now);
		return claimed ? { row: claimed, trigger } : null;
	}

	private handleError(definition: AnyDefinition, row: FlowRunRow, trigger: Trigger, error: unknown): void | Promise<void> {
		const message = errorText(error);
		if (trigger.type === 'cancel') {
			this.park(row, { status: row.waiting_for ? 'waiting' : 'queued', clearCancel: true }, 'cancel-refused', `Cancel failed: ${message}`);
			return;
		}
		const attempt = row.attempt + 1;
		const maxAttempts = definition.maxAttempts ?? flowLimits.maxAttempts;
		if (attempt >= maxAttempts) return this.failRun(definition, row, message);
		const now = this.ctx.now();
		// A signal or timeout handler that threw retries with the run still waiting; the signal
		// stays unconsumed, so it is delivered again.
		const status: FlowStatus = trigger.type === 'enter' ? 'queued' : 'waiting';
		this.ctx.sqlite.run(
			`UPDATE flow_runs SET status = ?, attempt = ?, wake_at = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
			 WHERE id = ? AND status = 'running' AND lease_owner = ?`,
			[status, attempt, now + flowRetryDelayMs(attempt), now, row.id, this.workerId],
		);
		this.log(row.id, row.step, attempt, 'retry', message, now);
		this.notify(row.id);
	}

	/** Fail a run the engine gives up on, after the definition's compensation. */
	private failRun(definition: AnyDefinition, row: FlowRunRow, error: string): void | Promise<void> {
		const end = () => this.finish(row, 'failed', { error });
		if (!definition.onFailure) return end();
		const note = (failure: unknown) =>
			this.log(row.id, row.step, row.attempt, 'failed', `Compensation failed: ${errorText(failure)}`, this.ctx.now());
		try {
			const result = definition.onFailure(this.stepContext(row), error);
			if (isPromise(result))
				return result.then(end, (failure: unknown) => {
					note(failure);
					end();
				});
		} catch (failure) {
			note(failure);
		}
		return end();
	}

	private finish(
		row: FlowRunRow,
		status: 'succeeded' | 'failed' | 'cancelled',
		options: { result?: unknown; error?: string; state?: string; signalId?: number | null; detail?: string },
	): void {
		const now = this.ctx.now();
		const error = options.error === undefined ? null : clip(options.error);
		this.ctx.sqlite.transaction(() => {
			this.consumeSignal(options.signalId ?? null, now);
			const changed = this.ctx.sqlite.run(
				`UPDATE flow_runs
				 SET status = ?, state_json = ?, result_json = ?, error = ?, detail = COALESCE(?, detail),
				     waiting_for = NULL, wait_deadline = NULL, wake_at = NULL, cancel_requested = 0,
				     lease_owner = NULL, lease_until = NULL, updated_at = ?, finished_at = ?
				 WHERE id = ? AND status = 'running' AND lease_owner = ?`,
				[
					status,
					options.state ?? row.state_json,
					options.result === undefined ? null : JSON.stringify(options.result),
					error,
					clip(options.detail ?? null),
					now,
					now,
					row.id,
					this.workerId,
				],
			).changes;
			if (changed) this.log(row.id, row.step, row.attempt, status, error ?? options.detail ?? null, now);
		})();
		this.notify(row.id);
	}

	private park(
		row: FlowRunRow,
		options: { status: FlowStatus; wakeAt?: number; signalId?: number | null; clearCancel?: boolean },
		event: FlowStepEvent,
		detail: string,
	): void {
		const now = this.ctx.now();
		this.ctx.sqlite.transaction(() => {
			this.consumeSignal(options.signalId ?? null, now);
			const changed = this.ctx.sqlite.run(
				`UPDATE flow_runs
				 SET status = ?, wake_at = ?, cancel_requested = CASE WHEN ? THEN 0 ELSE cancel_requested END,
				     lease_owner = NULL, lease_until = NULL, updated_at = ?
				 WHERE id = ? AND status = 'running' AND lease_owner = ?`,
				[options.status, options.wakeAt ?? null, options.clearCancel ? 1 : 0, now, row.id, this.workerId],
			).changes;
			if (changed) this.log(row.id, row.step, row.attempt, event, detail, now);
		})();
		this.notify(row.id);
	}

	private consumeSignal(signalId: number | null, now: number): void {
		if (signalId === null) return;
		this.ctx.sqlite.run('UPDATE flow_signals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [now, signalId]);
	}

	private pendingSignal(runId: string, name: string): SignalRow | null {
		return (
			this.ctx.sqlite
				.query<SignalRow, [string, string]>(
					'SELECT id, name, payload_json FROM flow_signals WHERE run_id = ? AND name = ? AND consumed_at IS NULL ORDER BY id LIMIT 1',
				)
				.get(runId, name) ?? null
		);
	}

	private log(runId: string, step: string, attempt: number, event: FlowStepEvent, detail: string | null, at: number): void {
		this.ctx.sqlite.run(
			`INSERT INTO flow_steps (run_id, seq, step, attempt, event, detail, at)
			 VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM flow_steps WHERE run_id = ?), ?, ?, ?, ?, ?)`,
			[runId, runId, step, attempt, event, clip(detail), at],
		);
	}

	private lastEvent(runId: string): FlowStepEvent | null {
		return (
			this.ctx.sqlite
				.query<{ event: FlowStepEvent }, [string]>('SELECT event FROM flow_steps WHERE run_id = ? ORDER BY seq DESC LIMIT 1')
				.get(runId)?.event ?? null
		);
	}

	private describe(trigger: Trigger, detail: string | undefined): string | null {
		if (detail) return detail;
		if (trigger.type === 'signal') return `After ${trigger.name}.`;
		if (trigger.type === 'timeout') return 'After a timeout.';
		if (trigger.type === 'cancel') return 'Cancelling.';
		return null;
	}

	private stepContext(row: FlowRunRow): FlowStepContext<Record<string, unknown>> {
		return {
			ctx: this.ctx,
			run: {
				id: row.id,
				kind: row.kind,
				key: row.key,
				orgId: row.org_id,
				step: row.step,
				attempt: row.attempt,
				createdBy: row.created_by,
				subject: row.subject_kind && row.subject_id ? { kind: row.subject_kind, id: row.subject_id } : null,
			},
			state: parseJson<Record<string, unknown>>(row.state_json, {}),
			now: this.ctx.now(),
		};
	}

	private canRead(principal: Principal, row: FlowRunRow): boolean {
		if (row.org_id === null ? !principal.platformAdmin : row.org_id !== principal.orgId && !principal.platformAdmin)
			return false;
		if (!row.read_permission) return true;
		return principal.permissions.has(row.read_permission as Permission) || principal.platformAdmin === true;
	}

	private requireReadable(principal: Principal, id: string): FlowRunRow {
		const row = this.getRow(id);
		// An unreadable run looks missing, so ids of other orgs' work never leak.
		if (!row || !this.canRead(principal, row)) throw new NotFoundError('Operation');
		return row;
	}

	private requireDefinition(kind: string): AnyDefinition {
		const definition = this.definitions.get(kind);
		if (!definition) throw new ValidationError(`Unknown flow "${kind}".`);
		return definition;
	}

	private getRow(id: string): FlowRunRow | null {
		return this.ctx.sqlite.query<FlowRunRow, [string]>('SELECT * FROM flow_runs WHERE id = ?').get(id) ?? null;
	}

	private requireRow(id: string): FlowRunRow {
		const row = this.getRow(id);
		if (!row) throw new NotFoundError('Operation');
		return row;
	}

	private activeRow(kind: string, key: string): FlowRunRow | null {
		return (
			this.ctx.sqlite
				.query<FlowRunRow, [string, string]>(
					"SELECT * FROM flow_runs WHERE kind = ? AND key = ? AND status IN ('queued', 'running', 'waiting') LIMIT 1",
				)
				.get(kind, key) ?? null
		);
	}

	private view(row: FlowRunRow, options: { steps?: boolean } = {}): FlowRunView {
		const definition = this.definitions.get(row.kind);
		return {
			id: row.id,
			kind: row.kind,
			title: definition?.title ?? row.kind,
			status: row.status,
			step: row.step,
			subject: row.subject_kind && row.subject_id ? { kind: row.subject_kind, id: row.subject_id } : null,
			waitingFor: row.status === 'waiting' ? row.waiting_for : null,
			waitDeadline: row.status === 'waiting' && row.wait_deadline !== null ? iso(row.wait_deadline) : null,
			attempt: row.attempt,
			detail: row.detail,
			error: row.error,
			result: parseJson<unknown>(row.result_json, null),
			cancelRequested: row.cancel_requested === 1,
			createdBy: row.created_by,
			createdAt: iso(row.created_at),
			updatedAt: iso(row.updated_at),
			finishedAt: row.finished_at === null ? null : iso(row.finished_at),
			...(options.steps ? { steps: this.steps(row.id) } : {}),
		};
	}

	private steps(runId: string): FlowStepLogEntry[] {
		return this.ctx.sqlite
			.query<{ seq: number; step: string; attempt: number; event: FlowStepEvent; detail: string | null; at: number }, [string]>(
				'SELECT seq, step, attempt, event, detail, at FROM flow_steps WHERE run_id = ? ORDER BY seq',
			)
			.all(runId)
			.map((entry) => ({ ...entry, at: iso(entry.at) }));
	}

	private notify(id: string): void {
		const set = this.listeners.get(id);
		if (!set) return;
		for (const listener of [...set]) listener();
	}

	/** Resolve on the next in-process change to this run, or after `ms`. */
	private changed(id: string, ms: number): Promise<void> {
		return new Promise((resolve) => {
			const set = this.listeners.get(id) ?? new Set<() => void>();
			this.listeners.set(id, set);
			const done = () => {
				clearTimeout(timer);
				set.delete(done);
				if (set.size === 0) this.listeners.delete(id);
				resolve();
			};
			const timer = setTimeout(done, Math.max(0, ms));
			set.add(done);
		});
	}
}

/** Exponential backoff for a step whose handler threw, capped. */
export function flowRetryDelayMs(attempt: number): number {
	return Math.min(flowLimits.retryCapMs, flowLimits.retryBaseMs * 2 ** Math.max(0, attempt - 1));
}

function isPromise<T>(value: MaybePromise<T>): value is Promise<T> {
	return typeof (value as { then?: unknown } | null)?.then === 'function';
}

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function errorText(error: unknown): string {
	return clip(error instanceof Error ? error.message : String(error)) ?? 'Unknown error';
}

function clip(value: string | null): string | null {
	if (value === null) return null;
	return value.length > DETAIL_MAX ? `${value.slice(0, DETAIL_MAX - 1)}…` : value;
}

function serializeState(input: unknown): string {
	try {
		const json = JSON.stringify(input ?? {});
		if (!json.startsWith('{')) throw new Error('not an object');
		return json;
	} catch {
		throw new ValidationError('A flow input must be a JSON object.');
	}
}

function mergeState(current: string, patch: Record<string, unknown> | undefined): string {
	if (!patch) return current;
	return JSON.stringify({ ...parseJson<Record<string, unknown>>(current, {}), ...patch });
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}
