import {
	isTerminalOperation,
	itemStatuses,
	itemVerdicts,
	operationCreateSchema,
	operationLimits,
	pruneCategories,
	type ItemFlag,
	type ItemStatus,
	type ItemVerdict,
	type OperationActionId,
	type OperationActionInfo,
	type OperationCreate,
	type OperationEvent,
	type OperationItemView,
	type OperationKind,
	type OperationStatus,
	type OperationSummary,
	type OperationView,
	type Permission,
	type Principal,
	type PruneCategory,
	type PruneScope,
	type Role,
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import { ConflictError, CoreError, ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { buildPrincipal, readMembership } from '../orgs.ts';
import { newId } from '../util.ts';
import type { ActionDefinition, ItemResult, OperationParams, PlannedItem, RunContext, StoredItem } from './types.ts';

interface OperationRow {
	id: string;
	org_id: string | null;
	kind: OperationKind;
	action: OperationActionId;
	status: OperationStatus;
	stage: 'plan' | 'apply';
	params_json: string | null;
	summary_json: string | null;
	phase: string | null;
	total: number;
	done: number;
	failed: number;
	cancel_requested: number;
	actor_type: string;
	actor_id: string | null;
	client_id: string | null;
	principal_json: string;
	idempotency_key: string | null;
	heartbeat_at: number | null;
	plan_expires_at: number | null;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
}

interface ItemRow {
	operation_id: string;
	seq: number;
	category: string | null;
	target_kind: string;
	target_id: string;
	label: string | null;
	verdict: ItemVerdict;
	reason: string | null;
	flags_json: string | null;
	status: ItemStatus;
	error: string | null;
	bytes: number | null;
	data_json: string | null;
}

interface StoredPrincipal {
	kind: Principal['kind'];
	userId: string;
	orgId: string;
	role: Role;
	permissions: Permission[];
	clientId?: string;
	keyId?: string;
	platformAdmin?: boolean;
}

const HEARTBEAT_MS = 1_000;
const PLAN_CHUNK = 500;
const POLL_MS = 250;
const DAY_MS = 86_400_000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});

/** Can this principal see every org's operations (platform-scope prune history)? */
const seesPlatform = (principal: Principal): boolean =>
	principal.platformAdmin === true && (principal.kind === 'user' || principal.kind === 'apiKey');

/**
 * Mass actions and prune runs (docs/OPERATIONS.md). Operations are planned (a verdict per item),
 * optionally reviewed, then applied item by item in this process. Item status is persisted as it
 * runs, so `resume()` picks up an operation whose runner died (restart, crash) from the first
 * unfinished item.
 */
export class OperationService {
	private readonly definitions = new Map<OperationActionId, ActionDefinition>();
	/** Runs owned by this process, keyed by operation id. */
	private readonly running = new Map<string, Promise<void>>();

	constructor(private readonly ctx: CoreContext) {}

	register(definition: ActionDefinition): void {
		this.definitions.set(definition.info.id, definition);
	}

	/** Registered actions the principal can run from its surface (dashboard menu, CLI help). */
	actions(principal: Principal): OperationActionInfo[] {
		return [...this.definitions.values()]
			.filter((definition) => {
				try {
					this.checkSurface(principal, definition.info);
					definition.authorize(principal, { scope: 'org' });
					return true;
				} catch {
					return false;
				}
			})
			.map((definition) => definition.info);
	}

	// --- lifecycle --------------------------------------------------------------------------

	create(principal: Principal, input: OperationCreate, options: { idempotencyKey?: string } = {}): OperationView {
		const parsed = operationCreateSchema.parse(input);
		const definition = this.definition(parsed.action);
		this.checkSurface(principal, definition.info);

		const params: OperationParams = {};
		if (definition.info.kind === 'bulk') {
			const targets = [...new Set((parsed.targets ?? []).map((target) => target.trim()).filter(Boolean))];
			if (targets.length === 0) throw new ValidationError('Name at least one target.');
			const cap = principal.kind === 'mcp' ? operationLimits.mcpTargets : operationLimits.bulkTargets;
			if (targets.length > cap) throw new ValidationError(`At most ${cap} targets per operation from this surface.`);
			params.targets = targets;
		} else {
			params.scope = parsed.scope ?? 'org';
			if (parsed.categories?.length) params.categories = [...new Set(parsed.categories)];
			// Prune is always reviewed before it runs (docs/OPERATIONS.md §5.3).
			if (parsed.stage === 'apply') throw new ValidationError('Prune must be planned first, then applied.');
		}
		definition.authorize(principal, params);
		const orgId = params.scope === 'platform' ? null : principal.orgId;
		if (parsed.stage === 'apply') this.assertNoneApplying(orgId, definition.info.kind);

		if (options.idempotencyKey) {
			const existing = this.ctx.sqlite
				.query<OperationRow, [string, string]>(
					'SELECT * FROM operations WHERE actor_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1',
				)
				.get(principal.userId, options.idempotencyKey);
			if (existing) return this.view(existing);
		}

		const id = newId('op_');
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			`INSERT INTO operations (id, org_id, kind, action, status, stage, params_json, actor_type, actor_id, client_id,
			   principal_json, idempotency_key, created_at)
			 VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				orgId,
				definition.info.kind,
				definition.info.id,
				parsed.stage,
				JSON.stringify(params),
				principal.kind,
				principal.userId,
				principal.clientId ?? principal.keyId ?? null,
				JSON.stringify(storePrincipal(principal)),
				options.idempotencyKey ?? null,
				now,
			],
		);
		this.ctx.audit.record({
			principal,
			orgId: orgId ?? undefined,
			action: 'operation.create',
			resource: 'operation',
			resourceId: id,
			args: { action: definition.info.id, stage: parsed.stage, ...params },
			result: 'ok',
			operationId: id,
		});
		this.kick(id);
		return this.view(this.row(id));
	}

	/** Apply a planned operation. Prune may narrow to some of the planned categories. */
	apply(principal: Principal, id: string, input: { categories?: PruneCategory[] } = {}): OperationView {
		const row = this.requireVisible(principal, id);
		const definition = this.definition(row.action);
		this.checkSurface(principal, definition.info);
		this.assertActor(principal, row);
		if (row.status === 'expired' || (row.status === 'planned' && (row.plan_expires_at ?? 0) < this.ctx.now()))
			throw new ConflictError('This plan has expired. Plan the operation again.');
		if (row.status !== 'planned') throw new ConflictError(`Only a planned operation can be applied (it is ${row.status}).`);
		definition.authorize(principal, this.params(row));
		this.assertNoneApplying(row.org_id, row.kind);

		if (input.categories?.length) {
			const keep = new Set(input.categories.filter((category) => (pruneCategories as readonly string[]).includes(category)));
			// Deselected categories are part of the plan the human saw, but not run.
			this.ctx.sqlite.run(
				`UPDATE operation_items SET status = 'cancelled', reason = COALESCE(reason, 'deselected'), updated_at = ?
				 WHERE operation_id = ? AND status = 'pending' AND category NOT IN (${[...keep].map(() => '?').join(',') || "''"})`,
				[this.ctx.now(), id, ...keep],
			);
		}
		const total = this.count(id, "verdict = 'ok' AND status != 'cancelled'");
		const claimed = this.ctx.sqlite.run(
			"UPDATE operations SET status = 'applying', total = ?, heartbeat_at = ? WHERE id = ? AND status = 'planned'",
			[total, this.ctx.now(), id],
		);
		if (claimed.changes === 0) throw new ConflictError('The operation changed while you were reviewing it.');
		this.ctx.audit.record({
			principal,
			orgId: row.org_id ?? undefined,
			action: 'operation.apply',
			resource: 'operation',
			resourceId: id,
			args: { action: row.action, ...(input.categories ? { categories: input.categories } : {}) },
			result: 'ok',
			operationId: id,
		});
		this.kick(id);
		return this.view(this.row(id));
	}

	/** Stop after the current item. Unstarted items become `cancelled`. */
	cancel(principal: Principal, id: string): OperationView {
		const row = this.requireVisible(principal, id);
		if (row.actor_id !== principal.userId && !principal.permissions.has('project:delete') && !seesPlatform(principal))
			throw new ForbiddenError('project:delete');
		if (isTerminalOperation(row.status)) return this.view(row);
		const now = this.ctx.now();
		if (row.status === 'planned' || (row.status === 'queued' && !this.running.has(id))) {
			this.ctx.sqlite.run(
				"UPDATE operation_items SET status = 'cancelled', updated_at = ? WHERE operation_id = ? AND status = 'pending'",
				[now, id],
			);
			this.ctx.sqlite.run("UPDATE operations SET status = 'cancelled', cancel_requested = 1, finished_at = ? WHERE id = ?", [now, id]);
		} else {
			this.ctx.sqlite.run('UPDATE operations SET cancel_requested = 1 WHERE id = ?', [id]);
		}
		this.ctx.audit.record({
			principal,
			orgId: row.org_id ?? undefined,
			action: 'operation.cancel',
			resource: 'operation',
			resourceId: id,
			result: 'ok',
			operationId: id,
		});
		return this.view(this.row(id));
	}

	// --- reads --------------------------------------------------------------------------

	get(principal: Principal, id: string): OperationView {
		return this.view(this.requireVisible(principal, id));
	}

	items(
		principal: Principal,
		id: string,
		options: { after?: number; limit?: number; status?: ItemStatus; verdict?: ItemVerdict; category?: string } = {},
	): { items: OperationItemView[]; cursor: number; hasMore: boolean } {
		this.requireVisible(principal, id);
		const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
		const filters = ['operation_id = ?', 'seq > ?'];
		const args: Array<string | number> = [id, options.after ?? 0];
		if (options.status) {
			filters.push('status = ?');
			args.push(options.status);
		}
		if (options.verdict) {
			filters.push('verdict = ?');
			args.push(options.verdict);
		}
		if (options.category) {
			filters.push('category = ?');
			args.push(options.category);
		}
		const rows = this.ctx.sqlite
			.query<ItemRow, Array<string | number>>(
				`SELECT * FROM operation_items WHERE ${filters.join(' AND ')} ORDER BY seq LIMIT ?`,
			)
			.all(...args, limit + 1);
		const page = rows.slice(0, limit).map(itemView);
		return { items: page, cursor: page.at(-1)?.seq ?? options.after ?? 0, hasMore: rows.length > limit };
	}

	list(
		principal: Principal,
		options: { kind?: OperationKind; status?: OperationStatus; limit?: number; scope?: PruneScope } = {},
	): OperationView[] {
		if (!principal.permissions.has('project:read')) throw new ForbiddenError('project:read');
		const filters: string[] = [];
		const args: Array<string | number> = [];
		if (options.scope === 'platform') {
			if (!seesPlatform(principal)) throw new ForbiddenError('platform:admin');
			filters.push('org_id IS NULL');
		} else {
			filters.push('org_id = ?');
			args.push(principal.orgId);
		}
		if (options.kind) {
			filters.push('kind = ?');
			args.push(options.kind);
		}
		if (options.status) {
			filters.push('status = ?');
			args.push(options.status);
		}
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		return this.ctx.sqlite
			.query<OperationRow, Array<string | number>>(
				`SELECT * FROM operations WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
			)
			.all(...args, limit)
			.map((row) => this.view(row));
	}

	/**
	 * Progress for one operation until it settles: `progress` whenever counters or status change,
	 * `items` for every item that finished (in `seq` order, resumable via `after`), then `done`.
	 * Backs the SSE endpoint; also stops at `planned` so a reviewer gets the plan.
	 */
	async *events(
		principal: Principal,
		id: string,
		options: { after?: number; signal?: AbortSignal; untilPlanned?: boolean } = {},
	): AsyncGenerator<OperationEvent> {
		this.requireVisible(principal, id);
		let cursor = options.after ?? 0;
		let last = '';
		while (!options.signal?.aborted) {
			const row = this.row(id);
			const operation = this.view(row);
			const fingerprint = `${row.status}:${row.phase}:${row.total}:${row.done}:${row.failed}:${JSON.stringify(operation.summary.statuses)}`;
			if (fingerprint !== last) {
				last = fingerprint;
				yield { type: 'progress', operation };
			}
			for (;;) {
				const page = this.ctx.sqlite
					.query<ItemRow, [string, number]>(
						"SELECT * FROM operation_items WHERE operation_id = ? AND seq > ? AND status != 'pending' ORDER BY seq LIMIT 200",
					)
					.all(id, cursor);
				if (page.length === 0) break;
				// Items finish in seq order. A pending item is a gap the cursor must not jump, or it
				// would never be reported once it runs; skipped verdicts around it wait with it.
				const contiguous: ItemRow[] = [];
				let expected = cursor + 1;
				for (const item of page) {
					if (item.seq !== expected) break;
					contiguous.push(item);
					expected = item.seq + 1;
				}
				if (contiguous.length === 0) break;
				cursor = contiguous.at(-1)!.seq;
				yield { type: 'items', items: contiguous.map(itemView), cursor };
				if (contiguous.length < page.length) break;
			}
			if (isTerminalOperation(row.status) || (options.untilPlanned !== false && row.status === 'planned')) {
				yield { type: 'done', operation };
				return;
			}
			await sleep(POLL_MS, options.signal);
		}
	}

	/** Wait (bounded) until the operation is planned or finished; MCP and scripts use it. */
	async wait(principal: Principal, id: string, timeoutMs: number): Promise<OperationView> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const view = this.get(principal, id);
			if (isTerminalOperation(view.status) || view.status === 'planned' || Date.now() >= deadline) return view;
			const pending = this.running.get(id);
			if (pending) await Promise.race([pending, sleep(Math.min(POLL_MS, Math.max(deadline - Date.now(), 0)))]);
			else await sleep(POLL_MS);
		}
	}

	/** Resolves once this process's run of `id` (if any) has stopped. Tests and shutdown use it. */
	async settled(id: string): Promise<void> {
		while (this.running.has(id)) await this.running.get(id)!.catch(() => undefined);
	}

	// --- maintenance --------------------------------------------------------------------

	/**
	 * Re-claim operations whose runner stopped heartbeating (control-plane restart or crash) and
	 * continue them. Safe to call often: claims are atomic and skip runs this process owns.
	 */
	resume(): string[] {
		const stale = this.ctx.now() - operationLimits.staleHeartbeatMs;
		const rows = this.ctx.sqlite
			.query<{ id: string }, [number]>(
				`SELECT id FROM operations WHERE status IN ('queued','planning','applying')
				 AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
			)
			.all(stale);
		const resumed: string[] = [];
		for (const { id } of rows) {
			if (this.running.has(id)) continue;
			const claimed = this.ctx.sqlite.run(
				`UPDATE operations SET heartbeat_at = ? WHERE id = ? AND status IN ('queued','planning','applying')
				 AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
				[this.ctx.now(), id, stale],
			);
			if (claimed.changes === 0) continue;
			resumed.push(id);
			this.kick(id);
		}
		return resumed;
	}

	/** Expire unapplied plans and drop finished operations past retention. Part of the sweep. */
	expireAndPrune(): { expired: number; removed: number } {
		const now = this.ctx.now();
		const expiring = this.ctx.sqlite
			.query<{ id: string }, [number]>("SELECT id FROM operations WHERE status = 'planned' AND plan_expires_at < ?")
			.all(now);
		for (const { id } of expiring) {
			this.ctx.sqlite.run(
				"UPDATE operation_items SET status = 'cancelled', reason = COALESCE(reason, 'plan_expired'), updated_at = ? WHERE operation_id = ? AND status = 'pending'",
				[now, id],
			);
			this.ctx.sqlite.run("UPDATE operations SET status = 'expired', finished_at = ? WHERE id = ? AND status = 'planned'", [now, id]);
		}
		const cutoff = now - operationLimits.retentionDays * DAY_MS;
		const old = this.ctx.sqlite
			.query<{ id: string }, [number]>(
				"SELECT id FROM operations WHERE status IN ('succeeded','partial','failed','cancelled','expired') AND COALESCE(finished_at, created_at) < ?",
			)
			.all(cutoff);
		if (old.length)
			this.ctx.sqlite.transaction(() => {
				for (const { id } of old) {
					this.ctx.sqlite.run('DELETE FROM operation_items WHERE operation_id = ?', [id]);
					this.ctx.sqlite.run('DELETE FROM operations WHERE id = ?', [id]);
				}
			})();
		this.resume();
		return { expired: expiring.length, removed: old.length };
	}

	// --- runner -------------------------------------------------------------------------

	private kick(id: string): void {
		if (this.running.has(id)) return;
		const run = Promise.resolve()
			.then(() => this.run(id))
			.catch((error) => {
				console.error(`[operations] ${id} failed:`, error);
				const now = this.ctx.now();
				this.ctx.sqlite.run(
					"UPDATE operations SET status = 'failed', phase = ?, finished_at = ? WHERE id = ? AND status IN ('queued','planning','applying')",
					[`Error: ${(error as Error).message}`.slice(0, 500), now, id],
				);
			})
			.finally(() => {
				if (this.running.get(id) === run) this.running.delete(id);
			});
		this.running.set(id, run);
	}

	private async run(id: string): Promise<void> {
		let row = this.row(id);
		const definition = this.definition(row.action);
		const principal = this.rehydrate(row);
		const params = this.params(row);
		let lastBeat = 0;
		const beat = (force = false): void => {
			const now = this.ctx.now();
			if (!force && now - lastBeat < HEARTBEAT_MS) return;
			lastBeat = now;
			this.ctx.sqlite.run('UPDATE operations SET heartbeat_at = ? WHERE id = ?', [now, id]);
		};
		const run: RunContext = {
			ctx: this.ctx,
			principal,
			operationId: id,
			params,
			phase: (label) => {
				this.ctx.sqlite.run('UPDATE operations SET phase = ? WHERE id = ?', [label, id]);
				beat();
			},
			cancelled: () =>
				Boolean(
					this.ctx.sqlite.query<{ c: number }, [string]>('SELECT cancel_requested AS c FROM operations WHERE id = ?').get(id)?.c,
				),
		};

		if (row.status === 'queued' || row.status === 'planning') {
			this.ctx.sqlite.run("UPDATE operations SET status = 'planning', started_at = COALESCE(started_at, ?), heartbeat_at = ? WHERE id = ?", [
				this.ctx.now(),
				this.ctx.now(),
				id,
			]);
			// Planning never mutates, so a resumed plan simply starts over.
			this.ctx.sqlite.run('DELETE FROM operation_items WHERE operation_id = ?', [id]);
			let seq = 0;
			let batch: PlannedItem[] = [];
			const flush = (): void => {
				if (!batch.length) return;
				const items = batch;
				batch = [];
				this.ctx.sqlite.transaction(() => {
					for (const item of items) {
						seq += 1;
						this.ctx.sqlite.run(
							`INSERT INTO operation_items (operation_id, seq, category, target_kind, target_id, label, verdict, reason,
							   flags_json, status, bytes, data_json, updated_at)
							 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							[
								id,
								seq,
								item.category ?? null,
								item.targetKind,
								item.targetId,
								item.label ?? null,
								item.verdict,
								item.reason ?? null,
								item.flags?.length ? JSON.stringify(item.flags) : null,
								item.verdict === 'ok' ? 'pending' : 'skipped',
								item.bytes ?? null,
								item.data ? JSON.stringify(item.data) : null,
								this.ctx.now(),
							],
						);
					}
				})();
				this.ctx.sqlite.run('UPDATE operations SET total = ? WHERE id = ?', [this.count(id, "verdict = 'ok'"), id]);
				beat();
			};
			for await (const item of definition.plan(run)) {
				batch.push(item);
				if (batch.length >= PLAN_CHUNK) flush();
				if (run.cancelled()) break;
			}
			flush();
			if (run.cancelled()) return this.finish(id, definition, run, 'cancelled');
			const total = this.count(id, "verdict = 'ok'");
			if (row.stage === 'plan') {
				this.ctx.sqlite.run(
					"UPDATE operations SET status = 'planned', phase = NULL, total = ?, plan_expires_at = ?, heartbeat_at = ? WHERE id = ? AND status = 'planning'",
					[total, this.ctx.now() + operationLimits.planTtlMs, this.ctx.now(), id],
				);
				return;
			}
			this.ctx.sqlite.run("UPDATE operations SET status = 'applying', total = ? WHERE id = ? AND status = 'planning'", [total, id]);
			row = this.row(id);
		}

		if (row.status !== 'applying') return;
		this.ctx.sqlite.run('UPDATE operations SET started_at = COALESCE(started_at, ?) WHERE id = ?', [this.ctx.now(), id]);
		beat(true);
		let currentCategory: string | null = null;
		for (;;) {
			if (run.cancelled()) return this.finish(id, definition, run, 'cancelled');
			const next = this.ctx.sqlite
				.query<ItemRow, [string]>(
					"SELECT * FROM operation_items WHERE operation_id = ? AND status = 'pending' AND verdict = 'ok' ORDER BY seq LIMIT 1",
				)
				.get(id);
			if (!next) break;
			if (next.category !== currentCategory) {
				currentCategory = next.category;
				if (currentCategory) run.phase(currentCategory);
			}
			let result: ItemResult;
			try {
				result = await definition.apply(run, storedItem(next));
			} catch (error) {
				result = { status: 'failed' as const, error: error instanceof Error ? error.message : String(error) };
			}
			this.ctx.sqlite.transaction(() => {
				this.ctx.sqlite.run(
					'UPDATE operation_items SET status = ?, error = ?, reason = COALESCE(?, reason), bytes = COALESCE(?, bytes), updated_at = ? WHERE operation_id = ? AND seq = ?',
					[
						result.status,
						result.status === 'failed' ? result.error.slice(0, 1000) : null,
						result.status === 'skipped' ? result.reason : null,
						result.status === 'succeeded' ? (result.bytes ?? null) : null,
						this.ctx.now(),
						id,
						next.seq,
					],
				);
				this.ctx.sqlite.run(
					`UPDATE operations SET done = done + 1, failed = failed + ? WHERE id = ?`,
					[result.status === 'failed' ? 1 : 0, id],
				);
			})();
			beat();
		}
		return this.finish(id, definition, run, null);
	}

	private async finish(
		id: string,
		definition: ActionDefinition,
		run: RunContext,
		forced: 'cancelled' | null,
	): Promise<void> {
		const now = this.ctx.now();
		if (forced === 'cancelled')
			this.ctx.sqlite.run(
				"UPDATE operation_items SET status = 'cancelled', updated_at = ? WHERE operation_id = ? AND status = 'pending'",
				[now, id],
			);
		try {
			await definition.finish?.(run);
		} catch (error) {
			console.error(`[operations] ${id} finish hook failed:`, error);
		}
		const succeeded = this.count(id, "status = 'succeeded'");
		const failed = this.count(id, "status = 'failed'");
		const status: OperationStatus =
			forced ?? (failed === 0 ? 'succeeded' : succeeded > 0 ? 'partial' : 'failed');
		const row = this.row(id);
		const summary = this.summarize(id);
		this.ctx.sqlite.run(
			'UPDATE operations SET status = ?, phase = NULL, summary_json = ?, finished_at = ?, heartbeat_at = ? WHERE id = ?',
			[status, JSON.stringify(summary), now, now, id],
		);
		this.ctx.audit.record({
			principal: run.principal,
			orgId: row.org_id ?? undefined,
			action: 'operation.finish',
			resource: 'operation',
			resourceId: id,
			args: { action: row.action, status, succeeded, failed, freedBytes: summary.freedBytes },
			result: status === 'failed' ? 'error' : 'ok',
			operationId: id,
		});
	}

	// --- helpers ------------------------------------------------------------------------

	private definition(action: string): ActionDefinition {
		const definition = this.definitions.get(action as OperationActionId);
		if (!definition) throw new ValidationError(`Unknown operation action "${action}".`);
		return definition;
	}

	/** Surface rules: irreversible actions are never available to MCP (D29, docs/OPERATIONS.md D53). */
	private checkSurface(principal: Principal, info: OperationActionInfo): void {
		if (principal.kind === 'mcp' && !info.surfaces.mcp)
			throw new CoreError('surface_not_allowed', `${info.label} is not available to MCP clients. Use the dashboard or CLI.`, 403);
		if (principal.kind === 'apiKey' && !info.surfaces.apiKey)
			throw new CoreError('surface_not_allowed', `${info.label} needs a dashboard session.`, 403);
	}

	private assertActor(principal: Principal, row: OperationRow): void {
		if (row.actor_id !== principal.userId)
			throw new ForbiddenError('operation:apply (only the person who planned it can apply it)');
	}

	private assertNoneApplying(orgId: string | null, kind: OperationKind): void {
		const busy = this.ctx.sqlite
			.query<{ id: string }, [string, string | null, string | null]>(
				`SELECT id FROM operations WHERE kind = ? AND status = 'applying'
				 AND ((org_id IS NULL AND ? IS NULL) OR org_id = ?) LIMIT 1`,
			)
			.get(kind, orgId, orgId);
		if (busy) throw new ConflictError(`Another ${kind} operation (${busy.id}) is already running. Wait for it or cancel it.`);
	}

	private row(id: string): OperationRow {
		const row = this.ctx.sqlite.query<OperationRow, [string]>('SELECT * FROM operations WHERE id = ?').get(id);
		if (!row) throw new NotFoundError('Operation');
		return row;
	}

	private requireVisible(principal: Principal, id: string): OperationRow {
		const row = this.ctx.sqlite.query<OperationRow, [string]>('SELECT * FROM operations WHERE id = ?').get(id);
		if (!row) throw new NotFoundError('Operation');
		const visible = row.org_id === null ? seesPlatform(principal) : row.org_id === principal.orgId;
		if (!visible) throw new NotFoundError('Operation');
		if (row.actor_id !== principal.userId && !principal.permissions.has('project:read')) throw new ForbiddenError('project:read');
		return row;
	}

	private params(row: OperationRow): OperationParams {
		return row.params_json ? (JSON.parse(row.params_json) as OperationParams) : {};
	}

	private count(id: string, where: string): number {
		return (
			this.ctx.sqlite
				.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM operation_items WHERE operation_id = ? AND ${where}`)
				.get(id)?.n ?? 0
		);
	}

	/**
	 * The principal a run executes as. Permissions are the ones it had when created, capped by the
	 * actor's *current* org role, so revoking a role mid-run narrows what a resumed run may do.
	 */
	private rehydrate(row: OperationRow): Principal {
		const stored = JSON.parse(row.principal_json) as StoredPrincipal;
		const membership = readMembership(this.ctx.sqlite, stored.userId);
		const hasMembers = Boolean(
			this.ctx.sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'member'").get(),
		);
		if (hasMembers && stored.kind !== 'system' && (!membership || membership.orgId !== stored.orgId))
			throw new ForbiddenError('project:read (the actor is no longer a member of this org)');
		return buildPrincipal({
			kind: stored.kind,
			userId: stored.userId,
			orgId: stored.orgId,
			role: membership?.role ?? stored.role,
			granted: stored.permissions,
			clientId: stored.clientId,
			keyId: stored.keyId,
			platformAdmin: stored.platformAdmin,
		});
	}

	private summarize(id: string): OperationSummary {
		const verdicts = Object.fromEntries(itemVerdicts.map((verdict) => [verdict, 0])) as OperationSummary['verdicts'];
		const statuses = Object.fromEntries(itemStatuses.map((status) => [status, 0])) as OperationSummary['statuses'];
		const flags: OperationSummary['flags'] = {};
		const categories: NonNullable<OperationSummary['categories']> = {};
		let freedBytes = 0;
		const rows = this.ctx.sqlite
			.query<{ category: string | null; verdict: ItemVerdict; status: ItemStatus; n: number; bytes: number | null }, [string]>(
				`SELECT category, verdict, status, COUNT(*) AS n, SUM(bytes) AS bytes FROM operation_items
				 WHERE operation_id = ? GROUP BY category, verdict, status`,
			)
			.all(id);
		for (const row of rows) {
			verdicts[row.verdict] += row.n;
			statuses[row.status] += row.n;
			if (row.status === 'succeeded') freedBytes += row.bytes ?? 0;
			if (row.category) {
				const entry = (categories[row.category as PruneCategory] ??= { planned: 0, bytes: 0, succeeded: 0, failed: 0, skipped: 0 });
				if (row.verdict === 'ok') {
					entry.planned += row.n;
					entry.bytes += row.bytes ?? 0;
				}
				if (row.status === 'succeeded') entry.succeeded += row.n;
				if (row.status === 'failed') entry.failed += row.n;
				if (row.status === 'skipped' && row.verdict === 'ok') entry.skipped += row.n;
			}
		}
		const flagRows = this.ctx.sqlite
			.query<{ flags_json: string }, [string]>(
				"SELECT flags_json FROM operation_items WHERE operation_id = ? AND flags_json IS NOT NULL AND verdict = 'ok'",
			)
			.all(id);
		for (const { flags_json } of flagRows)
			for (const flag of JSON.parse(flags_json) as ItemFlag[]) flags[flag] = (flags[flag] ?? 0) + 1;
		return { verdicts, statuses, flags, ...(Object.keys(categories).length ? { categories } : {}), freedBytes };
	}

	private view(row: OperationRow): OperationView {
		const summary =
			isTerminalOperation(row.status) && row.summary_json
				? (JSON.parse(row.summary_json) as OperationSummary)
				: this.summarize(row.id);
		const iso = (value: number | null) => (value ? new Date(value).toISOString() : null);
		return {
			id: row.id,
			kind: row.kind,
			action: row.action,
			status: row.status,
			scope: row.kind === 'prune' ? (this.params(row).scope ?? 'org') : null,
			phase: row.phase,
			total: row.total,
			done: row.done,
			failed: row.failed,
			summary,
			actor: { type: row.actor_type, id: row.actor_id, clientId: row.client_id },
			params: this.params(row),
			createdAt: new Date(row.created_at).toISOString(),
			startedAt: iso(row.started_at),
			finishedAt: iso(row.finished_at),
			planExpiresAt: row.status === 'planned' ? iso(row.plan_expires_at) : null,
		};
	}
}

function storePrincipal(principal: Principal): StoredPrincipal {
	return {
		kind: principal.kind,
		userId: principal.userId,
		orgId: principal.orgId,
		role: principal.role,
		permissions: [...principal.permissions],
		...(principal.clientId ? { clientId: principal.clientId } : {}),
		...(principal.keyId ? { keyId: principal.keyId } : {}),
		...(principal.platformAdmin ? { platformAdmin: true } : {}),
	};
}

function storedItem(row: ItemRow): StoredItem {
	return {
		seq: row.seq,
		category: (row.category ?? undefined) as PruneCategory | undefined,
		targetKind: row.target_kind,
		targetId: row.target_id,
		label: row.label ?? undefined,
		verdict: row.verdict,
		reason: row.reason ?? undefined,
		flags: row.flags_json ? (JSON.parse(row.flags_json) as ItemFlag[]) : [],
		bytes: row.bytes ?? undefined,
		data: row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : undefined,
	};
}

function itemView(row: ItemRow): OperationItemView {
	return {
		seq: row.seq,
		category: (row.category ?? null) as PruneCategory | null,
		targetKind: row.target_kind,
		targetId: row.target_id,
		label: row.label,
		verdict: row.verdict,
		reason: row.reason,
		flags: row.flags_json ? (JSON.parse(row.flags_json) as ItemFlag[]) : [],
		status: row.status,
		error: row.error,
		bytes: row.bytes,
	};
}
