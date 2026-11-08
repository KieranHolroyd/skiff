import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
	appVolumes,
	builds,
	databaseAttachments,
	databases,
	deployments,
	orgQuotas,
	projectQuotas,
	projects,
	releases,
	storageAttachments,
	storageInstances,
	workloads,
} from '@skiff/db';
import {
	limits,
	orgQuotaSchema,
	quotaFieldNames,
	resolveQuota,
	type OrgQuota,
	type ProjectQuotaFields,
	type QuotaField,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { featureEnabled } from './config.ts';
import { QuotaError } from './errors.ts';

const MB = 1024 * 1024;
const DAY_MS = 86_400_000;

/** Every quota field; `-1` is unlimited, matching `org_quotas`. */
export type Quota = OrgQuota;

const UNLIMITED: Quota = orgQuotaSchema.parse({});

/** Metrics whose rows live in another service's tables (plan 09 jobs), counted through a hook. */
export type QuotaCounterMetric = 'jobs' | 'jobRunsPerDay';

/**
 * Counts one metric for the quota check and the usage view. `projectId` is null for an org-wide
 * count; `since` is the start of the rolling window (24 hours ago) for `jobRunsPerDay`.
 */
export type QuotaCounter = (scope: { orgId: string; projectId: string | null; since: number }) => number;

interface CountableRow {
	id: string;
	storageMb: number;
	memoryMb: number;
	sizeBytes: number | null;
}

/**
 * Org and per-project quotas (plan 16, docs/QUOTAS.md). Enforcement lives here so every surface —
 * dashboard, REST, CLI, MCP and webhooks — goes through the same check.
 *
 * Counts and storage budgets are **reserved** values (a database's configured `storageMb`), not the
 * latest sampled size, so a lagging metric can never let a create slip past a hard limit. The
 * `UsageService` reports actual sizes for display. `SKIFF_FEATURE_QUOTAS` defaults on; disabling it
 * makes `get()` return unlimited, preserving the pre-plan behaviour.
 */
export class QuotaService {
	private readonly counters = new Map<QuotaCounterMetric, QuotaCounter>();

	constructor(private readonly ctx: CoreContext) {}

	private enforced(): boolean {
		return featureEnabled(this.ctx.config, 'QUOTAS');
	}

	/**
	 * Let the service that owns a metric's rows count them (the jobs service registers `jobs` and
	 * `jobRunsPerDay`). Until one registers, usage is 0 and only a limit of 0 refuses.
	 */
	registerCounter(metric: QuotaCounterMetric, counter: QuotaCounter): void {
		this.counters.set(metric, counter);
	}

	private counted(metric: QuotaCounterMetric, orgId: string, projectId: string | null): number {
		const counter = this.counters.get(metric);
		if (!counter) return 0;
		return counter({ orgId, projectId, since: this.ctx.now() - DAY_MS });
	}

	// ---------------------------------------------------------------- reads

	get(orgId: string): Quota {
		if (!this.enforced()) return { ...UNLIMITED };
		const row = this.ctx.db.select().from(orgQuotas).where(eq(orgQuotas.orgId, orgId)).get();
		return row ? rowToQuota(row) : { ...UNLIMITED };
	}

	/** The org row even when enforcement is off, for the read-only usage/showback surface. */
	getConfigured(orgId: string): Quota {
		const row = this.ctx.db.select().from(orgQuotas).where(eq(orgQuotas.orgId, orgId)).get();
		return row ? rowToQuota(row) : { ...UNLIMITED };
	}

	/** Non-null per-project overrides; null means "inherit the org value". */
	overrides(orgId: string, projectId: string): ProjectQuotaFields {
		const row = this.ctx.db
			.select()
			.from(projectQuotas)
			.where(and(eq(projectQuotas.orgId, orgId), eq(projectQuotas.projectId, projectId)))
			.get();
		if (!row) return {};
		const fields: ProjectQuotaFields = {};
		for (const field of quotaFieldNames) {
			const value = row[field];
			if (value !== null && value !== undefined) fields[field] = value;
		}
		return fields;
	}

	/** Org base plus this project's overrides. `projectId` null returns the org quota. */
	effective(orgId: string, projectId?: string | null): Quota {
		const base = this.get(orgId);
		if (!projectId) return base;
		return resolveQuota(base, this.overrides(orgId, projectId));
	}

	// ---------------------------------------------------------------- writes

	set(orgId: string, quota: Partial<Quota>): void {
		this.ctx.db
			.insert(orgQuotas)
			.values({ orgId, ...UNLIMITED, ...quota, updatedAt: Date.now() })
			.onConflictDoUpdate({ target: orgQuotas.orgId, set: { ...quota, updatedAt: Date.now() } })
			.run();
		this.ctx.usage?.clearCache(orgId);
	}

	/** Replace a project's overrides. An empty patch removes the row (pure inheritance). */
	setProject(orgId: string, projectId: string, overrides: ProjectQuotaFields): void {
		const values = Object.fromEntries(
			Object.entries(overrides).filter(([, value]) => value !== null && value !== undefined),
		) as ProjectQuotaFields;
		const now = Date.now();
		this.ctx.db.transaction(() => {
			this.ctx.db.delete(projectQuotas).where(eq(projectQuotas.projectId, projectId)).run();
			if (Object.keys(values).length > 0)
				this.ctx.db
					.insert(projectQuotas)
					.values({ projectId, orgId, ...values, updatedAt: now })
					.run();
		});
		this.ctx.usage?.clearCache(orgId);
	}

	clearProject(orgId: string, projectId: string): void {
		this.ctx.db
			.delete(projectQuotas)
			.where(and(eq(projectQuotas.orgId, orgId), eq(projectQuotas.projectId, projectId)))
			.run();
		this.ctx.usage?.clearCache(orgId);
	}

	// ---------------------------------------------------------------- projects

	assertCanCreateProject(orgId: string, projectId?: string): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		if (quota.projects < 0) return;
		const count = this.ctx.db
			.select({ count: sql<number>`count(*)` })
			.from(projects)
			.where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
			.get();
		const used = count?.count ?? 0;
		if (used >= quota.projects)
			throw new QuotaError(
				`Project limit reached (${used} of ${quota.projects} projects). Delete a project or raise the org quota.`,
			);
	}

	// ---------------------------------------------------------------- databases

	assertCanCreateDatabase(
		orgId: string,
		projectId: string | null | undefined,
		storageMb: number,
		memoryMb = 0,
	): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		const countRows = this.databaseRows(orgId, this.metricScope(orgId, projectId, 'databases'));
		const storageRows = this.databaseRows(orgId, this.metricScope(orgId, projectId, 'databaseStorageBytes'));
		this.assertLimit('Databases', 'databases', countRows.length + 1, quota.databases, 'count');
		this.assertLimit(
			'Database storage',
			'databaseStorageBytes',
			this.reservedDatabaseBytes(storageRows) + storageMb * MB,
			quota.databaseStorageBytes,
			'bytes',
		);
		this.assertCanAdmitMemory(orgId, projectId, memoryMb);
	}

	/** A resize only checks the delta: the instance's existing reservation is already counted. */
	assertCanResizeDatabase(
		orgId: string,
		projectId: string | null | undefined,
		current: { storageMb: number; memoryMb: number },
		next: { storageMb?: number; memoryMb?: number },
	): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		if (next.storageMb !== undefined && next.storageMb > current.storageMb) {
			const rows = this.databaseRows(orgId, this.metricScope(orgId, projectId, 'databaseStorageBytes'));
			const used = this.reservedDatabaseBytes(rows) + (next.storageMb - current.storageMb) * MB;
			this.assertLimit('Database storage', 'databaseStorageBytes', used, quota.databaseStorageBytes, 'bytes');
		}
		if (next.memoryMb !== undefined && next.memoryMb > current.memoryMb)
			this.assertCanAdmitMemory(orgId, projectId, next.memoryMb - current.memoryMb);
	}

	// ---------------------------------------------------------------- storage

	assertCanCreateStorage(
		orgId: string,
		projectId: string | null | undefined,
		storageMb: number,
		memoryMb = 0,
	): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		const countRows = this.storageRows(orgId, this.metricScope(orgId, projectId, 'storageInstances'));
		const storageRows = this.storageRows(orgId, this.metricScope(orgId, projectId, 'storageBytes'));
		this.assertLimit('Object storage instances', 'storageInstances', countRows.length + 1, quota.storageInstances, 'count');
		this.assertLimit(
			'Object storage',
			'storageBytes',
			this.reservedStorageBytes(storageRows) + storageMb * MB,
			quota.storageBytes,
			'bytes',
		);
		this.assertCanAdmitMemory(orgId, projectId, memoryMb);
	}

	assertCanResizeStorage(
		orgId: string,
		projectId: string | null | undefined,
		current: { storageMb: number; memoryMb: number },
		next: { storageMb?: number; memoryMb?: number },
	): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		if (next.storageMb !== undefined && next.storageMb > current.storageMb) {
			const rows = this.storageRows(orgId, this.metricScope(orgId, projectId, 'storageBytes'));
			const used = this.reservedStorageBytes(rows) + (next.storageMb - current.storageMb) * MB;
			this.assertLimit('Object storage', 'storageBytes', used, quota.storageBytes, 'bytes');
		}
		if (next.memoryMb !== undefined && next.memoryMb > current.memoryMb)
			this.assertCanAdmitMemory(orgId, projectId, next.memoryMb - current.memoryMb);
	}

	/** Object count/size is actual (not reserved): there is no budget field for individual keys. */
	assertCanCreateObject(
		orgId: string,
		projectId: string | null | undefined,
		additionalObjects = 1,
		additionalBytes = 0,
	): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		const objectRows = this.storageRows(orgId, this.metricScope(orgId, projectId, 'storageObjects'));
		const byteRows = this.storageRows(orgId, this.metricScope(orgId, projectId, 'storageBytes'));
		const objects = this.actualStorageObjects(objectRows) + additionalObjects;
		const bytes = this.actualStorageBytes(byteRows) + additionalBytes;
		this.assertLimit('Object count', 'storageObjects', objects, quota.storageObjects, 'count');
		this.assertLimit('Object storage usage', 'storageBytes', bytes, quota.storageBytes, 'bytes');
	}

	// ---------------------------------------------------------------- volumes

	/**
	 * App volumes (plan 07) reserve their configured `sizeMb`, like databases: the quota counts
	 * budgets, not the sampled `usedBytes`. Trashed volumes no longer count.
	 */
	assertCanCreateVolume(orgId: string, projectId: string | null | undefined, sizeMb = 0): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		const countRows = this.volumeRows(orgId, this.metricScope(orgId, projectId, 'appVolumes'));
		const byteRows = this.volumeRows(orgId, this.metricScope(orgId, projectId, 'appVolumeBytes'));
		this.assertLimit('App volumes', 'appVolumes', countRows.length + 1, quota.appVolumes, 'count');
		this.assertLimit(
			'App volume storage',
			'appVolumeBytes',
			reservedVolumeBytes(byteRows) + sizeMb * MB,
			quota.appVolumeBytes,
			'bytes',
		);
	}

	/** A resize only checks the growth: the volume's current size is already counted. */
	assertCanResizeVolume(
		orgId: string,
		projectId: string | null | undefined,
		currentMb: number,
		nextMb: number,
	): void {
		if (!this.enforced() || nextMb <= currentMb) return;
		const quota = this.effective(orgId, projectId);
		const rows = this.volumeRows(orgId, this.metricScope(orgId, projectId, 'appVolumeBytes'));
		const used = reservedVolumeBytes(rows) + (nextMb - currentMb) * MB;
		this.assertLimit('App volume storage', 'appVolumeBytes', used, quota.appVolumeBytes, 'bytes');
	}

	// ---------------------------------------------------------------- jobs and previews

	/** Job definitions (plan 09). Counted by the hook the jobs service registers. */
	assertCanCreateJob(orgId: string, projectId: string | null | undefined): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		const used = this.counted('jobs', orgId, this.metricScope(orgId, projectId, 'jobs')) + 1;
		this.assertLimit('Jobs', 'jobs', used, quota.jobs, 'count');
	}

	/**
	 * One job run (scheduled or manual) in the rolling 24 hours. A scheduler that hits this should
	 * record the run as skipped with the error message rather than retrying.
	 */
	assertCanRunJob(orgId: string, projectId: string | null | undefined): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		const used = this.counted('jobRunsPerDay', orgId, this.metricScope(orgId, projectId, 'jobRunsPerDay')) + 1;
		this.assertLimit('Job runs today', 'jobRunsPerDay', used, quota.jobRunsPerDay, 'count');
	}

	/**
	 * One more concurrent preview: an active deployment that serves no environment and was never
	 * production (see `previewCount`). The deployment service calls this only when a deploy adds one.
	 */
	assertCanCreatePreview(orgId: string, projectId: string | null | undefined): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		const used = this.previewCount(orgId, this.metricScope(orgId, projectId, 'previews')) + 1;
		if (quota.previews < 0 || used <= quota.previews) return;
		throw new QuotaError(
			`Previews quota (previews) exceeded: ${used} used of ${quota.previews}. Delete or promote a preview deployment, or raise the quota.`,
		);
	}

	assertCanCreateBuild(orgId: string, projectId: string | null | undefined): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		const scope = this.metricScope(orgId, projectId, 'buildsPerDay');
		const since = this.ctx.now() - DAY_MS;
		const filters = [eq(builds.orgId, orgId), sql`${builds.createdAt} >= ${since}`];
		if (scope) filters.push(eq(builds.projectId, scope));
		const row = this.ctx.db
			.select({ count: sql<number>`count(*)` })
			.from(builds)
			.where(and(...filters))
			.get();
		// Pipeline triggers (docs/PIPELINES.md) count as builds org-wide; they belong to no project.
		const pipelineTriggers = scope
			? 0
			: (this.ctx.sqlite
					.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM pipeline_triggers WHERE org_id = ? AND created_at >= ?')
					.get(orgId, since)?.n ?? 0);
		this.assertLimit('Builds today', 'buildsPerDay', (row?.count ?? 0) + pipelineTriggers + 1, quota.buildsPerDay, 'count');
	}

	/**
	 * Egress is approximate (the traffic store's 30-day byte total) and cannot be refused per
	 * request without cutting live traffic. Over the quota, running sites keep serving and new
	 * deploys are refused instead; rollback and promote stay available as the recovery path.
	 * Unavailable telemetry reads as zero, so a store outage never blocks a deploy.
	 */
	async assertCanCreateDeployment(orgId: string, projectId: string | null | undefined): Promise<void> {
		if (!this.enforced()) return;
		const limit = this.effective(orgId, projectId).egressBytes;
		if (limit < 0) return;
		const used = await this.ctx.usage.egressUsed(orgId, this.metricScope(orgId, projectId, 'egressBytes'));
		if (used <= limit) return;
		throw new QuotaError(
			`Egress quota (egressBytes) exceeded: ${formatBytes(used)} served in the last 30 days of ${formatBytes(limit)}. Running sites keep serving; new deploys are refused until the 30-day total drops under the quota or the quota is raised.`,
		);
	}

	/** Egress is approximate and read from telemetry; callers pass the 30-day total. */
	assertCanEgress(
		orgId: string,
		projectId: string | null | undefined,
		usedBytes: number,
		additionalBytes = 0,
	): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		this.assertLimit('Egress (30 days)', 'egressBytes', usedBytes + additionalBytes, quota.egressBytes, 'bytes');
	}

	/** Platform registry pushes (docs/REGISTRY.md §6.3): refused while sampled usage is at the limit. */
	assertCanPushImage(orgId: string, projectId: string | null, usedBytes: number): void {
		if (!this.enforced()) return;
		const quota = this.effective(orgId, projectId);
		if (quota.registryBytes < 0 || usedBytes < quota.registryBytes) return;
		this.assertLimit('Registry images', 'registryBytes', usedBytes + 1, quota.registryBytes, 'bytes');
	}

	// ---------------------------------------------------------------- memory and uploads

	/** Sum of reserved memory across app workloads, databases and storage in the org/project. */
	assertCanAdmitMemory(orgId: string, projectId: string | null | undefined, additionalMb: number): void {
		if (!this.enforced() || additionalMb <= 0) return;
		const quota = this.effective(orgId, projectId);
		const used = this.reservedMemoryMb(orgId, this.metricScope(orgId, projectId, 'workloadMemoryMb')) + additionalMb;
		this.assertLimit('Workload memory', 'workloadMemoryMb', used, quota.workloadMemoryMb, 'megabytes');
	}

	assertCanUpload(orgId: string, bytes: number): void {
		if (!this.enforced()) return;
		const quota = this.get(orgId);
		if (quota.maxUploadBytes >= 0 && bytes > quota.maxUploadBytes)
			throw new QuotaError(`Upload is ${bytes} bytes; this org allows ${quota.maxUploadBytes}.`);
		if (quota.storageBytes < 0) return;
		const used = this.ctx.db
			.select({ total: sql<number>`coalesce(sum(${releases.sizeBytes}), 0)` })
			.from(releases)
			.where(eq(releases.orgId, orgId))
			.get();
		if ((used?.total ?? 0) + bytes > quota.storageBytes)
			throw new QuotaError(`Storage quota exceeded (${quota.storageBytes} bytes).`);
	}

	/** Effective retention count: project override, org quota, or the platform default. */
	retention(orgId: string, projectId?: string | null): number {
		const fallback = this.ctx.policies.get().retainedDeployments;
		if (!this.enforced()) return fallback;
		const quota = this.effective(orgId, projectId);
		return quota.retainedDeployments >= 0 ? quota.retainedDeployments : fallback;
	}

	// ---------------------------------------------------------------- usage helpers (sync)

	/** Actual (latest sampled) bytes for display; hard limits use the reserved values below. */
	actualUsage(orgId: string, projectId?: string | null): {
		databaseStorageBytes: number;
		storageBytes: number;
		storageObjects: number;
	} {
		const dbRows = this.databaseRows(orgId, projectId);
		const stRows = this.storageRows(orgId, projectId);
		return {
			databaseStorageBytes: dbRows.reduce((total, row) => total + (row.sizeBytes ?? 0), 0),
			storageBytes: this.actualStorageBytes(stRows),
			storageObjects: this.actualStorageObjects(stRows),
		};
	}

	/** Current reserved values used by both enforcement and the usage view. */
	snapshotCounts(orgId: string, projectId?: string | null): {
		projects: number;
		databases: number;
		databaseStorageBytes: number;
		storageInstances: number;
		storageBytes: number;
		storageObjects: number;
		previews: number;
		workloadMemoryMb: number;
		buildsPerDay: number;
		appVolumes: number;
		appVolumeBytes: number;
		jobs: number;
		jobRunsPerDay: number;
	} {
		const dbRows = this.databaseRows(orgId, projectId);
		const stRows = this.storageRows(orgId, projectId);
		const volumeRows = this.volumeRows(orgId, projectId);
		const projectCount = this.ctx.db
			.select({ count: sql<number>`count(*)` })
			.from(projects)
			.where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
			.get();
		const since = this.ctx.now() - DAY_MS;
		const buildFilters = [eq(builds.orgId, orgId), sql`${builds.createdAt} >= ${since}`];
		if (projectId) buildFilters.push(eq(builds.projectId, projectId));
		const buildCount = this.ctx.db
			.select({ count: sql<number>`count(*)` })
			.from(builds)
			.where(and(...buildFilters))
			.get();
		return {
			projects: projectCount?.count ?? 0,
			databases: dbRows.length,
			// Reserved budget, not actual size: this is the value a hard limit is checked against.
			databaseStorageBytes: this.reservedDatabaseBytes(dbRows),
			storageInstances: stRows.length,
			storageBytes: this.reservedStorageBytes(stRows),
			storageObjects: this.actualStorageObjects(stRows),
			previews: this.previewCount(orgId, projectId),
			workloadMemoryMb: this.reservedMemoryMb(orgId, projectId),
			buildsPerDay: buildCount?.count ?? 0,
			appVolumes: volumeRows.length,
			// Reserved size, like databases: the value the hard limit checks.
			appVolumeBytes: reservedVolumeBytes(volumeRows),
			jobs: this.counted('jobs', orgId, projectId ?? null),
			jobRunsPerDay: this.counted('jobRunsPerDay', orgId, projectId ?? null),
		};
	}

	// ---------------------------------------------------------------- internals

	private databaseRows(orgId: string, projectId?: string | null): CountableRow[] {
		const filters = [eq(databases.orgId, orgId), isNull(databases.deletedAt)];
		if (projectId) {
			const ids = this.databaseIdsForProject(projectId);
			if (ids.length === 0) return [];
			filters.push(inArray(databases.id, ids));
		}
		return this.ctx.db
			.select({
				id: databases.id,
				storageMb: databases.storageMb,
				memoryMb: databases.memoryMb,
				sizeBytes: databases.sizeBytes,
			})
			.from(databases)
			.where(and(...filters))
			.all();
	}

	private storageRows(orgId: string, projectId?: string | null): CountableRow[] {
		const filters = [eq(storageInstances.orgId, orgId), isNull(storageInstances.deletedAt)];
		if (projectId) {
			const ids = this.storageIdsForProject(projectId);
			if (ids.length === 0) return [];
			filters.push(inArray(storageInstances.id, ids));
		}
		return this.ctx.db
			.select({
				id: storageInstances.id,
				storageMb: storageInstances.storageMb,
				memoryMb: storageInstances.memoryMb,
				sizeBytes: storageInstances.usedBytes,
			})
			.from(storageInstances)
			.where(and(...filters))
			.all();
	}

	/** Live (not trashed) app volumes; volumes are project-owned, so a project scope is direct. */
	private volumeRows(orgId: string, projectId?: string | null): Array<{ sizeMb: number }> {
		const filters = [eq(appVolumes.orgId, orgId), isNull(appVolumes.deletedAt)];
		if (projectId) filters.push(eq(appVolumes.projectId, projectId));
		return this.ctx.db
			.select({ sizeMb: appVolumes.sizeMb })
			.from(appVolumes)
			.where(and(...filters))
			.all();
	}

	private databaseIdsForProject(projectId: string): string[] {
		return this.ctx.db
			.select({ id: databaseAttachments.databaseId })
			.from(databaseAttachments)
			.where(eq(databaseAttachments.projectId, projectId))
			.all()
			.map((row) => row.id);
	}

	private storageIdsForProject(projectId: string): string[] {
		return this.ctx.db
			.select({ id: storageAttachments.storageId })
			.from(storageAttachments)
			.where(eq(storageAttachments.projectId, projectId))
			.all()
			.map((row) => row.id);
	}

	/**
	 * Count a metric over the project only when this project overrides it; otherwise the org base
	 * applies and usage must be org-wide, or attaching resources to projects would bypass it.
	 */
	private metricScope(orgId: string, projectId: string | null | undefined, field: QuotaField): string | null {
		if (!projectId) return null;
		const override = this.overrides(orgId, projectId)[field];
		return override !== undefined && override !== null ? projectId : null;
	}

	private reservedDatabaseBytes(rows: CountableRow[]): number {		return rows.reduce((total, row) => total + row.storageMb * MB, 0);
	}

	private reservedStorageBytes(rows: CountableRow[]): number {
		return rows.reduce((total, row) => total + row.storageMb * MB, 0);
	}

	private actualStorageBytes(rows: CountableRow[]): number {
		return rows.reduce((total, row) => total + (row.sizeBytes ?? 0), 0);
	}

	private actualStorageObjects(rows: CountableRow[]): number {
		// `objects` is reported by the agent on the instance; it is not typed on CountableRow.
		const ids = rows.map((row) => row.id);
		if (ids.length === 0) return 0;
		const totals = this.ctx.db
			.select({ objects: storageInstances.objects })
			.from(storageInstances)
			.where(inArray(storageInstances.id, ids))
			.all();
		return totals.reduce((total, row) => total + (row.objects ?? 0), 0);
	}

	private reservedMemoryMb(orgId: string, projectId?: string | null): number {
		const workloadsFilters = [eq(workloads.orgId, orgId)];
		if (projectId) workloadsFilters.push(eq(workloads.projectId, projectId));
		const workloadMb = this.ctx.db
			.select({ total: sql<number>`coalesce(sum(${workloads.memoryMb}), 0)` })
			.from(workloads)
			.where(and(...workloadsFilters))
			.get();
		const dbMb = this.databaseRows(orgId, projectId).reduce((total, row) => total + row.memoryMb, 0);
		const stMb = this.storageRows(orgId, projectId).reduce((total, row) => total + row.memoryMb, 0);
		const mqMb = this.ctx.brokers?.reservedMemoryForOrg(orgId, projectId) ?? 0;
		return (workloadMb?.total ?? 0) + dbMb + stMb + mqMb;
	}

	/**
	 * Concurrent previews: active deployments of live projects that no environment points at and
	 * that were never production. Every deployment has a preview URL (D13), but a past production
	 * release is rollback history, bounded by `retainedDeployments`; counting it here would make a
	 * normal promote-on-deploy refuse once the history filled up.
	 */
	private previewCount(orgId: string, projectId?: string | null): number {
		const params: string[] = [orgId];
		let projectFilter = '';
		if (projectId) {
			projectFilter = 'AND d.project_id = ?';
			params.push(projectId);
		}
		const row = this.ctx.sqlite
			.query<{ count: number }, string[]>(
				`SELECT count(*) AS count FROM deployments d JOIN projects p ON p.id = d.project_id
				 WHERE d.org_id = ? AND d.status = 'active' AND d.promoted_at IS NULL AND p.deleted_at IS NULL
				   AND (p.production_deployment_id IS NULL OR p.production_deployment_id <> d.id)
				   AND NOT EXISTS (SELECT 1 FROM environments e WHERE e.deployment_id = d.id)
				   ${projectFilter}`,
			)
			.get(...params);
		return row?.count ?? 0;
	}

	/**
	 * True when moving `environmentId` off this deployment would turn it into a preview (the same
	 * rule as `previewCount`, ignoring that one environment's pointer).
	 */
	becomesPreviewWhenUnpointed(deploymentId: string, environmentId: string): boolean {
		const row = this.ctx.sqlite
			.query<{ count: number }, [string, string]>(
				`SELECT count(*) AS count FROM deployments d JOIN projects p ON p.id = d.project_id
				 WHERE d.id = ? AND d.status = 'active' AND d.promoted_at IS NULL
				   AND (p.production_deployment_id IS NULL OR p.production_deployment_id <> d.id)
				   AND NOT EXISTS (SELECT 1 FROM environments e WHERE e.deployment_id = d.id AND e.id <> ?)`,
			)
			.get(deploymentId, environmentId);
		return (row?.count ?? 0) > 0;
	}

	private assertLimit(
		label: string,
		field: string,
		used: number,
		limit: number,
		unit: 'count' | 'bytes' | 'megabytes',
	): void {
		if (limit < 0) return;
		if (used <= limit) return;
		const shown = unit === 'bytes' ? formatBytes(used) : `${used}${unit === 'megabytes' ? ' MB' : ''}`;
		const allowed = unit === 'bytes' ? formatBytes(limit) : `${limit}${unit === 'megabytes' ? ' MB' : ''}`;
		throw new QuotaError(
			`${label} quota (${field}) exceeded: ${shown} used of ${allowed}. Delete unused resources or raise the quota.`,
		);
	}
}

function rowToQuota(row: typeof orgQuotas.$inferSelect): Quota {
	return {
		projects: row.projects,
		storageBytes: row.storageBytes,
		retainedDeployments: row.retainedDeployments,
		maxUploadBytes: row.maxUploadBytes,
		databases: row.databases ?? -1,
		databaseStorageBytes: row.databaseStorageBytes ?? -1,
		storageInstances: row.storageInstances ?? -1,
		storageObjects: row.storageObjects ?? -1,
		appVolumes: row.appVolumes ?? -1,
		appVolumeBytes: row.appVolumeBytes ?? -1,
		jobs: row.jobs ?? -1,
		jobRunsPerDay: row.jobRunsPerDay ?? -1,
		buildsPerDay: row.buildsPerDay ?? -1,
		previews: row.previews ?? -1,
		workloadMemoryMb: row.workloadMemoryMb ?? -1,
		egressBytes: row.egressBytes ?? -1,
		registryBytes: row.registryBytes ?? -1,
	};
}

function reservedVolumeBytes(rows: Array<{ sizeMb: number }>): number {
	return rows.reduce((total, row) => total + row.sizeMb * MB, 0);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
	return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

export const _deploymentTable = deployments;
