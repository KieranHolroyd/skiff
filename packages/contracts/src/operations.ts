import * as z from 'zod';
import type { Permission } from './permissions.ts';

/**
 * Operations: server-side mass actions and prune runs (docs/OPERATIONS.md). Every surface
 * (dashboard, REST, CLI, MCP) reads this metadata, so a new action only needs a core definition
 * plus an entry here.
 */

export const operationLimits = {
	/** Targets per bulk operation from the dashboard, REST and CLI. */
	bulkTargets: 100,
	/** Targets per bulk operation from MCP (agents confirm a list a human can actually read). */
	mcpTargets: 25,
	/** A plan must be applied within this window or scanned again. */
	planTtlMs: 60 * 60 * 1000,
	/** Prune never touches anything younger than this (in-flight uploads, finalize, GC races). */
	pruneGraceMs: 24 * 60 * 60 * 1000,
	/** Finished operations are kept this long for history, then removed by maintenance. */
	retentionDays: 90,
	/** A runner that stops heartbeating for this long is presumed dead and its run is resumed. */
	staleHeartbeatMs: 60 * 1000,
} as const;

export const operationKinds = ['bulk', 'prune'] as const;
export type OperationKind = (typeof operationKinds)[number];

export const operationStatuses = [
	'queued',
	'planning',
	'planned',
	'applying',
	'succeeded',
	'partial',
	'failed',
	'cancelled',
	'expired',
] as const;
export type OperationStatus = (typeof operationStatuses)[number];

export const terminalOperationStatuses: readonly OperationStatus[] = [
	'succeeded',
	'partial',
	'failed',
	'cancelled',
	'expired',
];
export const isTerminalOperation = (status: string): boolean =>
	(terminalOperationStatuses as readonly string[]).includes(status);

export const itemVerdicts = ['ok', 'skip', 'blocked'] as const;
export type ItemVerdict = (typeof itemVerdicts)[number];

export const itemStatuses = ['pending', 'succeeded', 'skipped', 'failed', 'cancelled'] as const;
export type ItemStatus = (typeof itemStatuses)[number];

/** Flags a plan attaches to an item so confirmations can warn about consequences. */
export const itemFlags = ['live', 'workload', 'custom_domain'] as const;
export type ItemFlag = (typeof itemFlags)[number];

export const pruneCategories = [
	'project_rows',
	'domains',
	'workload_reservations',
	'share_redemptions',
	'deployments',
	'upload_sessions',
	'config_snapshots',
	'releases',
	'objects',
] as const;
export type PruneCategory = (typeof pruneCategories)[number];

export const pruneScopes = ['org', 'platform'] as const;
export type PruneScope = (typeof pruneScopes)[number];

export interface PruneCategoryInfo {
	id: PruneCategory;
	label: string;
	description: string;
	/** `platform` categories only run in a platform-scope prune. */
	scope: PruneScope;
}

/** Ordered children before parents, rows before the objects they point at. */
export const pruneCategoryInfo: readonly PruneCategoryInfo[] = [
	{
		id: 'project_rows',
		label: 'Project leftovers',
		description: 'Environments, workloads, builds, git sources, logs, share links, redirects and secrets of projects that no longer exist.',
		scope: 'org',
	},
	{
		id: 'domains',
		label: 'Orphaned domains',
		description: 'Custom domains whose project is gone, including their managed Cloudflare records.',
		scope: 'org',
	},
	{
		id: 'workload_reservations',
		label: 'Stale workload reservations',
		description: 'Workloads of deleted projects still holding node memory budget.',
		scope: 'org',
	},
	{
		id: 'share_redemptions',
		label: 'Share link redemptions',
		description: 'Redemptions of share links that are gone, or that expired more than 30 days ago.',
		scope: 'org',
	},
	{
		id: 'deployments',
		label: 'Deleted deployments',
		description: 'Deployments deleted more than 30 days ago.',
		scope: 'org',
	},
	{
		id: 'upload_sessions',
		label: 'Abandoned uploads',
		description: 'Expired or failed upload sessions older than a day.',
		scope: 'org',
	},
	{
		id: 'config_snapshots',
		label: 'Config snapshots',
		description: 'Config snapshots no deployment references.',
		scope: 'org',
	},
	{
		id: 'releases',
		label: 'Unused releases',
		description: 'Releases no live deployment references, and their stored artifacts.',
		scope: 'org',
	},
	{
		id: 'objects',
		label: 'Unreferenced objects',
		description: 'Stored artifacts and uploads with no release or upload record (shared across orgs).',
		scope: 'platform',
	},
];

export const bulkActionIds = ['project.delete', 'project.restore', 'project.purge'] as const;
export type BulkActionId = (typeof bulkActionIds)[number];
export const operationActionIds = [...bulkActionIds, 'prune'] as const;
export type OperationActionId = (typeof operationActionIds)[number];

export interface OperationActionInfo {
	id: OperationActionId;
	kind: OperationKind;
	label: string;
	/** Short verb for buttons ("Delete", "Restore"). */
	verb: string;
	permission: Permission | 'platform:admin';
	destructive: boolean;
	reversible: boolean;
	/** Which list the action applies to in the dashboard. */
	appliesTo: 'projects' | 'trash' | 'none';
	surfaces: { mcp: boolean; apiKey: boolean };
}

export const operationActions: Record<OperationActionId, OperationActionInfo> = {
	'project.delete': {
		id: 'project.delete',
		kind: 'bulk',
		label: 'Move projects to the trash',
		verb: 'Delete',
		permission: 'project:delete',
		destructive: true,
		reversible: true,
		appliesTo: 'projects',
		surfaces: { mcp: true, apiKey: true },
	},
	'project.restore': {
		id: 'project.restore',
		kind: 'bulk',
		label: 'Restore projects from the trash',
		verb: 'Restore',
		permission: 'project:update',
		destructive: false,
		reversible: true,
		appliesTo: 'trash',
		surfaces: { mcp: true, apiKey: true },
	},
	'project.purge': {
		id: 'project.purge',
		kind: 'bulk',
		label: 'Permanently delete projects in the trash',
		verb: 'Delete permanently',
		permission: 'project:delete',
		destructive: true,
		reversible: false,
		appliesTo: 'trash',
		// Irreversible: humans only (D29).
		surfaces: { mcp: false, apiKey: true },
	},
	prune: {
		id: 'prune',
		kind: 'prune',
		label: 'Prune orphaned data',
		verb: 'Prune',
		permission: 'project:delete',
		destructive: true,
		reversible: false,
		appliesTo: 'none',
		surfaces: { mcp: false, apiKey: true },
	},
};

export const isOperationAction = (value: string): value is OperationActionId =>
	(operationActionIds as readonly string[]).includes(value);

export const operationCreateSchema = z.object({
	action: z.enum(operationActionIds),
	/** Explicit target list (slugs) for bulk actions. The server never resolves filters (D50). */
	targets: z.array(z.string().min(1).max(64)).max(operationLimits.bulkTargets).optional(),
	/** Prune parameters. */
	scope: z.enum(pruneScopes).optional(),
	categories: z.array(z.enum(pruneCategories)).optional(),
	/** `plan` stops at `planned` for review; `apply` runs straight through (bulk only). */
	stage: z.enum(['plan', 'apply']).default('plan'),
});
export type OperationCreate = z.input<typeof operationCreateSchema>;

export const operationApplySchema = z.object({
	/** Prune: only apply these planned categories. */
	categories: z.array(z.enum(pruneCategories)).optional(),
});

export interface OperationSummary {
	verdicts: Record<ItemVerdict, number>;
	statuses: Record<ItemStatus, number>;
	/** Items flagged with consequences, by flag. */
	flags: Partial<Record<ItemFlag, number>>;
	/** Prune: per-category planned items, bytes and results. */
	categories?: Partial<
		Record<PruneCategory, { planned: number; bytes: number; succeeded: number; failed: number; skipped: number }>
	>;
	freedBytes: number;
}

export interface OperationView {
	id: string;
	kind: OperationKind;
	action: OperationActionId;
	status: OperationStatus;
	scope: PruneScope | null;
	phase: string | null;
	total: number;
	done: number;
	failed: number;
	summary: OperationSummary;
	actor: { type: string; id: string | null; clientId: string | null };
	params: { targets?: string[]; scope?: PruneScope; categories?: PruneCategory[] };
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	planExpiresAt: string | null;
}

export interface OperationItemView {
	seq: number;
	category: PruneCategory | null;
	targetKind: string;
	targetId: string;
	label: string | null;
	verdict: ItemVerdict;
	reason: string | null;
	flags: ItemFlag[];
	status: ItemStatus;
	error: string | null;
	bytes: number | null;
}

/** Server-sent progress events (`GET /operations/:id/stream`). */
export type OperationEvent =
	| { type: 'progress'; operation: OperationView }
	| { type: 'items'; items: OperationItemView[]; cursor: number }
	| { type: 'done'; operation: OperationView };
