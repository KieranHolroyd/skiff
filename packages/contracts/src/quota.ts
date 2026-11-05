import * as z from 'zod';

/**
 * Quotas, usage and showback (plan 16, docs/QUOTAS.md).
 *
 * Every quota is a maximum in its natural unit; `-1` means unlimited, matching the existing
 * `org_quotas` columns. Org quotas are the base, and a project may override individual fields
 * (`null` = inherit). Enforcement is in the service layer, so REST, CLI and MCP all hit the same
 * check; usage views are read-only and never cross an org boundary.
 *
 * `workloadMemoryMb` is admitted memory in megabytes; every other byte field is bytes. A metric's
 * `percent` is `null` when unlimited, so a UI can render "∞" instead of a fake percentage.
 */

export const QUOTA_UNLIMITED = -1;

export const quotaFieldNames = [
	// Existing org_quotas columns.
	'projects',
	'storageBytes',
	'retainedDeployments',
	'maxUploadBytes',
	// Extended fields (plan 16).
	'databases',
	'databaseStorageBytes',
	'storageInstances',
	'storageObjects',
	'appVolumes',
	'appVolumeBytes',
	'jobs',
	'jobRunsPerDay',
	'buildsPerDay',
	'previews',
	'workloadMemoryMb',
	'egressBytes',
] as const;
export type QuotaField = (typeof quotaFieldNames)[number];

const quotaLimit = z.number().int().min(QUOTA_UNLIMITED);
const quotaLimitDefault = quotaLimit.default(QUOTA_UNLIMITED);
const quotaLimitOptional = quotaLimit.optional();
const quotaOverride = quotaLimit.nullable().optional();

/** A complete org quota. Missing fields are unlimited, matching a fresh `org_quotas` row. */
export const orgQuotaSchema = z
	.strictObject({
		projects: quotaLimitDefault,
		storageBytes: quotaLimitDefault,
		retainedDeployments: quotaLimitDefault,
		maxUploadBytes: quotaLimitDefault,
		databases: quotaLimitDefault,
		databaseStorageBytes: quotaLimitDefault,
		storageInstances: quotaLimitDefault,
		storageObjects: quotaLimitDefault,
		appVolumes: quotaLimitDefault,
		appVolumeBytes: quotaLimitDefault,
		jobs: quotaLimitDefault,
		jobRunsPerDay: quotaLimitDefault,
		buildsPerDay: quotaLimitDefault,
		previews: quotaLimitDefault,
		workloadMemoryMb: quotaLimitDefault,
		egressBytes: quotaLimitDefault,
	})
	.describe('Org quota; -1 is unlimited.');
export type OrgQuota = z.infer<typeof orgQuotaSchema>;

export const quotaUpdateSchema = z
	.strictObject({
		projects: quotaLimitOptional,
		storageBytes: quotaLimitOptional,
		retainedDeployments: quotaLimitOptional,
		maxUploadBytes: quotaLimitOptional,
		databases: quotaLimitOptional,
		databaseStorageBytes: quotaLimitOptional,
		storageInstances: quotaLimitOptional,
		storageObjects: quotaLimitOptional,
		appVolumes: quotaLimitOptional,
		appVolumeBytes: quotaLimitOptional,
		jobs: quotaLimitOptional,
		jobRunsPerDay: quotaLimitOptional,
		buildsPerDay: quotaLimitOptional,
		previews: quotaLimitOptional,
		workloadMemoryMb: quotaLimitOptional,
		egressBytes: quotaLimitOptional,
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to update.');
export type QuotaUpdate = z.infer<typeof quotaUpdateSchema>;

/** Per-project overrides; a missing or null field inherits the org quota. */
export const projectQuotaFieldsSchema = z.strictObject({
	projects: quotaOverride,
	storageBytes: quotaOverride,
	retainedDeployments: quotaOverride,
	maxUploadBytes: quotaOverride,
	databases: quotaOverride,
	databaseStorageBytes: quotaOverride,
	storageInstances: quotaOverride,
	storageObjects: quotaOverride,
	appVolumes: quotaOverride,
	appVolumeBytes: quotaOverride,
	jobs: quotaOverride,
	jobRunsPerDay: quotaOverride,
	buildsPerDay: quotaOverride,
	previews: quotaOverride,
	workloadMemoryMb: quotaOverride,
	egressBytes: quotaOverride,
});
export type ProjectQuotaFields = z.infer<typeof projectQuotaFieldsSchema>;

export const projectQuotaOverrideSchema = projectQuotaFieldsSchema.refine(
	(input) => Object.keys(input).length > 0,
	'Nothing to override.',
);
export type ProjectQuotaOverride = z.infer<typeof projectQuotaOverrideSchema>;

// -------------------------------------------------------------------- usage

export const quotaUsageMetricKeys = [
	'projects',
	'databases',
	'databaseStorageBytes',
	'storageInstances',
	'storageBytes',
	'storageObjects',
	'appVolumes',
	'appVolumeBytes',
	'jobs',
	'jobRunsPerDay',
	'buildsPerDay',
	'previews',
	'workloadMemoryMb',
	'egressBytes',
] as const;
export type QuotaUsageMetricKey = (typeof quotaUsageMetricKeys)[number];

export const quotaMetricUnits = ['count', 'bytes', 'megabytes'] as const;
export type QuotaMetricUnit = (typeof quotaMetricUnits)[number];

/** Display unit per metric, used by the dashboard and CSV showback. */
export const quotaMetricUnitsByKey: Record<QuotaUsageMetricKey, QuotaMetricUnit> = {
	projects: 'count',
	databases: 'count',
	databaseStorageBytes: 'bytes',
	storageInstances: 'count',
	storageBytes: 'bytes',
	storageObjects: 'count',
	appVolumes: 'count',
	appVolumeBytes: 'bytes',
	jobs: 'count',
	jobRunsPerDay: 'count',
	buildsPerDay: 'count',
	previews: 'count',
	workloadMemoryMb: 'megabytes',
	egressBytes: 'bytes',
};

/** Percentage used, or null when unlimited. May exceed 100 when a quota was lowered. */
export function quotaPercent(used: number, limit: number): number | null {
	if (limit === QUOTA_UNLIMITED) return null;
	if (limit === 0) return used === 0 ? 0 : 100;
	return Math.round((used / limit) * 1000) / 10;
}

/**
 * Resolve a project's effective quota: every non-null override replaces the org value, and a
 * missing/null field inherits it. Both `-1` and null mean unlimited in storage, so they are
 * normalised to `QUOTA_UNLIMITED` here.
 */
export function resolveQuota(base: OrgQuota, overrides: ProjectQuotaFields | null | undefined): OrgQuota {
	const resolved = { ...base };
	if (!overrides) return resolved;
	for (const field of quotaFieldNames) {
		const value = overrides[field];
		if (value !== null && value !== undefined) resolved[field] = value;
	}
	return resolved;
}

export const quotaUsageMetricSchema = z.strictObject({
	used: z.number().nonnegative(),
	/** -1 is unlimited. */
	limit: quotaLimit,
	unit: z.enum(quotaMetricUnits),
	/** Null when unlimited; otherwise `used / limit` as a percentage (not clamped). */
	percent: z.number().nonnegative().nullable(),
});
export type QuotaUsageMetric = z.infer<typeof quotaUsageMetricSchema>;

const metric = quotaUsageMetricSchema;

export const quotaUsageMetricsSchema = z
	.strictObject({
		projects: metric,
		databases: metric,
		databaseStorageBytes: metric,
		storageInstances: metric,
		storageBytes: metric,
		storageObjects: metric,
		appVolumes: metric,
		appVolumeBytes: metric,
		jobs: metric,
		jobRunsPerDay: metric,
		buildsPerDay: metric,
		previews: metric,
		workloadMemoryMb: metric,
		egressBytes: metric,
	})
	.describe('Usage for every quota metric.');
export type QuotaUsageMetrics = z.infer<typeof quotaUsageMetricsSchema>;

export const quotaWarningSchema = z.strictObject({
	metric: z.enum(quotaUsageMetricKeys),
	used: z.number().nonnegative(),
	limit: quotaLimit,
	percent: z.number().nonnegative(),
});
export type QuotaWarning = z.infer<typeof quotaWarningSchema>;

/**
 * One cached usage snapshot. `periodDays` explains the rolling counters: egress is 30-day,
 * job/build counters are the last 24 hours, and counts/bytes are current.
 */
export const quotaUsageViewSchema = z
	.strictObject({
		orgId: z.string(),
		projectId: z.string().nullable(),
		projectSlug: z.string().nullable(),
		at: z.string(),
		cachedUntil: z.string().nullable(),
		periodDays: z.number().int().positive().max(366).default(30),
		metrics: quotaUsageMetricsSchema,
		/** Metrics at or above the 80% alert threshold, deduped by the service. */
		warnings: z.array(quotaWarningSchema).max(16).default([]),
	})
	.describe('Usage view; no secret or cross-org data.');
export type QuotaUsageView = z.infer<typeof quotaUsageViewSchema>;

/** Resolved limits for one project: org base plus this project's overrides. */
export const projectQuotaViewSchema = z.strictObject({
	orgId: z.string(),
	projectId: z.string(),
	projectSlug: z.string(),
	base: orgQuotaSchema,
	overrides: projectQuotaFieldsSchema,
	effective: orgQuotaSchema,
});
export type ProjectQuotaView = z.infer<typeof projectQuotaViewSchema>;

export const quotaUsageTrendPointSchema = z.strictObject({
	/** `YYYY-MM-DD`, UTC. */
	day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
	metrics: quotaUsageMetricsSchema,
});
export type QuotaUsageTrendPoint = z.infer<typeof quotaUsageTrendPointSchema>;

/** The 30-day sparkline; the service compacts older points into daily snapshots. */
export const quotaUsageHistoryViewSchema = z.strictObject({
	orgId: z.string(),
	projectId: z.string().nullable(),
	projectSlug: z.string().nullable(),
	points: z.array(quotaUsageTrendPointSchema).max(366),
});
export type QuotaUsageHistoryView = z.infer<typeof quotaUsageHistoryViewSchema>;
