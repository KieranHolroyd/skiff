import {
	hasPermission,
	operationActions,
	type BulkActionId,
	type ItemFlag,
	type Permission,
	type Principal,
} from '@skiff/contracts';
import { ForbiddenError } from '../errors.ts';
import type { ProjectRow } from '../projects.ts';
import type { ActionDefinition, ItemResult, PlannedItem, RunContext, StoredItem } from './types.ts';

/** Bulk project actions (docs/OPERATIONS.md §3). Targets are slugs or project ids, never filters. */
export function projectActions(): ActionDefinition[] {
	return [deleteAction, restoreAction, purgeAction];
}

function lookup(run: RunContext, target: string): ProjectRow | undefined {
	const row = run.ctx.sqlite
		.query<Record<string, unknown>, [string, string, string]>(
			'SELECT * FROM projects WHERE org_id = ? AND (slug = ? OR id = ?) LIMIT 1',
		)
		.get(run.principal.orgId, target, target);
	return row ? toRow(row) : undefined;
}

function byId(run: RunContext, id: string): ProjectRow | undefined {
	const row = run.ctx.sqlite
		.query<Record<string, unknown>, [string, string]>('SELECT * FROM projects WHERE org_id = ? AND id = ?')
		.get(run.principal.orgId, id);
	return row ? toRow(row) : undefined;
}

function toRow(raw: Record<string, unknown>): ProjectRow {
	return {
		id: raw.id as string,
		orgId: raw.org_id as string,
		slug: raw.slug as string,
		name: raw.name as string,
		runtime: raw.runtime as ProjectRow['runtime'],
		placement: raw.placement as string,
		productionDeploymentId: (raw.production_deployment_id as string | null) ?? null,
		productionAccess: raw.production_access as ProjectRow['productionAccess'],
		previewAccess: raw.preview_access as ProjectRow['previewAccess'],
		accessSecretHash: (raw.access_secret_hash as string | null) ?? null,
		workloadJson: (raw.workload_json as string | null) ?? null,
		createdBy: raw.created_by as string,
		deletedAt: (raw.deleted_at as number | null) ?? null,
		purgeAt: (raw.purge_at as number | null) ?? null,
		createdAt: raw.created_at as number,
		updatedAt: raw.updated_at as number,
	};
}

function flagsFor(run: RunContext, project: ProjectRow): ItemFlag[] {
	const flags: ItemFlag[] = [];
	if (project.productionDeploymentId) flags.push('live');
	if (project.runtime !== 'static') flags.push('workload');
	const domains = run.ctx.sqlite
		.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM domains WHERE project_id = ?')
		.get(project.id)?.n;
	if (domains) flags.push('custom_domain');
	return flags;
}

/** Shared plan: resolve every target, then let the action decide each verdict. */
async function* planTargets(
	run: RunContext,
	permission: Permission,
	decide: (project: ProjectRow) => Omit<PlannedItem, 'targetKind' | 'targetId' | 'label'>,
): AsyncIterable<PlannedItem> {
	const seen = new Set<string>();
	for (const target of run.params.targets ?? []) {
		const project = lookup(run, target);
		if (!project) {
			yield { targetKind: 'project', targetId: target, label: target, verdict: 'skip', reason: 'not_found' };
			continue;
		}
		if (seen.has(project.id)) continue;
		seen.add(project.id);
		const base = { targetKind: 'project', targetId: project.id, label: project.slug };
		if (!hasPermission(run.principal, permission)) {
			yield { ...base, verdict: 'blocked', reason: 'forbidden' };
			continue;
		}
		yield { ...base, ...decide(project) };
	}
}

function requireFor(principal: Principal, permission: Permission): void {
	if (!hasPermission(principal, permission)) throw new ForbiddenError(permission);
}

const failed = (error: unknown): ItemResult => ({
	status: 'failed',
	error: error instanceof Error ? error.message : String(error),
});

function bumpOnce(run: RunContext): Promise<void> {
	run.ctx.projects.bump(run.principal.orgId);
	return Promise.resolve();
}

const deleteAction: ActionDefinition = {
	info: operationActions['project.delete'],
	authorize: (principal) => requireFor(principal, 'project:delete'),
	plan: (run) =>
		planTargets(run, 'project:delete', (project) =>
			project.deletedAt
				? { verdict: 'skip', reason: 'already_in_trash' }
				: { verdict: 'ok', flags: flagsFor(run, project) },
		),
	async apply(run: RunContext, item: StoredItem): Promise<ItemResult> {
		const project = byId(run, item.targetId);
		if (!project) return { status: 'skipped', reason: 'not_found' };
		if (project.deletedAt) return { status: 'skipped', reason: 'already_in_trash' };
		try {
			await run.ctx.projects.softDelete(run.principal, project.slug, { operationId: run.operationId });
			return { status: 'succeeded' };
		} catch (error) {
			return failed(error);
		}
	},
	finish: bumpOnce,
};

const restoreAction: ActionDefinition = {
	info: operationActions['project.restore'],
	authorize: (principal) => requireFor(principal, 'project:update'),
	plan: (run) =>
		planTargets(run, 'project:update', (project) =>
			project.deletedAt ? { verdict: 'ok', flags: flagsFor(run, project) } : { verdict: 'skip', reason: 'not_in_trash' },
		),
	async apply(run: RunContext, item: StoredItem): Promise<ItemResult> {
		const project = byId(run, item.targetId);
		if (!project) return { status: 'skipped', reason: 'not_found' };
		if (!project.deletedAt) return { status: 'skipped', reason: 'not_in_trash' };
		try {
			await run.ctx.projects.restore(run.principal, project.slug, { operationId: run.operationId });
			return { status: 'succeeded' };
		} catch (error) {
			return failed(error);
		}
	},
	finish: bumpOnce,
};

const purgeAction: ActionDefinition = {
	info: operationActions['project.purge'],
	authorize: (principal) => requireFor(principal, 'project:delete'),
	plan: (run) =>
		planTargets(run, 'project:delete', (project) =>
			// Irreversible, so a live project is blocked rather than deleted and purged in one go.
			project.deletedAt ? { verdict: 'ok', flags: flagsFor(run, project) } : { verdict: 'blocked', reason: 'not_in_trash' },
		),
	async apply(run: RunContext, item: StoredItem): Promise<ItemResult> {
		const project = byId(run, item.targetId);
		if (!project) return { status: 'skipped', reason: 'already_purged' };
		if (!project.deletedAt) return { status: 'skipped', reason: 'restored' };
		try {
			await run.ctx.projects.purgeNow(run.principal, project.slug, { operationId: run.operationId });
			return { status: 'succeeded' };
		} catch (error) {
			return failed(error);
		}
	},
	finish: bumpOnce,
};

export const bulkActionDefinitions: Record<BulkActionId, ActionDefinition> = {
	'project.delete': deleteAction,
	'project.restore': restoreAction,
	'project.purge': purgeAction,
};
