import {
	hasPermission,
	operationActions,
	operationLimits,
	pruneCategoryInfo,
	type Principal,
	type PruneCategory,
} from '@skiff/contracts';
import { CoreError, ForbiddenError } from '../errors.ts';
import { projectOwnedTables } from '../projects.ts';
import type { DomainRow } from '../domains.ts';
import type { ActionDefinition, ItemResult, OperationParams, PlannedItem, RunContext, StoredItem } from './types.ts';

const ACTIVE_WORKLOAD = "('pending','starting','running')";
/** Tables cleaned up under `project_rows`, plus share links (their redemptions go with them). */
const ORPHAN_TABLES = [...projectOwnedTables, 'share_links'] as const;

interface Category {
	id: PruneCategory;
	scan(run: RunContext, scope: Scope): AsyncIterable<PlannedItem>;
	apply(run: RunContext, item: StoredItem, scope: Scope): Promise<ItemResult>;
}

/** Org scope adds `AND <col> = ?`; platform scope covers every org. */
interface Scope {
	orgId: string | null;
	where(column?: string): string;
	args(): string[];
	graceCutoff: number;
}

function scopeFor(run: RunContext): Scope {
	const orgId = run.params.scope === 'platform' ? null : run.principal.orgId;
	return {
		orgId,
		where: (column = 'org_id') => (orgId ? ` AND ${column} = ?` : ''),
		args: () => (orgId ? [orgId] : []),
		graceCutoff: run.ctx.now() - operationLimits.pruneGraceMs,
	};
}

const changed = (reason = 'no_longer_orphaned'): ItemResult => ({ status: 'skipped', reason });

const categories: Category[] = [
	{
		id: 'project_rows',
		async *scan(run, scope) {
			for (const table of ORPHAN_TABLES) {
				const rows = run.ctx.sqlite
					.query<{ project_id: string; org_id: string; n: number }, string[]>(
						`SELECT project_id, org_id, COUNT(*) AS n FROM ${table}
						 WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)${scope.where()}
						 GROUP BY project_id, org_id`,
					)
					.all(...scope.args());
				for (const row of rows)
					yield {
						category: 'project_rows',
						targetKind: table,
						targetId: row.project_id,
						label: `${row.n} ${table.replace(/_/g, ' ')} row${row.n === 1 ? '' : 's'} of deleted project ${row.project_id}`,
						verdict: 'ok',
						data: { table, orgId: row.org_id, rows: row.n },
					};
			}
		},
		async apply(run, item) {
			const table = item.data?.table as string;
			if (!(ORPHAN_TABLES as readonly string[]).includes(table)) return { status: 'failed', error: `Unknown table ${table}` };
			if (run.ctx.sqlite.query('SELECT 1 FROM projects WHERE id = ?').get(item.targetId)) return changed();
			const removed = run.ctx.sqlite.transaction(() => {
				if (table === 'share_links')
					run.ctx.sqlite.run(
						'DELETE FROM share_redemptions WHERE share_link_id IN (SELECT id FROM share_links WHERE project_id = ?)',
						[item.targetId],
					);
				return run.ctx.sqlite.run(`DELETE FROM ${table} WHERE project_id = ? AND project_id NOT IN (SELECT id FROM projects)`, [
					item.targetId,
				]).changes;
			})();
			// Someone (or the trash purge) already removed them since the scan.
			return removed ? { status: 'succeeded' } : changed('already_removed');
		},
	},
	{
		id: 'domains',
		async *scan(run, scope) {
			const rows = run.ctx.sqlite
				.query<{ id: string; hostname: string; project_id: string }, string[]>(
					`SELECT id, hostname, project_id FROM domains WHERE project_id NOT IN (SELECT id FROM projects)${scope.where()}`,
				)
				.all(...scope.args());
			for (const row of rows)
				yield {
					category: 'domains',
					targetKind: 'domain',
					targetId: row.id,
					label: `${row.hostname} (and its managed DNS records)`,
					verdict: 'ok',
				};
		},
		async apply(run, item) {
			const row = run.ctx.sqlite
				.query<Record<string, unknown>, [string]>(
					'SELECT * FROM domains WHERE id = ? AND project_id NOT IN (SELECT id FROM projects)',
				)
				.get(item.targetId);
			if (!row) return changed();
			await run.ctx.domains.removeOrphan(domainRow(row), null, run.operationId);
			return { status: 'succeeded' };
		},
	},
	{
		id: 'workload_reservations',
		async *scan(run, scope) {
			const rows = run.ctx.sqlite
				.query<{ id: string; memory_mb: number; slug: string }, string[]>(
					`SELECT w.id, w.memory_mb, p.slug FROM workloads w JOIN projects p ON p.id = w.project_id
					 WHERE p.deleted_at IS NOT NULL AND w.status IN ${ACTIVE_WORKLOAD}${scope.where('w.org_id')}`,
				)
				.all(...scope.args());
			for (const row of rows)
				yield {
					category: 'workload_reservations',
					targetKind: 'workload',
					targetId: row.id,
					label: `${row.slug} (${row.memory_mb} MiB reserved)`,
					verdict: 'ok',
				};
		},
		async apply(run, item) {
			const result = run.ctx.sqlite.run(
				`UPDATE workloads SET status = 'stopped', message = 'Project deleted', updated_at = ?
				 WHERE id = ? AND status IN ${ACTIVE_WORKLOAD}
				 AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NOT NULL)`,
				[run.ctx.now(), item.targetId],
			);
			return result.changes ? { status: 'succeeded' } : changed();
		},
	},
	{
		id: 'share_redemptions',
		async *scan(run, scope) {
			const cutoff = run.ctx.now() - run.ctx.policies.deletedHistoryMs();
			// Redemptions carry no org id; scope them through their link (orphans only at platform scope).
			const orphans = scope.orgId
				? []
				: run.ctx.sqlite
						.query<{ share_link_id: string; n: number }, []>(
							`SELECT share_link_id, COUNT(*) AS n FROM share_redemptions
							 WHERE share_link_id NOT IN (SELECT id FROM share_links) GROUP BY share_link_id`,
						)
						.all();
			for (const row of orphans)
				yield {
					category: 'share_redemptions',
					targetKind: 'share_link',
					targetId: row.share_link_id,
					label: `${row.n} redemption${row.n === 1 ? '' : 's'} of a deleted share link`,
					verdict: 'ok',
					data: { mode: 'orphan' },
				};
			const expired = run.ctx.sqlite
				.query<{ share_link_id: string; n: number }, Array<string | number>>(
					`SELECT r.share_link_id, COUNT(*) AS n FROM share_redemptions r JOIN share_links l ON l.id = r.share_link_id
					 WHERE r.expires_at < ?${scope.where('l.org_id')} GROUP BY r.share_link_id`,
				)
				.all(cutoff, ...scope.args());
			for (const row of expired)
				yield {
					category: 'share_redemptions',
					targetKind: 'share_link',
					targetId: row.share_link_id,
					label: `${row.n} expired redemption${row.n === 1 ? '' : 's'} of share link ${row.share_link_id}`,
					verdict: 'ok',
					data: { mode: 'expired', cutoff },
				};
		},
		async apply(run, item) {
			const result =
				item.data?.mode === 'orphan'
					? run.ctx.sqlite.run(
							'DELETE FROM share_redemptions WHERE share_link_id = ? AND share_link_id NOT IN (SELECT id FROM share_links)',
							[item.targetId],
						)
					: run.ctx.sqlite.run('DELETE FROM share_redemptions WHERE share_link_id = ? AND expires_at < ?', [
							item.targetId,
							Number(item.data?.cutoff ?? 0),
						]);
			return result.changes ? { status: 'succeeded' } : changed();
		},
	},
	{
		id: 'deployments',
		async *scan(run, scope) {
			const cutoff = run.ctx.now() - run.ctx.policies.deletedHistoryMs();
			const rows = run.ctx.sqlite
				.query<{ id: string; short_id: string; slug: string | null }, Array<string | number>>(
					`SELECT d.id, d.short_id, p.slug FROM deployments d LEFT JOIN projects p ON p.id = d.project_id
					 WHERE d.status = 'deleted' AND d.deleted_at < ?${scope.where('d.org_id')}`,
				)
				.all(cutoff, ...scope.args());
			for (const row of rows)
				yield {
					category: 'deployments',
					targetKind: 'deployment',
					targetId: row.id,
					label: `${row.slug ?? 'deleted project'} · ${row.short_id}`,
					verdict: 'ok',
					data: { cutoff },
				};
		},
		async apply(run, item) {
			const result = run.ctx.sqlite.run("DELETE FROM deployments WHERE id = ? AND status = 'deleted' AND deleted_at < ?", [
				item.targetId,
				Number(item.data?.cutoff ?? 0),
			]);
			return result.changes ? { status: 'succeeded' } : changed();
		},
	},
	{
		id: 'upload_sessions',
		async *scan(run, scope) {
			const rows = run.ctx.sqlite
				.query<{ id: string; status: string; total_bytes: number | null }, Array<string | number>>(
					`SELECT id, status, total_bytes FROM upload_sessions
					 WHERE status IN ('expired','failed') AND expires_at < ?${scope.where()}`,
				)
				.all(scope.graceCutoff, ...scope.args());
			for (const row of rows)
				yield {
					category: 'upload_sessions',
					targetKind: 'upload',
					targetId: row.id,
					label: `${row.status} upload ${row.id}`,
					verdict: 'ok',
					bytes: row.total_bytes ?? 0,
					data: { cutoff: scope.graceCutoff },
				};
		},
		async apply(run, item) {
			const row = run.ctx.sqlite
				.query<{ object_key: string }, [string, number]>(
					"SELECT object_key FROM upload_sessions WHERE id = ? AND status IN ('expired','failed') AND expires_at < ?",
				)
				.get(item.targetId, Number(item.data?.cutoff ?? 0));
			if (!row) return changed();
			run.ctx.sqlite.run('DELETE FROM upload_sessions WHERE id = ?', [item.targetId]);
			await run.ctx.objectStore.delete(row.object_key).catch(() => undefined);
			return { status: 'succeeded', bytes: item.bytes ?? 0 };
		},
	},
	{
		id: 'config_snapshots',
		async *scan(run, scope) {
			const rows = run.ctx.sqlite
				.query<{ id: string; bytes: number }, Array<string | number>>(
					`SELECT id, LENGTH(site_config_json) + LENGTH(env_json) AS bytes FROM config_snapshots
					 WHERE created_at < ?${scope.where()}
					 AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.config_snapshot_id = config_snapshots.id)`,
				)
				.all(scope.graceCutoff, ...scope.args());
			for (const row of rows)
				yield {
					category: 'config_snapshots',
					targetKind: 'config_snapshot',
					targetId: row.id,
					label: row.id,
					verdict: 'ok',
					bytes: row.bytes,
					data: { cutoff: scope.graceCutoff },
				};
		},
		async apply(run, item) {
			const result = run.ctx.sqlite.run(
				`DELETE FROM config_snapshots WHERE id = ? AND created_at < ?
				 AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.config_snapshot_id = config_snapshots.id)`,
				[item.targetId, Number(item.data?.cutoff ?? 0)],
			);
			return result.changes ? { status: 'succeeded', bytes: item.bytes ?? 0 } : changed();
		},
	},
	{
		id: 'releases',
		async *scan(run, scope) {
			const rows = run.ctx.sqlite
				.query<{ id: string; sha256: string; size_bytes: number }, Array<string | number>>(
					`SELECT id, sha256, size_bytes FROM releases r WHERE created_at < ?${scope.where()}
					 AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.release_id = r.id AND d.status != 'deleted')`,
				)
				.all(scope.graceCutoff, ...scope.args());
			for (const row of rows)
				yield {
					category: 'releases',
					targetKind: 'release',
					targetId: row.id,
					label: `release ${row.sha256.slice(0, 12)}`,
					verdict: 'ok',
					bytes: row.size_bytes,
					data: { cutoff: scope.graceCutoff },
				};
		},
		async apply(run, item) {
			const freed = await run.ctx.deployments.deleteReleaseIfUnused(item.targetId, Number(item.data?.cutoff ?? 0));
			return freed === null ? changed() : { status: 'succeeded', bytes: freed };
		},
	},
	{
		id: 'objects',
		async *scan(run, scope) {
			const store = run.ctx.objectStore;
			if (!store.list) {
				yield {
					category: 'objects',
					targetKind: 'object_store',
					targetId: store.kind,
					label: 'This object store cannot list its contents, so unreferenced objects cannot be found.',
					verdict: 'skip',
					reason: 'store_cannot_list',
				};
				return;
			}
			const releaseKeys = new Set(
				run.ctx.sqlite.query<{ k: string }, []>('SELECT DISTINCT object_key AS k FROM releases').all().map((row) => row.k),
			);
			const liveUploads = new Set(
				run.ctx.sqlite
					.query<{ k: string }, []>("SELECT object_key AS k FROM upload_sessions WHERE status = 'pending'")
					.all()
					.map((row) => row.k),
			);
			for (const prefix of ['releases/', 'uploads/']) {
				run.phase(`Listing ${prefix}`);
				let seen = 0;
				for await (const object of store.list(prefix)) {
					if (++seen % 1000 === 0) {
						run.phase(`Listing ${prefix} (${seen} objects)`);
						if (run.cancelled()) return;
					}
					const referenced = prefix === 'releases/' ? releaseKeys.has(object.key) : liveUploads.has(object.key);
					if (referenced || object.lastModified >= scope.graceCutoff) continue;
					yield {
						category: 'objects',
						targetKind: 'object',
						targetId: object.key,
						label: object.key,
						verdict: 'ok',
						bytes: object.size,
					};
				}
			}
		},
		async apply(run, item) {
			const deleted = await run.ctx.deployments.deleteObjectIfUnreferenced(item.targetId);
			return deleted ? { status: 'succeeded', bytes: item.bytes ?? 0 } : changed();
		},
	},
];

const byId = new Map(categories.map((category) => [category.id, category]));
const infoById = new Map(pruneCategoryInfo.map((info) => [info.id, info]));

function selected(params: OperationParams): PruneCategory[] {
	const scope = params.scope ?? 'org';
	const wanted = params.categories?.length ? new Set(params.categories) : null;
	return pruneCategoryInfo
		.filter((info) => (wanted ? wanted.has(info.id) : true))
		.filter((info) => scope === 'platform' || info.scope === 'org')
		.map((info) => info.id);
}

/** Platform prune: a platform admin's session or API key, never OAuth/MCP (docs/OPERATIONS.md §5.2). */
function canPrunePlatform(principal: Principal): boolean {
	return (principal.platformAdmin === true && (principal.kind === 'user' || principal.kind === 'apiKey')) || principal.kind === 'system';
}

export const pruneAction: ActionDefinition = {
	info: operationActions.prune,
	authorize(principal, params) {
		if (!hasPermission(principal, 'project:delete')) throw new ForbiddenError('project:delete');
		if (params.scope === 'platform' && !canPrunePlatform(principal)) throw new ForbiddenError('platform:admin');
		if (params.scope !== 'platform')
			for (const id of params.categories ?? [])
				if (infoById.get(id)?.scope === 'platform')
					throw new CoreError('validation', `"${id}" is shared across orgs and only runs in a platform-scope prune.`, 422);
	},
	async *plan(run) {
		const scope = scopeFor(run);
		for (const id of selected(run.params)) {
			if (run.cancelled()) return;
			run.phase(`Scanning ${infoById.get(id)!.label.toLowerCase()}`);
			yield* byId.get(id)!.scan(run, scope);
		}
	},
	apply(run, item) {
		const category = item.category ? byId.get(item.category) : undefined;
		if (!category) return Promise.resolve({ status: 'failed', error: `Unknown prune category ${item.category}` });
		return category.apply(run, item, scopeFor(run));
	},
	async finish(run) {
		run.ctx.projects.bump(run.params.scope === 'platform' ? undefined : run.principal.orgId);
	},
};

function domainRow(raw: Record<string, unknown>): DomainRow {
	const camel = (key: string) => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
	return Object.fromEntries(Object.entries(raw).map(([key, value]) => [camel(key), value])) as unknown as DomainRow;
}
