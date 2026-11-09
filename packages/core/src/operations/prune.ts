import {
	canMaintainPlatform,
	hasPermission,
	operationActions,
	operationLimits,
	parseImageReference,
	pruneCategoryInfo,
	type Principal,
	type PruneCategory,
} from '@skiff/contracts';
import { CoreError, ForbiddenError } from '../errors.ts';
import { projectOwnedTables } from '../projects.ts';
import type { DomainRow } from '../domains.ts';
import type { ActionDefinition, ItemResult, OperationParams, PlannedItem, RunContext, StoredItem } from './types.ts';
import type { PlatformIamService } from '../platform-iam.ts';

const DAY_MS = 86_400_000;
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
		id: 'registry_images',
		async *scan(run, scope) {
			const registry = run.ctx.registry;
			if (!registry.enabled()) {
				yield {
					category: 'registry_images',
					targetKind: 'registry',
					targetId: 'registry',
					label: 'The platform registry is off, so there are no images to prune.',
					verdict: 'skip',
					reason: 'registry_off',
				};
				return;
			}
			const retention = run.params.olderThanDays
				? run.params.olderThanDays * DAY_MS
				: run.ctx.policies.registryRetentionMs();
			const cutoff = run.ctx.now() - retention;
			const keepTags = run.params.keepTags ?? registry.keepTagCount();
			const inUse = registryTagsInUse(run, scope);
			const repositories = run.ctx.sqlite
				.query<{ name: string }, string[]>(`SELECT name FROM registry_repositories WHERE 1 = 1${scope.where()}`)
				.all(...scope.args());
			for (const repository of repositories) {
				if (run.cancelled()) return;
				run.phase(`Listing tags in ${repository.name}`);
				let tags: Awaited<ReturnType<typeof registry.describeTags>>;
				try {
					tags = await registry.describeTags(repository.name);
				} catch (error) {
					yield {
						category: 'registry_images',
						targetKind: 'registryRepository',
						targetId: repository.name,
						label: `${repository.name}: the registry could not be read (${(error as Error).message})`,
						verdict: 'skip',
						reason: 'registry_unreachable',
					};
					continue;
				}
				const used = inUse.get(repository.name) ?? new Set<string>();
				const keep = newestRegistryTags(tags, keepTags, used);
				const keptDigests = new Set(tags.filter((tag) => keep.has(tag.tag) && tag.digest).map((tag) => tag.digest!));
				for (const tag of tags) {
					if (keep.has(tag.tag) || tag.createdAt === null || tag.createdAt >= cutoff) continue;
					// A tag shares its manifest with a kept tag (e.g. `latest`): deleting it could
					// remove the kept tag too, so leave the shared manifest alone.
					if (!tag.digest || keptDigests.has(tag.digest)) continue;
					yield {
						category: 'registry_images',
						targetKind: 'registryTag',
						targetId: `${repository.name}:${tag.tag}`,
						label: `${repository.name}:${tag.tag} (${new Date(tag.createdAt).toISOString().slice(0, 10)})`,
						verdict: 'ok',
						bytes: tag.bytes,
						data: { repository: repository.name, tag: tag.tag, cutoff, keepTags },
					};
				}
			}
		},
		async apply(run, item) {
			const repository = String(item.data?.repository ?? '');
			const tag = String(item.data?.tag ?? '');
			const cutoff = Number(item.data?.cutoff ?? 0);
			const keepTags = Number(item.data?.keepTags ?? 0);
			const tags = await run.ctx.registry.describeTags(repository);
			const current = tags.find((entry) => entry.tag === tag);
			if (!current) return changed('already_removed');
			if (current.createdAt === null) return changed('creation_time_unknown');
			if (current.createdAt >= cutoff) return changed('younger_than_retention');
			const keep = newestRegistryTags(tags, keepTags, registryTagsInUse(run, scopeFor(run)).get(repository) ?? new Set());
			if (keep.has(tag)) return changed('still_kept');
			if (!current.digest || tags.some((entry) => keep.has(entry.tag) && entry.digest === current.digest))
				return changed('shared_manifest');
			const deleted = await run.ctx.registry.deleteTagAsSystem(repository, tag);
			return deleted ? { status: 'succeeded', bytes: item.bytes ?? 0 } : changed('already_removed');
		},
	},
	{
		id: 'runner_registrations',
		async *scan(run, scope) {
			const rows = runnerRegistrationRows(run, scope).filter((row) => runnerRegistrationIsStale(row));
			const cutoff = run.ctx.now() - (run.params.olderThanDays ? run.params.olderThanDays * DAY_MS : run.ctx.policies.runnerRegistrationRetentionMs());
			for (const row of rows) {
				if (row.created_at >= cutoff) continue;
				yield {
					category: 'runner_registrations',
					targetKind: 'githubRunner',
					targetId: row.id,
					label: `${row.runner_name} (${row.target}${row.project_slug ? `, ${row.project_slug}` : ''})`,
					verdict: 'ok',
					data: { cutoff },
				};
			}
		},
		async apply(run, item) {
			const cutoff = Number(item.data?.cutoff ?? 0);
			const row = runnerRegistrationRows(run, scopeFor(run)).find((entry) => entry.id === item.targetId);
			if (!row) return changed('already_removed');
			if (row.created_at >= cutoff) return changed('younger_than_retention');
			if (!runnerRegistrationIsStale(row)) return changed('runner_still_live');
			const removed = await run.ctx.githubRunners.deregisterRegistration(row.id);
			return removed ? { status: 'succeeded' } : changed('already_removed');
		},
	},
	{
		id: 'volume_snapshots',
		async *scan(run, scope) {
			if (!run.ctx.appVolumes.enabled()) {
				yield {
					category: 'volume_snapshots',
					targetKind: 'appVolume',
					targetId: 'app-volumes',
					label: 'App volumes are not enabled on this platform.',
					verdict: 'skip',
					reason: 'feature_disabled',
				};
				return;
			}
			const cutoff =
				run.ctx.now() - (run.params.olderThanDays ? run.params.olderThanDays * DAY_MS : run.ctx.policies.volumeSnapshotRetentionMs());
			const rows = run.ctx.sqlite
				.query<
					{ id: string; volume_id: string; volume_name: string | null; created_at: number; size_bytes: number | null },
					Array<string | number>
				>(
					`SELECT s.id, s.volume_id, v.name AS volume_name, s.created_at, s.size_bytes
					 FROM app_volume_snapshots s LEFT JOIN app_volumes v ON v.id = s.volume_id
					 WHERE s.pinned = 0 AND s.status IN ('ok','failed') AND s.created_at < ?${scope.where('s.org_id')}
					 AND NOT EXISTS (SELECT 1 FROM app_volumes r WHERE r.restore_snapshot_id = s.id)`,
				)
				.all(cutoff, ...scope.args());
			for (const row of rows)
				yield {
					category: 'volume_snapshots',
					targetKind: 'appVolumeSnapshot',
					targetId: row.id,
					label: `${row.volume_name ?? row.volume_id} snapshot ${row.id} (${new Date(row.created_at).toISOString().slice(0, 10)})`,
					verdict: 'ok',
					bytes: row.size_bytes ?? 0,
					data: { cutoff },
				};
		},
		async apply(run, item) {
			const cutoff = Number(item.data?.cutoff ?? 0);
			const orgId = scopeFor(run).orgId;
			const row = run.ctx.sqlite
				.query<{ org_id: string }, [string]>('SELECT org_id FROM app_volume_snapshots WHERE id = ?')
				.get(item.targetId);
			if (!row || (orgId && row.org_id !== orgId)) return changed('already_removed');
			const result = await run.ctx.appVolumes.lifecycle.pruneSnapshot(item.targetId, cutoff);
			return result.removed ? { status: 'succeeded', bytes: result.bytes } : changed('not_removable');
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

/**
 * Platform prune: once the D129 binding is seeded this is the `platform:maintenance` permission on
 * a platform admin's dashboard session (API keys and MCP are refused). Until then the pre-I8 rule
 * (a platform admin's session or API key, never OAuth/MCP) keeps it working.
 */
let platformIam: PlatformIamService | undefined;

/**
 * `OperationService` calls `authorize(principal, params)` before a `RunContext` exists, so the
 * platform service is attached when the core is built (see `createCore`). Without it (a bare test
 * importing the action) the pre-I8 platform-admin rule is used.
 */
export function configurePrunePlatformIam(service: PlatformIamService): void {
	platformIam = service;
}

function canPrunePlatform(principal: Principal): boolean {
	if (platformIam) return platformIam.canMaintain(principal);
	return canMaintainPlatform(principal);
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

/** Repository → tags a live workload names, so a prune never removes an image still in use. */
function registryTagsInUse(run: RunContext, scope: Scope): Map<string, Set<string>> {
	const used = new Map<string, Set<string>>();
	const rows = run.ctx.sqlite
		.query<{ spec_json: string | null }, string[]>(
			`SELECT w.spec_json FROM workloads w JOIN projects p ON p.id = w.project_id
			 WHERE p.deleted_at IS NULL${scope.where('w.org_id')}`,
		)
		.all(...scope.args());
	for (const row of rows) {
		let image: unknown;
		try {
			image = (JSON.parse(row.spec_json ?? '{}') as { image?: unknown }).image;
		} catch {
			continue;
		}
		if (typeof image !== 'string' || !run.ctx.registry.isOwnImage(image)) continue;
		const ref = parseImageReference(image);
		if (!ref?.tag) continue;
		const tags = used.get(ref.repository) ?? new Set<string>();
		tags.add(ref.tag);
		used.set(ref.repository, tags);
	}
	return used;
}

/** The tags a registry prune always keeps: the newest N by creation time, `latest`, and in-use tags. */
function newestRegistryTags(
	tags: ReadonlyArray<{ tag: string; createdAt: number | null }>,
	keepTags: number,
	inUse: ReadonlySet<string>,
): Set<string> {
	const keep = new Set(inUse);
	keep.add('latest');
	const sorted = [...tags].sort((a, b) => (b.createdAt ?? Number.NEGATIVE_INFINITY) - (a.createdAt ?? Number.NEGATIVE_INFINITY));
	for (const tag of sorted.slice(0, Math.max(0, keepTags))) keep.add(tag.tag);
	return keep;
}

interface RunnerRegistrationRow {
	id: string;
	runner_name: string;
	target: string;
	created_at: number;
	replica: number;
	project_id: string | null;
	project_slug: string | null;
	project_deleted_at: number | null;
	workload_id: string | null;
	workload_status: string | null;
	spec_json: string | null;
}

function runnerRegistrationRows(run: RunContext, scope: Scope): RunnerRegistrationRow[] {
	return run.ctx.sqlite
		.query<RunnerRegistrationRow, string[]>(
			`SELECT r.id, r.runner_name, r.target, r.created_at, r.replica, r.project_id,
			        p.slug AS project_slug, p.deleted_at AS project_deleted_at,
			        r.workload_id, w.status AS workload_status, w.spec_json
			 FROM github_runner_registrations r
			 LEFT JOIN projects p ON p.id = r.project_id
			 LEFT JOIN workloads w ON w.id = r.workload_id
			 WHERE 1 = 1${scope.where('r.org_id')}`,
		)
		.all(...scope.args());
}

/** A registration no live project, workload, runner profile or replica still expects. */
function runnerRegistrationIsStale(row: RunnerRegistrationRow): boolean {
	if (!row.project_id || row.project_deleted_at !== null || !row.workload_id || !row.workload_status) return true;
	if (!ACTIVE_WORKLOAD.includes(`'${row.workload_status}'`)) return true;
	let spec: { replicas?: unknown; runner?: unknown } | null = null;
	try {
		spec = JSON.parse(row.spec_json ?? '{}') as { replicas?: unknown; runner?: unknown };
	} catch {
		return true;
	}
	if (!spec?.runner) return true;
	const replicas = typeof spec.replicas === 'number' ? spec.replicas : 1;
	return row.replica >= replicas;
}

function domainRow(raw: Record<string, unknown>): DomainRow {
	const camel = (key: string) => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
	return Object.fromEntries(Object.entries(raw).map(([key, value]) => [camel(key), value])) as unknown as DomainRow;
}
