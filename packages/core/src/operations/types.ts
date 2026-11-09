import type {
	ItemFlag,
	ItemVerdict,
	OperationActionInfo,
	Principal,
	PruneCategory,
	PruneScope,
} from '@skiff/contracts';
import type { BlueprintOperationParams } from '../blueprints.ts';
import type { CoreContext } from '../context.ts';

/** Parameters stored with an operation (`params_json`). */
export interface OperationParams {
	targets?: string[];
	scope?: PruneScope;
	categories?: PruneCategory[];
	/** Prune: override the retention window for every selected category. */
	olderThanDays?: number;
	/** Prune: keep at least this many newest tags per registry repository. */
	keepTags?: number;
	/**
	 * `blueprint.apply` only: the normalised document and the plan it produced. Internal: set by
	 * the blueprint service, never accepted from `POST /operations`, never shown in a view.
	 */
	blueprint?: BlueprintOperationParams;
}

/** What `OperationService.apply` passes to an action's `beforeApply` hook. */
export interface OperationApplyInput {
	categories?: PruneCategory[];
	/** The stack name typed back to confirm a pruning blueprint plan. */
	confirm?: string;
}

/** One item a plan produced. `data` is whatever `apply` needs, stored as JSON. */
export interface PlannedItem {
	category?: PruneCategory;
	targetKind: string;
	targetId: string;
	label?: string;
	verdict: ItemVerdict;
	reason?: string;
	flags?: ItemFlag[];
	bytes?: number;
	data?: Record<string, unknown>;
}

export interface StoredItem extends PlannedItem {
	seq: number;
}

export type ItemResult =
	| { status: 'succeeded'; bytes?: number }
	| { status: 'skipped'; reason: string }
	| { status: 'failed'; error: string };

export interface RunContext {
	ctx: CoreContext;
	principal: Principal;
	operationId: string;
	params: OperationParams;
	/** Report the step a long plan is on ("Scanning releases"). */
	phase(label: string): void;
	/** True once the operation was asked to stop. Long scans should check it. */
	cancelled(): boolean;
}

/**
 * One registered mass action (docs/OPERATIONS.md §2.4). Bulk actions and prune both implement it,
 * so new mass actions need no new routes, tables or UI plumbing.
 */
export interface ActionDefinition {
	info: OperationActionInfo;
	/** Throw if the principal may not run this action with these params at all. */
	authorize(principal: Principal, params: OperationParams): void;
	/** Never mutates. Yields a verdict per item. */
	plan(run: RunContext): AsyncIterable<PlannedItem>;
	/** Idempotent; re-verifies the item still qualifies before changing anything. */
	apply(run: RunContext, item: StoredItem): Promise<ItemResult>;
	/**
	 * Optional check when a reviewed plan is applied, after `authorize` and before the run is
	 * claimed. Throw to refuse (a blueprint whose live state moved since the plan, a prune that was
	 * not typed back). Never mutates.
	 */
	beforeApply?(ctx: CoreContext, principal: Principal, params: OperationParams, input: OperationApplyInput): void;
	/** Optional hook after the last item (e.g. one desired-state bump, a GC pass). */
	finish?(run: RunContext): Promise<void>;
}
