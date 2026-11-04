import type {
	ItemFlag,
	ItemVerdict,
	OperationActionInfo,
	Principal,
	PruneCategory,
	PruneScope,
} from '@skiff/contracts';
import type { CoreContext } from '../context.ts';

/** Parameters stored with an operation (`params_json`). */
export interface OperationParams {
	targets?: string[];
	scope?: PruneScope;
	categories?: PruneCategory[];
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
	/** Optional hook after the last item (e.g. one desired-state bump, a GC pass). */
	finish?(run: RunContext): Promise<void>;
}
