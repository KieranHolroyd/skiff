/**
 * Blueprint helpers for `yoal blueprint` (plan 11): finding the file and rendering plans and
 * runs. The server parses and validates the document (YAML or JSON), so the CLI only reads the
 * text and sends it; these shapes mirror `@yoal/contracts`' blueprint views.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderTable, truncate } from './output.ts';

/** Mirrors `BLUEPRINT_FILE_NAMES` in @yoal/contracts: looked for in order when no path is given. */
export const BLUEPRINT_FILE_NAMES = ['yoal.blueprint.yaml', 'yoal.blueprint.yml', 'yoal.blueprint.json'] as const;

/** Mirrors `BLUEPRINT_MAX_BYTES`. The server enforces it; this only fails faster. */
export const BLUEPRINT_MAX_BYTES = 512 * 1024;

export type BlueprintPlanAction = 'create' | 'update' | 'delete' | 'noop';

export interface BlueprintChange {
	path: string;
	from: string | null;
	to: string | null;
}

export interface BlueprintResourceDiff {
	key: string;
	kind: string;
	action: BlueprintPlanAction;
	changes: BlueprintChange[];
	reason: string | null;
}

export interface BlueprintPlanView {
	planHash: string;
	stack: string;
	stackAction: 'create' | 'update' | 'noop';
	operationId: string;
	prune: boolean;
	resources: BlueprintResourceDiff[];
	summary: Record<BlueprintPlanAction, number>;
	warnings: string[];
	generatedAt: string;
	expiresAt: string | null;
}

export interface BlueprintAppliedResource {
	key: string;
	kind: string;
	action: BlueprintPlanAction;
	status: 'pending' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';
	reason: string | null;
	error: string | null;
}

export interface BlueprintRunView {
	operationId: string;
	planHash: string;
	stack: string;
	status: string;
	done: number;
	total: number;
	resources: BlueprintAppliedResource[];
	error: string | null;
	appliedAt: string | null;
}

export interface BlueprintValidation {
	stack: string;
	document: unknown;
	resources: Record<string, number>;
}

/** The blueprint file to use: the given path, or the first default name in `cwd`. */
export function findBlueprintFile(given: string | undefined, cwd: string, exists: (path: string) => boolean = existsSync): string | null {
	if (given) return given;
	for (const name of BLUEPRINT_FILE_NAMES) {
		const path = join(cwd, name);
		if (exists(path)) return path;
	}
	return null;
}

const SIGN: Record<BlueprintPlanAction, string> = { create: '+', update: '~', delete: '-', noop: '=' };

/** One line per resource and one indented line per changed field; up-to-date ones only with `all`. */
export function planLines(plan: Pick<BlueprintPlanView, 'resources'>, options: { all?: boolean } = {}): string[] {
	const lines: string[] = [];
	for (const resource of plan.resources) {
		if (resource.action === 'noop' && !options.all) continue;
		const reason = resource.reason && resource.action !== 'noop' ? `  (${resource.reason})` : '';
		lines.push(`${SIGN[resource.action]} ${resource.action.padEnd(6)} ${resource.key}${reason}`);
		for (const change of resource.changes)
			lines.push(`      ${change.path}: ${truncate(change.from ?? '-', 60)} → ${truncate(change.to ?? '-', 60)}`);
	}
	return lines;
}

/** `Stack "shop": 3 to create, 1 to update, 8 up to date.` */
export function planSummary(plan: Pick<BlueprintPlanView, 'stack' | 'summary'>): string {
	const parts: string[] = [];
	if (plan.summary.create) parts.push(`${plan.summary.create} to create`);
	if (plan.summary.update) parts.push(`${plan.summary.update} to update`);
	if (plan.summary.delete) parts.push(`${plan.summary.delete} to delete`);
	if (plan.summary.noop) parts.push(`${plan.summary.noop} up to date`);
	return `Stack "${plan.stack}": ${parts.length ? parts.join(', ') : 'nothing declared'}.`;
}

export const hasChanges = (plan: Pick<BlueprintPlanView, 'summary'>): boolean =>
	plan.summary.create + plan.summary.update + plan.summary.delete > 0;

/** Per-resource results of a run, failures and skips with their reason. */
export function runTable(run: Pick<BlueprintRunView, 'resources'>): string {
	const rows = run.resources.map((resource) => [
		resource.key,
		resource.action,
		resource.status,
		truncate(resource.error ?? resource.reason ?? '-', 80),
	]);
	return renderTable(['RESOURCE', 'ACTION', 'RESULT', 'DETAIL'], rows);
}

/** `Applied: 4 succeeded, 8 up to date.` or the failure that stopped the run. */
export function runOutcome(run: Pick<BlueprintRunView, 'status' | 'resources' | 'error'>): string {
	const count = (status: BlueprintAppliedResource['status']) => run.resources.filter((resource) => resource.status === status).length;
	const upToDate = run.resources.filter((resource) => resource.status === 'skipped' && resource.reason === 'up to date').length;
	const skipped = count('skipped') - upToDate;
	const parts = [`${count('succeeded')} succeeded`];
	if (count('failed')) parts.push(`${count('failed')} failed`);
	if (skipped) parts.push(`${skipped} skipped`);
	if (upToDate) parts.push(`${upToDate} up to date`);
	const label = run.status === 'succeeded' ? 'Applied' : run.status.charAt(0).toUpperCase() + run.status.slice(1);
	return `${label}: ${parts.join(', ')}.${run.error ? `\nStopped at ${run.error}` : ''}`;
}

/** Issues from a 422 response body (`{ issues: [{ path, message }] }`), one per line. */
export function issueLines(body: unknown): string[] {
	const issues = (body as { issues?: Array<{ path?: unknown; message?: unknown }> } | null)?.issues;
	if (!Array.isArray(issues)) return [];
	return issues.map((issue) => {
		const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : '';
		return `  ${path ? `${path}: ` : ''}${String(issue.message ?? '')}`;
	});
}
