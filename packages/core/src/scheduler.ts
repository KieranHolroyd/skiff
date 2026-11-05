import { nextCronTime } from './cron.ts';
import type { CoreContext } from './context.ts';
import { ValidationError } from './errors.ts';
import { newId } from './util.ts';

/**
 * Generic durable scheduler (F4). Feature code owns the meaning of `kind` and `key`; this module
 * only stores, leases and retries work. It deliberately has no feature-specific logic.
 *
 * Idempotency: a queued or leased `kind + key` is never duplicated. Enqueueing the same key after
 * it reached a terminal state (`ok`, `failed`, `cancelled`) re-arms that row as a fresh occurrence,
 * which lets a recurring producer keep using a stable key (for example `backup:<database id>`).
 */
export type ScheduledTaskStatus = 'queued' | 'leased' | 'ok' | 'failed' | 'cancelled';

export interface ScheduledTask {
	id: string;
	kind: string;
	key: string;
	/** Epoch ms; the task is claimable once this is at or before `now`. */
	runAt: number;
	leaseUntil: number | null;
	attempts: number;
	maxAttempts: number;
	payloadJson: string | null;
	status: ScheduledTaskStatus;
	resultJson: string | null;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
}

/** A task handed to a worker. The worker id is for correlation; ownership is the time lease. */
export interface ClaimedTask extends ScheduledTask {
	workerId: string;
}

export interface EnqueueInput {
	kind: string;
	key: string;
	/** Epoch ms. Defaults to the service clock. */
	runAt?: number;
	payload?: unknown;
	maxAttempts?: number;
}

export interface SchedulerTickResult {
	/** Leases that were past `leaseUntil`. */
	expired: number;
	/** Expired leases returned to the queue. */
	requeued: number;
	/** Expired leases that had exhausted `maxAttempts`. */
	failed: number;
}

/** Long enough for a slow backup, short enough that a crash is noticed within a few sweeps. */
export const DEFAULT_LEASE_MS = 5 * 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 3_600_000;

const activeStatuses = new Set<ScheduledTaskStatus>(['queued', 'leased']);

/** Exponential backoff after a failed attempt, capped at one hour. */
export function retryDelayMs(
	attempts: number,
	baseMs = RETRY_BASE_MS,
	capMs = RETRY_CAP_MS,
): number {
	const exponent = Math.max(0, attempts - 1);
	return Math.min(capMs, baseMs * 2 ** exponent);
}

/**
 * Next cron fire strictly after `from`, using the same five-field UTC parser as backups.
 * `null` means the expression can never fire (for example 31 February).
 */
export function nextRun(expression: string, from: number): number | null {
	return nextCronTime(expression, from);
}

interface ScheduledTaskRow {
	id: string;
	kind: string;
	key: string;
	run_at: number;
	lease_until: number | null;
	attempts: number;
	max_attempts: number;
	payload_json: string | null;
	status: ScheduledTaskStatus;
	result_json: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

const SELECT_COLUMNS =
	'id, kind, key, run_at, lease_until, attempts, max_attempts, payload_json, status, result_json, last_error, created_at, updated_at';

function toTask(row: ScheduledTaskRow): ScheduledTask {
	return {
		id: row.id,
		kind: row.kind,
		key: row.key,
		runAt: row.run_at,
		leaseUntil: row.lease_until,
		attempts: row.attempts,
		maxAttempts: row.max_attempts,
		payloadJson: row.payload_json,
		status: row.status,
		resultJson: row.result_json,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SchedulerService {
	constructor(private readonly ctx: CoreContext) {}

	/**
	 * Insert a task, or return the existing one for this `kind + key`. Active tasks are left
	 * untouched (first enqueue wins); terminal tasks are re-armed with fresh attempts.
	 */
	enqueue(input: EnqueueInput): string {
		const kind = requireText(input.kind, 'kind');
		const key = requireText(input.key, 'key');
		if (
			input.maxAttempts !== undefined &&
			(!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1)
		)
			throw new ValidationError('maxAttempts must be a positive integer.');
		const now = this.ctx.now();
		const runAt = input.runAt ?? now;
		if (!Number.isFinite(runAt) || !Number.isInteger(runAt))
			throw new ValidationError('runAt must be epoch milliseconds.');
		const payloadJson = serializePayload(input.payload);
		const id = newId('task_');
		const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

		const inserted = this.ctx.sqlite.run(
			`INSERT INTO scheduled_tasks
			   (id, kind, key, run_at, lease_until, attempts, max_attempts, payload_json, status,
			    result_json, last_error, created_at, updated_at)
			 VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 'queued', NULL, NULL, ?, ?)
			 ON CONFLICT(kind, key) DO NOTHING`,
			[id, kind, key, runAt, maxAttempts, payloadJson, now, now],
		);
		if (inserted.changes > 0) return id;

		const existing = this.getByKey(kind, key);
		if (!existing) throw new ValidationError('Task disappeared while enqueueing.');
		if (activeStatuses.has(existing.status)) return existing.id;

		// A fresh occurrence keeps a custom cap from the previous run unless the caller overrides it.
		const rearmedMaxAttempts = input.maxAttempts ?? existing.maxAttempts;
		this.ctx.sqlite.run(
			`UPDATE scheduled_tasks
			 SET run_at = ?, lease_until = NULL, attempts = 0, max_attempts = ?, payload_json = ?,
			     status = 'queued', result_json = NULL, last_error = NULL, updated_at = ?
			 WHERE id = ? AND status IN ('ok', 'failed', 'cancelled')`,
			[runAt, rearmedMaxAttempts, payloadJson, now, existing.id],
		);
		return existing.id;
	}

	/**
	 * Claim up to `limit` due tasks in one atomic UPDATE, so two control planes cannot lease the
	 * same row. The attempt counter increments at claim time, before any work starts.
	 */
	claim(
		workerId: string,
		limit = 1,
		now = this.ctx.now(),
		leaseMs = DEFAULT_LEASE_MS,
		kind?: string,
	): ClaimedTask[] {
		const worker = requireText(workerId, 'workerId');
		if (!Number.isInteger(limit) || limit < 1) throw new ValidationError('limit must be positive.');
		if (!Number.isInteger(leaseMs) || leaseMs < 1)
			throw new ValidationError('leaseMs must be positive.');
		const filter = 'AND (? IS NULL OR kind = ?)';
		const leaseUntil = now + leaseMs;
		const rows = this.ctx.sqlite
			.query<ScheduledTaskRow, [number, number, number, string | null, string | null, number]>(
				`UPDATE scheduled_tasks
				 SET status = 'leased', lease_until = ?, attempts = attempts + 1, updated_at = ?
				 WHERE id IN (
				   SELECT id FROM scheduled_tasks
				   WHERE status = 'queued' AND run_at <= ? ${filter}
				   ORDER BY run_at ASC, created_at ASC
				   LIMIT ?
				 )
				 RETURNING ${SELECT_COLUMNS}`,
			)
			.all(leaseUntil, now, now, kind ?? null, kind ?? null, limit);
		return rows.map((row) => ({ ...toTask(row), workerId: worker }));
	}

	/** Mark a claimed task successful. Returns false when it is already terminal or missing. */
	complete(id: string, resultJson: string | null = null): boolean {
		const result = this.ctx.sqlite.run(
			`UPDATE scheduled_tasks
			 SET status = 'ok', result_json = ?, lease_until = NULL, last_error = NULL, updated_at = ?
			 WHERE id = ? AND status IN ('queued', 'leased')`,
			[resultJson, this.ctx.now(), id],
		);
		return result.changes > 0;
	}

	/**
	 * Record a failed attempt. Retries with exponential backoff until `maxAttempts` is reached,
	 * then the task becomes `failed`. An explicit `retryAt` overrides the computed backoff but
	 * cannot bypass the attempt cap.
	 */
	fail(id: string, error: string, retryAt?: number): boolean {
		const task = this.get(id);
		if (!task || !activeStatuses.has(task.status)) return false;
		const now = this.ctx.now();
		const canRetry = task.attempts < task.maxAttempts;
		if (canRetry && retryAt !== undefined && !Number.isFinite(retryAt))
			throw new ValidationError('retryAt must be epoch milliseconds.');
		const runAt = canRetry ? (retryAt ?? now + retryDelayMs(task.attempts)) : task.runAt;
		const result = this.ctx.sqlite.run(
			`UPDATE scheduled_tasks
			 SET status = ?, run_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
			 WHERE id = ? AND status IN ('queued', 'leased')`,
			[canRetry ? 'queued' : 'failed', runAt, error, now, id],
		);
		return result.changes > 0;
	}

	/** Cancel a queued or leased task. Cancelling an already-cancelled task succeeds. */
	cancel(id: string): boolean {
		const result = this.ctx.sqlite.run(
			`UPDATE scheduled_tasks
			 SET status = 'cancelled', lease_until = NULL, updated_at = ?
			 WHERE id = ? AND status IN ('queued', 'leased')`,
			[this.ctx.now(), id],
		);
		if (result.changes > 0) return true;
		return this.get(id)?.status === 'cancelled';
	}

	/**
	 * Expire leases whose worker stopped heartbeating by finishing the work. A task under
	 * `maxAttempts` goes back to the queue immediately; one at the cap is failed. Idempotent:
	 * a second tick with the same clock changes nothing.
	 */
	tick(now = this.ctx.now()): SchedulerTickResult {
		const failed = this.ctx.sqlite.run(
			`UPDATE scheduled_tasks
			 SET status = 'failed', lease_until = NULL,
			     last_error = COALESCE(last_error, 'Lease expired before completion'),
			     updated_at = ?
			 WHERE status = 'leased' AND (lease_until IS NULL OR lease_until <= ?)
			   AND attempts >= max_attempts`,
			[now, now],
		).changes;
		const requeued = this.ctx.sqlite.run(
			`UPDATE scheduled_tasks
			 SET status = 'queued', run_at = ?, lease_until = NULL,
			     last_error = COALESCE(last_error, 'Lease expired before completion'),
			     updated_at = ?
			 WHERE status = 'leased' AND (lease_until IS NULL OR lease_until <= ?)
			   AND attempts < max_attempts`,
			[now, now, now],
		).changes;
		return { expired: failed + requeued, requeued, failed };
	}

	get(id: string): ScheduledTask | null {
		const row = this.ctx.sqlite
			.query<ScheduledTaskRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM scheduled_tasks WHERE id = ?`)
			.get(id);
		return row ? toTask(row) : null;
	}

	getByKey(kind: string, key: string): ScheduledTask | null {
		const row = this.ctx.sqlite
			.query<ScheduledTaskRow, [string, string]>(
				`SELECT ${SELECT_COLUMNS} FROM scheduled_tasks WHERE kind = ? AND key = ?`,
			)
			.get(kind, key);
		return row ? toTask(row) : null;
	}

	/** Next fire for a cron expression, using this service's clock by default. */
	nextRun(expression: string, from = this.ctx.now()): number | null {
		return nextRun(expression, from);
	}
}

function requireText(value: string, field: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new ValidationError(`${field} must not be empty.`);
	return trimmed;
}

function serializePayload(payload: unknown): string | null {
	if (payload === undefined) return null;
	try {
		return JSON.stringify(payload);
	} catch {
		throw new ValidationError('payload must be JSON-serializable.');
	}
}
