import { z } from 'zod';

/**
 * Prometheus export settings (docs/METRICS.md). Platform-wide performance knobs for `/metrics` and
 * its scoped sub-paths, stored in the `settings` table under `metrics_export` and changed by the
 * owner in Settings → Metrics. Every field has a default, so a missing or stale row still parses.
 */

/** The sections a scrape can ask for: `/metrics/<section>[/<name>]`. */
export const metricsSections = ['usage', 'apps', 'traffic', 'databases', 'storage', 'volumes', 'platform'] as const;
export type MetricsSection = (typeof metricsSections)[number];

export const METRICS_EXPORT_SETTINGS_KEY = 'metrics_export';

const metricsSectionsSchema = z.object({
	usage: z.boolean().default(true),
	apps: z.boolean().default(true),
	/** Per-project traffic from ClickHouse (the most expensive part of an app scrape). */
	traffic: z.boolean().default(true),
	databases: z.boolean().default(true),
	storage: z.boolean().default(true),
	volumes: z.boolean().default(true),
	platform: z.boolean().default(true),
});

export const metricsExportSettingsSchema = z.object({
	/** Serve the fleet summary on an unauthenticated `GET /metrics` (the pre-token behaviour). */
	publicPlatform: z.boolean().default(true),
	/** Reuse a rendered scrape for this long; concurrent scrapes of the same scope share one render. */
	cacheSeconds: z.number().int().min(0).max(300).default(15),
	/** Most projects one aggregate scrape renders (`/metrics`, `/metrics/apps`); per-app paths are uncapped. */
	maxApps: z.number().int().min(1).max(10_000).default(500),
	/** Turn whole sections off; a disabled section is skipped in `/metrics` and 404s on its own path. */
	sections: metricsSectionsSchema.prefault({}),
});

export type MetricsExportSettings = z.infer<typeof metricsExportSettingsSchema>;

export const metricsExportSettingsUpdateSchema = z
	.object({
		publicPlatform: z.boolean(),
		cacheSeconds: z.number().int().min(0).max(300),
		maxApps: z.number().int().min(1).max(10_000),
		sections: z.object({
			usage: z.boolean(),
			apps: z.boolean(),
			traffic: z.boolean(),
			databases: z.boolean(),
			storage: z.boolean(),
			volumes: z.boolean(),
			platform: z.boolean(),
		}).partial(),
	})
	.partial()
	.strict();
export type MetricsExportSettingsUpdate = z.infer<typeof metricsExportSettingsUpdateSchema>;

export const METRICS_EXPORT_DEFAULTS: MetricsExportSettings = metricsExportSettingsSchema.parse({});
