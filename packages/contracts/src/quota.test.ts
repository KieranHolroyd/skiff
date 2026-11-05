import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
	orgQuotaSchema,
	projectQuotaFieldsSchema,
	projectQuotaOverrideSchema,
	projectQuotaViewSchema,
	quotaFieldNames,
	quotaMetricUnitsByKey,
	quotaPercent,
	quotaUpdateSchema,
	quotaUsageHistoryViewSchema,
	quotaUsageMetricKeys,
	quotaUsageMetricsSchema,
	quotaUsageViewSchema,
	type QuotaUsageMetrics,
} from './quota.ts';

function metrics(used = 0, limit = -1): QuotaUsageMetrics {
	return Object.fromEntries(
		quotaUsageMetricKeys.map((key) => [
			key,
			{ used, limit, unit: quotaMetricUnitsByKey[key], percent: quotaPercent(used, limit) },
		]),
	) as QuotaUsageMetrics;
}

describe('quota schemas', () => {
	test('a fresh org quota is unlimited in every field', () => {
		const quota = orgQuotaSchema.parse({});
		expect(Object.keys(quota).sort()).toEqual([...quotaFieldNames].sort());
		expect(Object.values(quota).every((value) => value === -1)).toBe(true);
		expect(orgQuotaSchema.parse({ databases: 5, egressBytes: 0 })).toMatchObject({ databases: 5, egressBytes: 0 });
		expect(orgQuotaSchema.safeParse({ databases: -2 }).success).toBe(false);
		expect(orgQuotaSchema.safeParse({ databases: 1.5 }).success).toBe(false);
		expect(orgQuotaSchema.safeParse({ extra: 1 }).success).toBe(false);
	});

	test('updates and project overrides are partial; null inherits', () => {
		expect(quotaUpdateSchema.parse({ jobs: 10 })).toEqual({ jobs: 10 });
		expect(quotaUpdateSchema.safeParse({}).success).toBe(false);
		expect(projectQuotaOverrideSchema.parse({ previews: null })).toEqual({ previews: null });
		expect(projectQuotaOverrideSchema.parse({ appVolumes: 4 })).toEqual({ appVolumes: 4 });
		expect(projectQuotaOverrideSchema.safeParse({}).success).toBe(false);
		expect(projectQuotaFieldsSchema.parse({})).toEqual({});
	});

	test('percent is null when unlimited and can exceed 100', () => {
		expect(quotaPercent(5, 10)).toBe(50);
		expect(quotaPercent(0, -1)).toBeNull();
		expect(quotaPercent(0, 0)).toBe(0);
		expect(quotaPercent(1, 0)).toBe(100);
		expect(quotaPercent(11, 10)).toBe(110);
	});

	test('usage views carry every metric and round-trip', () => {
		const all = metrics(3, 10);
		expect(quotaUsageMetricsSchema.parse(all)).toEqual(all);
		const view: z.output<typeof quotaUsageViewSchema> = {
			orgId: 'org_1',
			projectId: null,
			projectSlug: null,
			at: '2026-11-05T00:00:00.000Z',
			cachedUntil: '2026-11-05T00:01:00.000Z',
			periodDays: 30,
			metrics: all,
			warnings: [{ metric: 'projects', used: 3, limit: 10, percent: 30 }],
		};
		const parsed = quotaUsageViewSchema.parse(view);
		expect(parsed).toEqual(view);
		expect(quotaUsageViewSchema.parse(parsed)).toEqual(parsed);
		expect(quotaUsageViewSchema.safeParse({ ...view, metrics: { projects: { used: 1, limit: 1, unit: 'count', percent: 100 } } }).success).toBe(
			false,
		);
	});

	test('project quota view shows base, overrides and effective limits', () => {
		const base = orgQuotaSchema.parse({ databases: 5 });
		const view = {
			orgId: 'org_1',
			projectId: 'prj_1',
			projectSlug: 'my-app',
			base,
			overrides: { databases: 10, previews: null },
			effective: orgQuotaSchema.parse({ databases: 10 }),
		};
		expect(projectQuotaViewSchema.parse(view)).toEqual(view);
	});

	test('history points round-trip', () => {
		const view = {
			orgId: 'org_1',
			projectId: 'prj_1',
			projectSlug: 'my-app',
			points: [{ day: '2026-11-05', metrics: metrics() }],
		};
		expect(quotaUsageHistoryViewSchema.parse(view)).toEqual(view);
		expect(
			quotaUsageHistoryViewSchema.safeParse({ ...view, points: [{ day: '05/11/2026', metrics: metrics() }] }).success,
		).toBe(false);
	});
});
