import { and, eq } from 'drizzle-orm';
import {
	databases,
	orgQuotas,
	projects,
	usageSnapshots,
} from '@yoal/db';
import {
	QUOTA_UNLIMITED,
	quotaMetricUnitsByKey,
	quotaPercent,
	projectQuotaOverrideSchema,
	quotaUpdateSchema,
	quotaUsageMetricKeys,
	resolveQuota,
	type OrgQuota,
	type ProjectQuotaFields,
	type ProjectQuotaView,
	type QuotaUsageHistoryView,
	type QuotaUsageMetricKey,
	type QuotaUsageMetrics,
	type QuotaUsageView,
	type QuotaUpdate,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError } from './errors.ts';

const DAY_MS = 86_400_000;

/**
 * Quota writes: any principal of a platform-admin user (dashboard, or the admin's API key from the
 * CLI) or an internal system principal. MCP tokens carry no quota-write tool.
 */
function requireQuotaAdmin(principal: Principal): void {
	if (principal.platformAdmin !== true && principal.kind !== 'system')
		throw new CoreError('forbidden', 'Platform admin required to change quotas.', 403);
}
const CACHE_MS = 60_000;
const DAYS = 30;

/**
 * Snapshots are frozen JSON from the day they were taken, so ones written before a metric key
 * existed (e.g. `registryBytes`) lack it. Fill the gap with zero-used/unlimited so every point
 * carries every key the contract promises.
 */
function completeSnapshot(stored: Partial<QuotaUsageMetrics>): QuotaUsageMetrics {
	const metrics = {} as QuotaUsageMetrics;
	for (const key of quotaUsageMetricKeys) {
		metrics[key] = stored[key] ?? {
			used: 0,
			limit: QUOTA_UNLIMITED,
			unit: quotaMetricUnitsByKey[key],
			percent: null,
		};
	}
	return metrics;
}

export interface UsageOptions {
	/** Scope the view to one project in the caller's org. */
	projectSlug?: string;
}

interface CacheEntry {
	at: number;
	view: QuotaUsageView;
}

/**
 * Usage and showback (plan 16, docs/QUOTAS.md). Everything is computed from the caller's org only;
 * a project slug is resolved through `ProjectService`, so another org's slug is a 404 rather than a
 * leak. The snapshot is cached for 60 seconds to keep a dashboard refresh cheap.
 *
 * Counts are current rows, byte totals come from the latest agent samples (`databases.size_bytes`,
 * `storage_instances.used_bytes`), and egress is an approximate 30-day sum from the traffic store.
 * `workloadMemoryMb` is admitted/reserved memory, matching the quota's admission unit.
 */
export class UsageService {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly egressCache = new Map<string, { at: number; bytes: number }>();

	constructor(private readonly ctx: CoreContext) {}

	async view(principal: Principal, options: UsageOptions = {}): Promise<QuotaUsageView> {
		const project = options.projectSlug ? this.project(principal, options.projectSlug) : null;
		this.ctx.iam.require(
			principal,
			'project:read',
			project ? { type: 'project', id: project.id } : { type: 'org' },
		);
		const projectId = project?.id ?? null;
		const key = `${principal.orgId}:${projectId ?? ''}`;
		const cached = this.cache.get(key);
		if (cached && this.ctx.now() - cached.at < CACHE_MS) return cloneView(cached.view);
		const view = await this.buildView(principal.orgId, projectId, project?.slug ?? null);
		this.cache.set(key, { at: this.ctx.now(), view });
		return cloneView(view);
	}

	/** Internal org-wide view for the alert sweep; never exposed without a principal. */
	async orgUsage(orgId: string): Promise<QuotaUsageView> {
		const key = `${orgId}:`;
		const cached = this.cache.get(key);
		if (cached && this.ctx.now() - cached.at < CACHE_MS) return cloneView(cached.view);
		const view = await this.buildView(orgId, null, null);
		this.cache.set(key, { at: this.ctx.now(), view });
		return cloneView(view);
	}

	/** A quota change should be visible immediately; drop this org's 60-second cache. */
	clearCache(orgId?: string): void {
		if (!orgId) {
			this.cache.clear();
			return;
		}
		for (const key of this.cache.keys()) if (key.startsWith(`${orgId}:`)) this.cache.delete(key);
	}

	quotas(
		principal: Principal,
		options: UsageOptions = {},
	): { orgId: string; projectId: string | null; projectSlug: string | null; base: OrgQuota; overrides: ProjectQuotaFields; effective: OrgQuota } {
		const project = options.projectSlug ? this.project(principal, options.projectSlug) : null;
		this.ctx.iam.require(
			principal,
			'project:read',
			project ? { type: 'project', id: project.id } : { type: 'org' },
		);
		const base = this.ctx.quota.getConfigured(principal.orgId);
		if (!project)
			return {
				orgId: principal.orgId,
				projectId: null,
				projectSlug: null,
				base,
				overrides: {},
				effective: base,
			};
		const overrides = this.ctx.quota.overrides(principal.orgId, project.id);
		const view: ProjectQuotaView = {
			orgId: principal.orgId,
			projectId: project.id,
			projectSlug: project.slug,
			base,
			overrides,
			effective: resolveQuota(base, overrides),
		};
		return view;
	}

	/**
	 * Change the org quota, or one project's overrides with `projectSlug` (docs/QUOTAS.md). Platform
	 * admins only, on every surface; the project still resolves inside the caller's org. An org
	 * update is a patch; a project update replaces that project's overrides.
	 */
	setQuotas(
		principal: Principal,
		input: QuotaUpdate | ProjectQuotaFields,
		options: UsageOptions = {},
	): ReturnType<UsageService['quotas']> {
		requireQuotaAdmin(principal);
		if (options.projectSlug) {
			const project = this.project(principal, options.projectSlug);
			const overrides = projectQuotaOverrideSchema.parse(input);
			this.ctx.quota.setProject(principal.orgId, project.id, overrides);
			this.ctx.audit.record({
				principal,
				action: 'quota.set',
				resource: 'project',
				resourceId: project.id,
				args: { project: project.slug, ...overrides },
				result: 'ok',
			});
			return this.quotas(principal, { projectSlug: project.slug });
		}
		const update = quotaUpdateSchema.parse(input);
		this.ctx.quota.set(principal.orgId, update);
		this.ctx.audit.record({
			principal,
			action: 'quota.set',
			resource: 'org',
			resourceId: principal.orgId,
			args: update,
			result: 'ok',
		});
		return this.quotas(principal);
	}

	/** Drop a project's overrides so it inherits the org quota again. Platform admins only. */
	clearProjectQuotas(principal: Principal, projectSlug: string): { ok: true } {
		requireQuotaAdmin(principal);
		const project = this.project(principal, projectSlug);
		this.ctx.quota.clearProject(principal.orgId, project.id);
		this.ctx.audit.record({
			principal,
			action: 'quota.clear',
			resource: 'project',
			resourceId: project.id,
			args: { project: project.slug },
			result: 'ok',
		});
		return { ok: true };
	}

	/** Up to 30 daily points; the current day is included when a snapshot exists. */
	history(principal: Principal, options: UsageOptions = {}): QuotaUsageHistoryView {
		const project = options.projectSlug ? this.project(principal, options.projectSlug) : null;
		this.ctx.iam.require(
			principal,
			'project:read',
			project ? { type: 'project', id: project.id } : { type: 'org' },
		);
		const projectId = project?.id ?? null;
		const rows = this.ctx.db
			.select()
			.from(usageSnapshots)
			.where(
				and(
					eq(usageSnapshots.orgId, principal.orgId),
					eq(usageSnapshots.projectId, projectId ?? ''),
				),
			)
			.orderBy(usageSnapshots.day)
			.all()
			.slice(-DAYS);
		return {
			orgId: principal.orgId,
			projectId,
			projectSlug: project?.slug ?? null,
			points: rows.map((row) => ({
				day: row.day,
				metrics: completeSnapshot(JSON.parse(row.metricsJson) as Partial<QuotaUsageMetrics>),
			})),
		};
	}

	/** CSV showback: the same numbers as the cards, one row per quota metric. */
	csv(view: QuotaUsageView): string {
		const lines = ['metric,unit,used,limit,percent'];
		for (const key of quotaUsageMetricKeys) {
			const metric = view.metrics[key];
			lines.push(
				[
					key,
					metric.unit,
					String(metric.used),
					metric.limit < 0 ? 'unlimited' : String(metric.limit),
					metric.percent === null ? '' : String(metric.percent),
				].join(','),
			);
		}
		return `${lines.join('\n')}\n`;
	}

	/**
	 * One snapshot per org per UTC day for the trend. Maintenance calls this every sweep; the
	 * existence check makes it a cheap no-op after the first call of the day.
	 */
	async captureSnapshots(): Promise<number> {
		const orgs = new Set<string>();
		for (const row of this.ctx.db.select({ orgId: projects.orgId }).from(projects).all()) orgs.add(row.orgId);
		for (const row of this.ctx.db.select({ orgId: usageSnapshots.orgId }).from(usageSnapshots).all()) orgs.add(row.orgId);
		for (const row of this.ctx.db.select({ orgId: orgQuotas.orgId }).from(orgQuotas).all()) orgs.add(row.orgId);
		// Quota-only orgs (no projects yet) are rare but cheap to include.
		for (const row of this.ctx.db.select({ orgId: databases.orgId }).from(databases).all()) orgs.add(row.orgId);
		const day = new Date(this.ctx.now()).toISOString().slice(0, 10);
		let captured = 0;
		for (const orgId of orgs) {
			const existing = this.ctx.db
				.select({ day: usageSnapshots.day })
				.from(usageSnapshots)
				.where(and(eq(usageSnapshots.orgId, orgId), eq(usageSnapshots.projectId, ''), eq(usageSnapshots.day, day)))
				.get();
			if (existing) continue;
			try {
				const metrics = await this.metrics(orgId, null);
				this.ctx.db
					.insert(usageSnapshots)
					.values({
						orgId,
						projectId: '',
						day,
						metricsJson: JSON.stringify(metrics),
						createdAt: this.ctx.now(),
					})
					.onConflictDoNothing()
					.run();
				captured++;
			} catch (error) {
				console.error(`[usage] snapshot for ${orgId} failed:`, error);
			}
		}
		return captured;
	}

	// ---------------------------------------------------------------- internals

	private async buildView(orgId: string, projectId: string | null, projectSlug: string | null): Promise<QuotaUsageView> {
		const metrics = await this.metrics(orgId, projectId);
		const limits = this.limits(orgId, projectId);
		return {
			orgId,
			projectId,
			projectSlug,
			at: new Date(this.ctx.now()).toISOString(),
			cachedUntil: new Date(this.ctx.now() + CACHE_MS).toISOString(),
			periodDays: DAYS,
			metrics,
			warnings: warningsFor(metrics, limits),
		};
	}

	private project(principal: Principal, slug: string) {
		const project = this.ctx.projects.requireRow(principal, slug);
		if (project.deletedAt) throw new NotFoundError(`Project "${slug}"`);
		return project;
	}

	private limits(orgId: string, projectId: string | null): OrgQuota {
		const base = this.ctx.quota.getConfigured(orgId);
		if (!projectId) return base;
		return resolveQuota(base, this.ctx.quota.overrides(orgId, projectId));
	}

	private async metrics(orgId: string, projectId: string | null): Promise<QuotaUsageMetrics> {
		const counts = this.ctx.quota.snapshotCounts(orgId, projectId);
		const actual = this.ctx.quota.actualUsage(orgId, projectId);
		const limits = this.limits(orgId, projectId);
		const egress = await this.egressUsed(orgId, projectId);

		const values: Record<QuotaUsageMetricKey, number> = {
			projects: projectId ? 1 : counts.projects,
			databases: counts.databases,
			// Display actual sampled bytes; enforcement in QuotaService uses configured budgets.
			databaseStorageBytes: actual.databaseStorageBytes,
			storageInstances: counts.storageInstances,
			storageBytes: actual.storageBytes,
			storageObjects: actual.storageObjects,
			appVolumes: counts.appVolumes,
			// Reserved size, matching enforcement; `usedBytes` samples are on each volume's page.
			appVolumeBytes: counts.appVolumeBytes,
			jobs: counts.jobs,
			jobRunsPerDay: counts.jobRunsPerDay,
			buildsPerDay: counts.buildsPerDay,
			previews: counts.previews,
			workloadMemoryMb: counts.workloadMemoryMb,
			egressBytes: egress,
			registryBytes: this.ctx.registry.usedBytes(orgId, projectId),
		};

		const metrics = {} as QuotaUsageMetrics;
		for (const key of quotaUsageMetricKeys) {
			const used = values[key];
			const limit = limits[key];
			metrics[key] = {
				used,
				limit,
				unit: quotaMetricUnitsByKey[key],
				percent: quotaPercent(used, limit),
			};
		}
		return metrics;
	}

	/**
	 * Approximate 30-day egress (response bytes in the traffic store) for an org, or one project.
	 * Cached for 60 seconds per scope, because the deploy-time quota check reads it too.
	 * Unavailable telemetry is zero, not an error, so a store outage never blocks a deploy.
	 */
	async egressUsed(orgId: string, projectId: string | null): Promise<number> {
		const key = `${orgId}:${projectId ?? ''}`;
		const cached = this.egressCache.get(key);
		if (cached && this.ctx.now() - cached.at < CACHE_MS) return cached.bytes;
		const bytes = await this.queryEgress(orgId, projectId);
		this.egressCache.set(key, { at: this.ctx.now(), bytes });
		return bytes;
	}

	private async queryEgress(orgId: string, projectId: string | null): Promise<number> {
		const telemetry = this.ctx.telemetry;
		if (!telemetry || !(await telemetry.ready())) return 0;
		const to = this.ctx.now();
		const from = to - DAYS * DAY_MS;
		try {
			// Hourly buckets summed directly: the dashboard report would also run top-path queries.
			if (projectId) return sumBytes(await telemetry.query({ projectId, from, to, interval: '1h' }));
			const projectIds = this.ctx.db
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.orgId, orgId))
				.all()
				.map((row) => row.id);
			if (projectIds.length === 0) return 0;
			return sumBytes(await telemetry.query({ projectIds, from, to, interval: '1h' }));
		} catch (error) {
			console.error('[usage] egress query failed:', error);
			return 0;
		}
	}
}

function sumBytes(points: Array<{ bytes: number }>): number {
	return points.reduce((total, point) => total + point.bytes, 0);
}

function warningsFor(metrics: QuotaUsageMetrics, limits: OrgQuota): QuotaUsageView['warnings'] {
	const warnings: QuotaUsageView['warnings'] = [];
	for (const key of quotaUsageMetricKeys) {
		const limit = limits[key];
		if (limit < 0) continue;
		const percent = metrics[key].percent;
		if (percent === null || percent < 80) continue;
		warnings.push({ metric: key, used: metrics[key].used, limit, percent });
	}
	return warnings.slice(0, 16);
}

function cloneView(view: QuotaUsageView): QuotaUsageView {
	return {
		...view,
		metrics: Object.fromEntries(
			quotaUsageMetricKeys.map((key) => [key, { ...view.metrics[key] }]),
		) as QuotaUsageMetrics,
		warnings: view.warnings.map((warning) => ({ ...warning })),
	};
}

/** Kept exported for tests and the alert sweep: attach counts without a full UsageService. */
export function previewCountFor(orgId: string, projectId: string | null, ctx: CoreContext): number {
	return ctx.quota.snapshotCounts(orgId, projectId).previews;
}
