import {
	METRICS_EXPORT_DEFAULTS,
	METRICS_EXPORT_SETTINGS_KEY,
	brokerStreamStatsSchema,
	canAdministerPlatform,
	canViewPlatform,
	metricsExportSettingsSchema,
	metricsExportSettingsUpdateSchema,
	quotaUsageMetricKeys,
	requirePermission,
	type BrokerStreamStats,
	type MetricsExportSettings,
	type MetricsSection,
	type Permission,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { DB_COUNTERS } from './database-metrics-sql.ts';
import { CoreError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from './errors.ts';
import type { ScrapeSampleRow, ScrapeSamples } from './telemetry.ts';

/**
 * Prometheus export (DESIGN §8, D16, docs/METRICS.md). One renderer behind `/metrics` and its
 * scoped paths, so a Grafana user can scrape exactly what they chart:
 *
 * - `GET /metrics` with no credentials: the fleet summary (when `publicPlatform` is on).
 * - `GET /metrics` with an API key (`metrics:read`): every enabled section for the key's org.
 * - `GET /metrics/<section>[/<name>]`: one section, or one app/database/storage instance.
 *
 * Every section reads SQLite with a fixed number of grouped queries and ClickHouse with at most
 * four, filtered to the ids in scope, so a scrape costs the same whether an org has one app or
 * hundreds. Renders are cached per (org, scope, permissions) for `cacheSeconds`, and concurrent
 * scrapes of the same scope share one render.
 */

export interface MetricsScope {
	/** `all` is the bare `/metrics`. */
	section: 'all' | MetricsSection;
	/** One app slug, database, storage or broker name; only for `apps`, `traffic`, `databases`, `storage`, `brokers`. */
	name?: string;
}

const NAMED_SECTIONS = new Set<MetricsScope['section']>(['apps', 'traffic', 'databases', 'storage', 'brokers', 'volumes']);
const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;

/** Which org sections need which permission (on top of `metrics:read`). */
const SECTION_PERMISSION: Record<Exclude<MetricsSection, 'platform'>, Permission> = {
	usage: 'project:read',
	apps: 'project:read',
	traffic: 'project:read',
	databases: 'database:read',
	storage: 'storage:read',
	brokers: 'broker:read',
	volumes: 'project:read',
};

const ORG_SECTIONS = ['usage', 'apps', 'traffic', 'databases', 'storage', 'brokers', 'volumes'] as const;

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

interface CacheEntry {
	at: number;
	text: Promise<string>;
}

interface ProjectRef {
	id: string;
	slug: string;
}

export class MetricsExporter {
	readonly #cache = new Map<string, CacheEntry>();
	#settings: MetricsExportSettings | null = null;

	constructor(
		private readonly ctx: CoreContext,
		/** The legacy fleet summary (`MetricsService.platformLines`), injected to avoid a cycle. */
		private readonly platformSummary: () => string[],
	) {}

	// ---------------------------------------------------------------- settings

	settings(): MetricsExportSettings {
		if (this.#settings) return this.#settings;
		const row = this.ctx.sqlite
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(METRICS_EXPORT_SETTINGS_KEY);
		let parsed = METRICS_EXPORT_DEFAULTS;
		if (row) {
			try {
				const result = metricsExportSettingsSchema.safeParse(JSON.parse(row.value));
				if (result.success) parsed = result.data;
			} catch {
				// A hand-edited row that is not JSON falls back to the defaults.
			}
		}
		this.#settings = parsed;
		return parsed;
	}

	/**
	 * Platform admins' own session only (the dashboard also requires the org owner); validates,
	 * merges, persists and drops every cached render.
	 */
	updateSettings(principal: Principal, input: unknown): MetricsExportSettings {
		if (!canAdministerPlatform(principal))
			throw new CoreError('forbidden', 'Only a platform admin signed in to the dashboard can change metrics export settings.', 403);
		const update = metricsExportSettingsUpdateSchema.safeParse(input);
		if (!update.success) throw new ValidationError('Invalid metrics export settings.', update.error.issues);
		const current = this.settings();
		const next = metricsExportSettingsSchema.parse({
			...current,
			...update.data,
			sections: { ...current.sections, ...update.data.sections },
		});
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[METRICS_EXPORT_SETTINGS_KEY, JSON.stringify(next), this.ctx.now()],
		);
		this.#settings = next;
		this.#cache.clear();
		return next;
	}

	// ---------------------------------------------------------------- render

	/** Parse `/metrics/<a>/<b>` path segments into a scope; unknown sections are a 404. */
	static scopeFromPath(segments: string[]): MetricsScope {
		if (segments.length === 0) return { section: 'all' };
		const [head, name, ...rest] = segments;
		const section = head === 'projects' ? 'apps' : head;
		if (rest.length > 0 || !isScopeSection(section)) throw new NotFoundError('Metrics path');
		if (name !== undefined && !NAMED_SECTIONS.has(section)) throw new NotFoundError('Metrics path');
		return name === undefined ? { section } : { section, name: decodeURIComponent(name) };
	}

	async render(principal: Principal | undefined, scope: MetricsScope): Promise<string> {
		const settings = this.settings();
		if (!principal) {
			if (scope.section !== 'all' || !settings.publicPlatform) throw new UnauthorizedError('Send an API key with metrics:read.');
			return this.#cached('public', settings, () => this.#renderPlatform(settings));
		}
		requirePermission(principal, 'metrics:read');
		if (scope.section !== 'all' && !settings.sections[scope.section]) throw new NotFoundError(`Metrics section "${scope.section}"`);
		if (scope.section === 'platform') {
			if (!canViewPlatform(principal)) throw new ForbiddenError('platform admin');
			return this.#cached('platform', settings, () => this.#renderPlatform(settings));
		}
		if (scope.section !== 'all') requirePermission(principal, SECTION_PERMISSION[scope.section]);
		const permissions = ORG_SECTIONS.map((s) => (principal.permissions.has(SECTION_PERMISSION[s]) ? '1' : '0')).join('');
		const key = `org:${principal.orgId}:${scope.section}:${scope.name ?? ''}:${permissions}`;
		return this.#cached(key, settings, () => this.#renderOrg(principal, scope, settings));
	}

	#cached(key: string, settings: MetricsExportSettings, render: () => Promise<string>): Promise<string> {
		const now = this.ctx.now();
		const hit = this.#cache.get(key);
		if (hit && now - hit.at < settings.cacheSeconds * 1000) return hit.text;
		const text = render();
		this.#cache.set(key, { at: now, text });
		// Never cache a failure; prune stale entries so an org churning names cannot grow the map.
		text.catch(() => this.#cache.delete(key));
		if (this.#cache.size > 1000) for (const [k, v] of this.#cache) if (now - v.at >= settings.cacheSeconds * 1000) this.#cache.delete(k);
		return text;
	}

	// ---------------------------------------------------------------- org sections

	async #renderOrg(principal: Principal, scope: MetricsScope, settings: MetricsExportSettings): Promise<string> {
		const started = performance.now();
		const out = new Exposition();
		// An app scrape (`/metrics/apps[/<slug>]`) carries that app's traffic and volumes too.
		const wants = (section: Exclude<MetricsSection, 'platform'>) =>
			settings.sections[section] &&
			principal.permissions.has(SECTION_PERMISSION[section]) &&
			(scope.section === 'all' ||
				scope.section === section ||
				(scope.section === 'apps' && (section === 'traffic' || section === 'volumes')));

		// Resolve the ids in scope first: one SQLite query per resource kind.
		const appScope = wants('apps') || wants('traffic') || wants('volumes');
		const projects = appScope ? this.#projects(principal.orgId, scope, settings, out) : [];
		const databases = wants('databases') ? this.#databases(principal.orgId, scope.section === 'databases' ? scope.name : undefined) : [];
		const storage = wants('storage') ? this.#storage(principal.orgId, scope.section === 'storage' ? scope.name : undefined) : [];
		const brokerRows = wants('brokers') ? this.#brokers(principal.orgId, scope.section === 'brokers' ? scope.name : undefined) : [];

		// One ClickHouse round per scrape, filtered to those ids.
		const telemetry = this.ctx.telemetry;
		const needsTelemetry = wants('traffic') || databases.length > 0 || storage.length > 0 || brokerRows.length > 0;
		const telemetryUp = needsTelemetry && telemetry ? await telemetry.ready() : false;
		const samples: ScrapeSamples =
			telemetryUp && telemetry
				? await telemetry.scrapeSamples({
						projectIds: wants('traffic') ? projects.map((p) => p.id) : [],
						databaseIds: databases.map((d) => d.id),
						storageIds: storage.map((s) => s.id),
						brokerIds: brokerRows.map((b) => b.id),
					})
				: { traffic: [], databases: [], databaseCounters: [], storage: [], brokers: [], brokerCounters: [] };

		if (wants('usage')) await this.#usage(principal, out);
		if (wants('apps')) this.#apps(principal.orgId, projects, out);
		if (wants('traffic')) this.#traffic(projects, samples, out);
		if (wants('volumes')) this.#appVolumes(principal.orgId, projects, out);
		if (wants('databases')) this.#databaseSeries(databases, samples, out);
		if (wants('storage')) this.#storageSeries(storage, samples, out);
		if (wants('brokers')) this.#brokerSeries(brokerRows, samples, out);

		if (needsTelemetry)
			out.gauge('skiff_telemetry_up', 'Whether the ClickHouse telemetry store answered this scrape (1 = up).', {}, telemetryUp ? 1 : 0);
		out.gauge('skiff_scrape_duration_seconds', 'Time the control plane spent rendering this scrape.', {}, (performance.now() - started) / 1000);
		return out.render();
	}

	/** Projects in scope, ordered by slug and capped at `maxApps` for aggregate scrapes. */
	#projects(orgId: string, scope: MetricsScope, settings: MetricsExportSettings, out: Exposition): ProjectRef[] {
		const named = (scope.section === 'apps' || scope.section === 'traffic' || scope.section === 'volumes') && scope.name !== undefined;
		if (named) {
			const row = this.ctx.sqlite
				.query<ProjectRef, [string, string]>('SELECT id, slug FROM projects WHERE org_id = ? AND slug = ? AND deleted_at IS NULL')
				.get(orgId, scope.name!);
			if (!row) throw new NotFoundError(`Project "${scope.name}"`);
			return [row];
		}
		const rows = this.ctx.sqlite
			.query<ProjectRef, [string, number]>('SELECT id, slug FROM projects WHERE org_id = ? AND deleted_at IS NULL ORDER BY slug LIMIT ?')
			.all(orgId, settings.maxApps + 1);
		const truncated = rows.length > settings.maxApps;
		out.gauge(
			'skiff_scrape_truncated',
			'1 when this scrape left apps out (Settings → Metrics → max apps); scrape /metrics/apps/<slug> for the rest.',
			{ section: 'apps' },
			truncated ? 1 : 0,
		);
		return truncated ? rows.slice(0, settings.maxApps) : rows;
	}

	async #usage(principal: Principal, out: Exposition): Promise<void> {
		const view = await this.ctx.usage.view(principal);
		for (const key of quotaUsageMetricKeys) {
			const metric = view.metrics[key];
			const labels = { metric: key, unit: metric.unit };
			out.gauge('skiff_quota_used', 'Current usage per quota metric (egress: 30-day sum).', labels, metric.used);
			if (metric.limit >= 0) out.gauge('skiff_quota_limit', 'Quota limit per metric; absent when unlimited.', labels, metric.limit);
			if (metric.percent !== null) out.gauge('skiff_quota_used_ratio', 'Usage as a share of the limit (0–1+).', { metric: key }, metric.percent / 100);
		}
	}

	#apps(orgId: string, projects: ProjectRef[], out: Exposition): void {
		if (projects.length === 0) return;
		const ids = projects.map((p) => p.id);
		const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
		const inList = placeholders(ids.length);

		const info = this.ctx.sqlite
			.query<{ id: string; name: string; runtime: string; placement: string; created_at: number }, string[]>(
				`SELECT id, name, COALESCE(runtime_name, runtime) AS runtime, placement, created_at FROM projects WHERE id IN (${inList})`,
			)
			.all(...ids);
		for (const row of info) {
			const project = slugOf.get(row.id)!;
			out.gauge('skiff_project_info', 'One series per app, carrying its name and runtime.', { project, name: row.name, runtime: row.runtime, placement: row.placement }, 1);
			out.gauge('skiff_project_created_timestamp_seconds', 'When the app was created.', { project }, row.created_at / 1000);
		}

		const deployments = this.ctx.sqlite
			.query<{ project_id: string; status: string; n: number; last: number }, string[]>(
				`SELECT project_id, status, count(*) AS n, max(created_at) AS last FROM deployments
				WHERE project_id IN (${inList}) AND status != 'deleted' GROUP BY project_id, status`,
			)
			.all(...ids);
		const lastDeploy = new Map<string, number>();
		for (const row of deployments) {
			const project = slugOf.get(row.project_id)!;
			out.gauge('skiff_project_deployments', 'Deployments per app and status (deleted excluded).', { project, status: row.status }, row.n);
			lastDeploy.set(row.project_id, Math.max(lastDeploy.get(row.project_id) ?? 0, row.last));
		}
		for (const [id, at] of lastDeploy)
			out.gauge('skiff_project_last_deploy_timestamp_seconds', 'When the app last received a deployment.', { project: slugOf.get(id)! }, at / 1000);

		const releaseBytes = this.ctx.sqlite
			.query<{ project_id: string; bytes: number }, string[]>(
				`SELECT d.project_id, coalesce(sum(r.size_bytes), 0) AS bytes
				FROM (SELECT DISTINCT project_id, release_id FROM deployments WHERE project_id IN (${inList}) AND status != 'deleted') d
				JOIN releases r ON r.id = d.release_id GROUP BY d.project_id`,
			)
			.all(...ids);
		for (const row of releaseBytes)
			out.gauge('skiff_project_release_bytes', 'Bytes of release artifacts retained by the app’s deployments.', { project: slugOf.get(row.project_id)! }, row.bytes);

		const since = this.ctx.now() - DAY_MS;
		const builds = this.ctx.sqlite
			.query<{ project_id: string; status: string; n: number; avg_ms: number | null }, (string | number)[]>(
				`SELECT project_id, status, count(*) AS n,
					avg(CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL THEN finished_at - started_at END) AS avg_ms
				FROM builds WHERE org_id = ? AND created_at >= ? AND project_id IN (${inList}) GROUP BY project_id, status`,
			)
			.all(orgId, since, ...ids);
		for (const row of builds) {
			const project = slugOf.get(row.project_id)!;
			out.gauge('skiff_project_builds_24h', 'Git builds started in the last 24 hours, per status.', { project, status: row.status }, row.n);
			if (row.avg_ms !== null)
				out.gauge('skiff_project_build_duration_seconds_avg_24h', 'Mean build time over the last 24 hours, per status.', { project, status: row.status }, row.avg_ms / 1000);
		}

		const workloads = this.ctx.sqlite
			.query<{ project_id: string; runtime: string; status: string; memory_mb: number; cpus: number }, string[]>(
				`SELECT project_id, COALESCE(runtime_name, runtime) AS runtime, status, memory_mb, cpus FROM workloads WHERE project_id IN (${inList})`,
			)
			.all(...ids);
		for (const row of workloads) {
			const project = slugOf.get(row.project_id)!;
			out.gauge('skiff_project_workload_up', '1 while the app’s process/container workload is running.', { project, runtime: row.runtime }, row.status === 'running' ? 1 : 0);
			out.gauge('skiff_project_workload_memory_limit_bytes', 'Memory reserved for the app’s workload.', { project }, row.memory_mb * MIB);
			out.gauge('skiff_project_workload_cpu_limit', 'CPUs reserved for the app’s workload.', { project }, row.cpus);
		}

		const domains = this.ctx.sqlite
			.query<{ project_id: string; status: string; n: number }, string[]>(
				`SELECT project_id, status, count(*) AS n FROM domains WHERE project_id IN (${inList}) GROUP BY project_id, status`,
			)
			.all(...ids);
		for (const row of domains)
			out.gauge('skiff_project_domains', 'Custom domains per app and status.', { project: slugOf.get(row.project_id)!, status: row.status }, row.n);
	}

	#traffic(projects: ProjectRef[], samples: ScrapeSamples, out: Exposition): void {
		const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
		const help = 'Requests served in the last hour, per app and status class.';
		for (const row of samples.traffic) {
			const project = slugOf.get(row.projectId);
			if (!project) continue;
			out.gauge('skiff_project_http_requests_1h', help, { project, status_class: '2xx' }, row.status2xx);
			out.gauge('skiff_project_http_requests_1h', help, { project, status_class: '3xx' }, row.status3xx);
			out.gauge('skiff_project_http_requests_1h', help, { project, status_class: '4xx' }, row.status4xx);
			out.gauge('skiff_project_http_requests_1h', help, { project, status_class: '5xx' }, row.status5xx);
			out.gauge('skiff_project_http_response_bytes_1h', 'Response bytes served in the last hour (egress).', { project }, row.bytes);
			out.gauge('skiff_project_http_duration_p50_ms_1h', 'Request-weighted median latency over the last hour, ms.', { project }, row.durationP50Ms);
			out.gauge('skiff_project_http_duration_p95_ms_1h', 'Request-weighted p95 latency over the last hour, ms.', { project }, row.durationP95Ms);
		}
	}

	#appVolumes(orgId: string, projects: ProjectRef[], out: Exposition): void {
		if (projects.length === 0) return;
		const ids = projects.map((p) => p.id);
		const slugOf = new Map(projects.map((p) => [p.id, p.slug]));
		const rows = this.ctx.sqlite
			.query<{ project_id: string; name: string; size_mb: number; used_bytes: number | null; status: string }, string[]>(
				`SELECT project_id, name, size_mb, used_bytes, status FROM app_volumes
				WHERE org_id = ? AND deleted_at IS NULL AND project_id IN (${placeholders(ids.length)})`,
			)
			.all(orgId, ...ids);
		for (const row of rows) {
			const labels = { project: slugOf.get(row.project_id)!, volume: row.name };
			out.gauge('skiff_project_volume_ready', '1 while the app volume is mounted and ready.', labels, row.status === 'ready' ? 1 : 0);
			out.gauge('skiff_project_volume_size_bytes', 'App volume size (its quota).', labels, row.size_mb * MIB);
			if (row.used_bytes !== null) out.gauge('skiff_project_volume_used_bytes', 'Bytes used on the app volume (last node sample).', labels, row.used_bytes);
		}
	}

	#databases(orgId: string, name: string | undefined): DatabaseRef[] {
		const base = 'SELECT id, name, engine_name AS engine, version, status, memory_mb, cpus, storage_mb, size_bytes FROM databases WHERE org_id = ? AND deleted_at IS NULL';
		if (name === undefined) return this.ctx.sqlite.query<DatabaseRef, [string]>(`${base} ORDER BY name`).all(orgId);
		const row = this.ctx.sqlite.query<DatabaseRef, [string, string]>(`${base} AND name = ?`).get(orgId, name);
		if (!row) throw new NotFoundError(`Database "${name}"`);
		return [row];
	}

	#storage(orgId: string, name: string | undefined): StorageRef[] {
		const base =
			'SELECT id, name, engine, version, status, memory_mb, cpus, storage_mb, used_bytes, objects, public FROM storage_instances WHERE org_id = ? AND deleted_at IS NULL';
		if (name === undefined) return this.ctx.sqlite.query<StorageRef, [string]>(`${base} ORDER BY name`).all(orgId);
		const row = this.ctx.sqlite.query<StorageRef, [string, string]>(`${base} AND name = ?`).get(orgId, name);
		if (!row) throw new NotFoundError(`Storage instance "${name}"`);
		return [row];
	}

	#brokers(orgId: string, name: string | undefined): BrokerRef[] {
		const base =
			'SELECT id, name, engine, version, status, memory_mb, cpus, storage_mb, store_bytes, messages, queue_stats, stats_at FROM brokers WHERE org_id = ? AND deleted_at IS NULL';
		if (name === undefined) return this.ctx.sqlite.query<BrokerRef, [string]>(`${base} ORDER BY name`).all(orgId);
		const row = this.ctx.sqlite.query<BrokerRef, [string, string]>(`${base} AND name = ?`).get(orgId, name);
		if (!row) throw new NotFoundError(`Broker "${name}"`);
		return [row];
	}

	#databaseSeries(rows: DatabaseRef[], samples: ScrapeSamples, out: Exposition): void {
		const latest = byId(samples.databases);
		const counters = byId(samples.databaseCounters);
		for (const db of rows) {
			const labels = { database: db.name, database_id: db.id };
			out.gauge('skiff_database_info', 'One series per managed database, carrying its engine and version.', { ...labels, engine: db.engine, version: db.version }, 1);
			out.gauge('skiff_database_running', '1 while the control plane considers the database running.', labels, db.status === 'running' ? 1 : 0);
			out.gauge('skiff_database_memory_limit_bytes', 'Configured memory limit.', labels, db.memory_mb * MIB);
			out.gauge('skiff_database_cpu_limit', 'Configured CPU limit.', labels, db.cpus);
			out.gauge('skiff_database_storage_limit_bytes', 'Configured storage budget.', labels, db.storage_mb * MIB);
			const sample = latest.get(db.id);
			const size = sample?.['size_bytes'] ?? db.size_bytes;
			if (size !== null && size !== undefined) out.gauge('skiff_database_size_bytes', 'Database size on disk.', labels, size);
			if (sample) {
				out.gauge('skiff_database_up', 'Whether the database answered its last sample (1 = up).', labels, sample['up'] ?? 0);
				out.gauge('skiff_database_connections', 'Open connections.', labels, sample['connections_total'] ?? 0);
				out.gauge('skiff_database_max_connections', 'Configured max_connections.', labels, sample['max_connections'] ?? 0);
				out.gauge('skiff_database_memory_bytes', 'Container memory use.', labels, sample['memory_bytes'] ?? 0);
				out.gauge('skiff_database_pooler_up', 'Whether the PgBouncer admin console answered (1 = up).', labels, sample['pooler_up'] ?? 0);
				out.gauge('skiff_database_pool_active', 'PgBouncer client/server connections in use.', labels, sample['pool_active'] ?? 0);
				out.gauge('skiff_database_pool_idle', 'Idle PgBouncer server connections.', labels, sample['pool_idle'] ?? 0);
				out.gauge('skiff_database_pool_waiting', 'Clients waiting for a PgBouncer server connection.', labels, sample['pool_waiting'] ?? 0);
				out.gauge('skiff_database_pool_saturation', 'Share of max_client_conn in use (0–1).', labels, sample['pool_saturation'] ?? 0);
				out.gauge('skiff_database_pool_avg_wait_ms', 'Average PgBouncer wait, milliseconds.', labels, sample['pool_avg_wait_ms'] ?? 0);
			}
			const sums = counters.get(db.id);
			if (!sums) continue;
			const v = (column: (typeof DB_COUNTERS)[number][0]) => sums[column] ?? 0;
			const tx = 'Transactions in the last hour (pg_stat_database).';
			out.gauge('skiff_database_transactions_1h', tx, { ...labels, result: 'commit' }, v('xact_commit'));
			out.gauge('skiff_database_transactions_1h', tx, { ...labels, result: 'rollback' }, v('xact_rollback'));
			const tuples = 'Rows touched in the last hour, per operation (pg_stat_database).';
			for (const op of ['returned', 'fetched', 'inserted', 'updated', 'deleted'] as const)
				out.gauge('skiff_database_tuples_1h', tuples, { ...labels, op }, v(`tup_${op}`));
			const blocks = 'Blocks read in the last hour, from shared buffers (hit) or disk (read).';
			out.gauge('skiff_database_blocks_1h', blocks, { ...labels, source: 'hit' }, v('blks_hit'));
			out.gauge('skiff_database_blocks_1h', blocks, { ...labels, source: 'read' }, v('blks_read'));
			out.gauge('skiff_database_deadlocks_1h', 'Deadlocks in the last hour.', labels, v('deadlocks'));
			out.gauge('skiff_database_temp_bytes_1h', 'Temporary file bytes written in the last hour.', labels, v('temp_bytes'));
		}
	}

	#storageSeries(rows: StorageRef[], samples: ScrapeSamples, out: Exposition): void {
		const latest = byId(samples.storage);
		for (const st of rows) {
			const labels = { storage: st.name, storage_id: st.id };
			out.gauge('skiff_storage_info', 'One series per object storage instance.', { ...labels, engine: st.engine, version: st.version, public: st.public ? 'true' : 'false' }, 1);
			out.gauge('skiff_storage_running', '1 while the control plane considers the instance running.', labels, st.status === 'running' ? 1 : 0);
			out.gauge('skiff_storage_memory_limit_bytes', 'Configured memory limit.', labels, st.memory_mb * MIB);
			out.gauge('skiff_storage_storage_limit_bytes', 'Configured storage budget.', labels, st.storage_mb * MIB);
			const sample = latest.get(st.id);
			const used = sample?.['used_bytes'] ?? st.used_bytes;
			const objects = sample?.['objects'] ?? st.objects;
			if (used !== null && used !== undefined) out.gauge('skiff_storage_used_bytes', 'Bytes stored across buckets.', labels, used);
			if (objects !== null && objects !== undefined) out.gauge('skiff_storage_objects', 'Objects stored across buckets.', labels, objects);
			if (sample) {
				out.gauge('skiff_storage_up', 'Whether the instance answered its last sample (1 = up).', labels, sample['up'] ?? 0);
				out.gauge('skiff_storage_buckets', 'Buckets on the instance.', labels, sample['bucket_count'] ?? 0);
				out.gauge('skiff_storage_memory_bytes', 'Container memory use.', labels, sample['memory_bytes'] ?? 0);
			}
		}
	}

	/**
	 * Brokers (D123): configuration and the SQLite totals always; live gauges and last-hour rates
	 * from ClickHouse when it answers; one series family per stream from the newest listing.
	 */
	#brokerSeries(rows: BrokerRef[], samples: ScrapeSamples, out: Exposition): void {
		const latest = byId(samples.brokers);
		const counters = byId(samples.brokerCounters);
		for (const mq of rows) {
			const labels = { broker: mq.name, broker_id: mq.id };
			out.gauge('skiff_broker_info', 'One series per managed queue broker, carrying its engine and version.', { ...labels, engine: mq.engine, version: mq.version }, 1);
			out.gauge('skiff_broker_running', '1 while the control plane considers the broker running.', labels, mq.status === 'running' ? 1 : 0);
			out.gauge('skiff_broker_memory_limit_bytes', 'Configured memory limit.', labels, mq.memory_mb * MIB);
			out.gauge('skiff_broker_cpu_limit', 'Configured CPU limit.', labels, mq.cpus);
			out.gauge('skiff_broker_storage_limit_bytes', 'Configured message store budget (JetStream file store).', labels, mq.storage_mb * MIB);
			const sample = latest.get(mq.id);
			// A down sample reads zeros; the last good totals (SQLite) stay the better answer.
			const live = sample && sample['up'] ? sample : undefined;
			const store = live?.['store_bytes'] ?? mq.store_bytes;
			const messages = live?.['messages'] ?? mq.messages;
			if (store !== null && store !== undefined) out.gauge('skiff_broker_store_bytes', 'JetStream file store in use.', labels, store);
			if (messages !== null && messages !== undefined) out.gauge('skiff_broker_messages', 'Messages held across streams.', labels, messages);
			if (sample) {
				out.gauge('skiff_broker_up', 'Whether the broker answered its last sample (1 = up).', labels, sample['up'] ?? 0);
				out.gauge('skiff_broker_connections', 'Client connections (not counting the sampler).', labels, sample['connections'] ?? 0);
				out.gauge('skiff_broker_streams', 'JetStream streams.', labels, sample['streams'] ?? 0);
				out.gauge('skiff_broker_consumers', 'JetStream consumers.', labels, sample['consumers'] ?? 0);
				out.gauge('skiff_broker_memory_store_bytes', 'JetStream memory store in use.', labels, sample['memory_store_bytes'] ?? 0);
				out.gauge('skiff_broker_pending', 'Messages not yet delivered, summed over consumers.', labels, sample['pending'] ?? 0);
				out.gauge('skiff_broker_ack_pending', 'Delivered messages awaiting an ack.', labels, sample['ack_pending'] ?? 0);
				out.gauge('skiff_broker_redelivered', 'Unacknowledged messages delivered more than once.', labels, sample['redelivered'] ?? 0);
				out.gauge('skiff_broker_oldest_message_age_seconds', 'Age of the oldest message held in any stream.', labels, sample['oldest_age_seconds'] ?? 0);
				out.gauge('skiff_broker_memory_bytes', 'Container memory use.', labels, sample['memory_bytes'] ?? 0);
			}
			const sums = counters.get(mq.id);
			if (sums) {
				out.gauge('skiff_broker_published_1h', 'Messages JetStream stored in the last hour.', labels, sums['published'] ?? 0);
				const msgs = 'Messages through the server in the last hour (in = sent by clients).';
				out.gauge('skiff_broker_messages_1h', msgs, { ...labels, direction: 'in' }, sums['messages_in'] ?? 0);
				out.gauge('skiff_broker_messages_1h', msgs, { ...labels, direction: 'out' }, sums['messages_out'] ?? 0);
				const bytes = 'Bytes through the server in the last hour (in = sent by clients).';
				out.gauge('skiff_broker_bytes_1h', bytes, { ...labels, direction: 'in' }, sums['bytes_in'] ?? 0);
				out.gauge('skiff_broker_bytes_1h', bytes, { ...labels, direction: 'out' }, sums['bytes_out'] ?? 0);
				out.gauge('skiff_broker_slow_consumers_1h', 'Clients cut off as slow consumers in the last hour.', labels, sums['slow_consumers'] ?? 0);
			}
			if (mq.stats_at === null) continue;
			out.gauge('skiff_broker_streams_timestamp_seconds', 'When the node took the newest stream listing.', labels, mq.stats_at / 1000);
			for (const stream of parseStreams(mq.queue_stats)) {
				const streamLabels = { ...labels, stream: stream.stream, queue: stream.queue ?? '' };
				out.gauge('skiff_broker_stream_messages', 'Messages held in the stream.', streamLabels, stream.messages);
				out.gauge('skiff_broker_stream_bytes', 'Bytes held in the stream.', streamLabels, stream.bytes);
				out.gauge('skiff_broker_stream_consumers', 'Consumers on the stream.', streamLabels, stream.consumerCount);
				out.gauge('skiff_broker_stream_pending', 'Messages not yet delivered, summed over the stream’s consumers.', streamLabels, stream.pending);
				out.gauge('skiff_broker_stream_ack_pending', 'Delivered messages awaiting an ack.', streamLabels, stream.ackPending);
				out.gauge('skiff_broker_stream_redelivered', 'Unacknowledged messages delivered more than once.', streamLabels, stream.redelivered);
				const first = stream.firstAt ? Date.parse(stream.firstAt) : Number.NaN;
				out.gauge(
					'skiff_broker_stream_oldest_message_age_seconds',
					'Age of the stream’s oldest message at the listing (0 when empty).',
					streamLabels,
					stream.messages > 0 && Number.isFinite(first) ? Math.max(0, (mq.stats_at - first) / 1000) : 0,
				);
			}
		}
	}

	// ---------------------------------------------------------------- platform

	async #renderPlatform(settings: MetricsExportSettings): Promise<string> {
		const lines = this.platformSummary();
		if (settings.sections.platform) {
			const out = new Exposition();
			this.#nodes(out);
			lines.push(out.render().trimEnd());
		}
		const telemetry = this.ctx.telemetry;
		if (settings.sections.traffic && telemetry && (await telemetry.ready())) {
			try {
				lines.push((await telemetry.getPrometheusMetrics()).trimEnd());
			} catch (error) {
				console.error('[metrics] telemetry exposition failed:', error);
			}
		}
		return `${lines.filter(Boolean).join('\n')}\n`;
	}

	#nodes(out: Exposition): void {
		const nodes = this.ctx.sqlite
			.query<{ id: string; name: string; mode: string; status: string; agent_version: string | null; last_heartbeat_at: number | null; stats_json: string | null }, []>(
				'SELECT id, name, mode, status, agent_version, last_heartbeat_at, stats_json FROM nodes ORDER BY name',
			)
			.all();
		const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
		for (const node of nodes) {
			const labels = { node: node.name };
			out.gauge('skiff_node_up', '1 while the node is online.', { ...labels, mode: node.mode }, node.status === 'online' ? 1 : 0);
			out.gauge('skiff_node_info', 'One series per node, carrying its agent version and status.', { ...labels, mode: node.mode, status: node.status, agent_version: node.agent_version ?? '' }, 1);
			if (node.last_heartbeat_at !== null)
				out.gauge('skiff_node_last_heartbeat_timestamp_seconds', 'When the node last sent a heartbeat.', labels, node.last_heartbeat_at / 1000);
			const stats = parseStats(node.stats_json);
			if (!stats) continue;
			const num = (key: string) => (typeof stats[key] === 'number' ? (stats[key] as number) : undefined);
			const series: Array<[string, string, number | undefined]> = [
				['skiff_node_cpu_percent', 'Host CPU use, percent.', num('cpuPercent')],
				['skiff_node_load1', 'One-minute load average.', num('load1')],
				['skiff_node_memory_used_bytes', 'Host memory in use.', num('memoryBytes')],
				['skiff_node_memory_total_bytes', 'Host memory.', num('memoryTotalBytes')],
				['skiff_node_disk_used_bytes', 'Data filesystem bytes used.', num('diskUsedBytes')],
				['skiff_node_disk_total_bytes', 'Data filesystem size.', num('diskTotalBytes')],
				['skiff_node_disk_free_bytes', 'Data filesystem bytes free.', num('diskFreeBytes')],
				['skiff_node_uptime_seconds', 'Host uptime.', num('uptimeSeconds')],
			];
			for (const [name, help, value] of series) if (value !== undefined) out.gauge(name, help, labels, value);
			if (Array.isArray(stats['certs'])) {
				for (const cert of stats['certs'] as Array<{ host?: unknown; notAfter?: unknown }>) {
					const expires = typeof cert.notAfter === 'string' ? Date.parse(cert.notAfter) : Number.NaN;
					if (typeof cert.host === 'string' && Number.isFinite(expires))
						out.gauge('skiff_node_cert_expiry_timestamp_seconds', 'When a TLS certificate served by the node expires.', { ...labels, host: cert.host }, expires / 1000);
				}
			}
		}

		// D80 / docs/VOLUMES.md: volume health and capacity.
		const volumes = this.ctx.sqlite
			.query<{ node_id: string; name: string; kind: string; status: string; size_bytes: number | null; free_bytes: number | null }, []>(
				'SELECT node_id, name, kind, status, size_bytes, free_bytes FROM node_volumes ORDER BY node_id, name',
			)
			.all();
		for (const volume of volumes) {
			const labels = { node: nameOf.get(volume.node_id) ?? volume.node_id, volume: volume.name, kind: volume.kind };
			out.gauge('skiff_volume_up', '1 while the node volume is mounted and ready.', labels, volume.status === 'ready' ? 1 : 0);
			if (volume.size_bytes !== null) out.gauge('skiff_volume_size_bytes', 'Node volume size.', labels, volume.size_bytes);
			if (volume.free_bytes !== null) out.gauge('skiff_volume_free_bytes', 'Node volume free space.', labels, volume.free_bytes);
		}
	}
}

interface DatabaseRef {
	id: string;
	name: string;
	engine: string;
	version: string;
	status: string;
	memory_mb: number;
	cpus: number;
	storage_mb: number;
	size_bytes: number | null;
}

interface BrokerRef {
	id: string;
	name: string;
	engine: string;
	version: string;
	status: string;
	memory_mb: number;
	cpus: number;
	storage_mb: number;
	store_bytes: number | null;
	messages: number | null;
	queue_stats: string | null;
	stats_at: number | null;
}

interface StorageRef {
	id: string;
	name: string;
	engine: string;
	version: string;
	status: string;
	memory_mb: number;
	cpus: number;
	storage_mb: number;
	used_bytes: number | null;
	objects: number | null;
	public: number;
}

function isScopeSection(value: string | undefined): value is MetricsScope['section'] {
	return (
		value === 'usage' ||
		value === 'apps' ||
		value === 'traffic' ||
		value === 'databases' ||
		value === 'storage' ||
		value === 'brokers' ||
		value === 'volumes' ||
		value === 'platform'
	);
}

function placeholders(n: number): string {
	return Array.from({ length: n }, () => '?').join(', ');
}

function byId(rows: ScrapeSampleRow[]): Map<string, Record<string, number>> {
	return new Map(rows.map((row) => [row.id, row.values]));
}

/** The stored stream listing; anything that does not parse is skipped. */
function parseStreams(json: string | null): BrokerStreamStats[] {
	if (!json) return [];
	try {
		const raw = JSON.parse(json) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw.flatMap((item) => {
			const parsed = brokerStreamStatsSchema.safeParse(item);
			return parsed.success ? [parsed.data] : [];
		});
	} catch {
		return [];
	}
}

function parseStats(json: string | null): Record<string, unknown> | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as unknown;
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Prometheus text builder: groups samples by family so HELP/TYPE print once, in first-seen order. */
export class Exposition {
	readonly #families = new Map<string, { help: string; samples: string[] }>();

	gauge(name: string, help: string, labels: Record<string, string>, value: number): void {
		let family = this.#families.get(name);
		if (!family) {
			family = { help, samples: [] };
			this.#families.set(name, family);
		}
		const pairs = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
		family.samples.push(`${name}${pairs.length ? `{${pairs.join(',')}}` : ''} ${formatValue(value)}`);
	}

	render(): string {
		const lines: string[] = [];
		for (const [name, family] of this.#families)
			lines.push(`# HELP ${name} ${family.help.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')}`, `# TYPE ${name} gauge`, ...family.samples);
		return lines.length ? `${lines.join('\n')}\n` : '';
	}
}

function escapeLabel(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function formatValue(value: number): string {
	if (Number.isNaN(value)) return 'NaN';
	if (value === Infinity) return '+Inf';
	if (value === -Infinity) return '-Inf';
	return String(value);
}
