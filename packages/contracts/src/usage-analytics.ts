import * as z from 'zod';
import { FEATURE_FLAGS } from './features.ts';

/**
 * Anonymous usage analytics (docs/USAGE-ANALYTICS.md, D211).
 *
 * A self-hosted Yoal install sends one small ping a day to a collector the operator can see the
 * source of: this repo. Nothing is sent until the platform owner ticks "Send anonymous usage data"
 * during setup or in Settings, and turning it off stops the sender immediately.
 *
 * The wire format is deliberately narrow and fixed. There is no free-form field, no hostname, no
 * address, no organisation, user or project name, and no ids except a random `installId` this
 * install generates for itself. The collector refuses anything outside this schema, so a field
 * added by accident cannot leak.
 */

/** Protocol version. A collector refuses versions it does not know. */
export const USAGE_ANALYTICS_VERSION = 1;

/** Where pings go unless the operator overrides `YOAL_USAGE_ANALYTICS_ENDPOINT`. */
export const USAGE_ANALYTICS_DEFAULT_ENDPOINT =
	'https://yoal-analytics-engine.kierancloud.dev/api/v1/ping';

/** The collector's ingest path. */
export const USAGE_ANALYTICS_INGEST_PATH = '/api/v1/ping';

/** One ping a day; the sender tracks the last success and never bursts to catch up. */
export const USAGE_ANALYTICS_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** A ping is a few hundred bytes; the cap protects the collector from anything else. */
export const USAGE_ANALYTICS_MAX_BODY_BYTES = 32 * 1024;

/** The largest count a metric may carry (a sanity bound, not a quota). */
export const USAGE_METRIC_MAX = 1_000_000_000;

/** Numeric facts. Every one is a count, never a name or an address. */
export const usageMetricKeys = [
	'orgs',
	'users',
	'members',
	'nodes',
	'nodesOnline',
	'projects',
	'projectsStatic',
	'projectsProcess',
	'projectsContainer',
	'deployments',
	'deploymentsActive',
	'deployments30d',
	'databases',
	'databaseEngines',
	'storageInstances',
	'brokers',
	'volumes',
	'functions',
	'pipelines',
	'registryRepositories',
	'emailDomains',
	'ssoProviders',
	'userPools',
	'domains',
	'shareLinks',
	'accessKeys'
] as const;

export type UsageMetricKey = (typeof usageMetricKeys)[number];
export type UsageMetrics = Record<UsageMetricKey, number>;

/** Feature flags that are switched on (`YOAL_FEATURE_<NAME>`). */
export const usageFeatureNames = Object.keys(FEATURE_FLAGS) as Array<keyof typeof FEATURE_FLAGS>;

/**
 * Platform services an install has actually configured. A boolean per service, so "which optional
 * parts do people turn on" is answerable without inferring it from counts.
 */
export const usageCapabilityKeys = [
	/** The optional ClickHouse telemetry store (Settings → Telemetry). */
	'telemetryStore',
	/** Outbound email through Yoal's own MTA. */
	'email',
	/** Platform backups to an object store. */
	'backups',
	/** The Yoal GitHub App. */
	'githubApp',
	/** Sentry forwarding for the control plane's own errors. */
	'sentry',
	/** At least one log drain. */
	'logDrains',
	/** At least one SSO provider. */
	'sso',
	/** At least one user pool. */
	'userPools',
	/** The container registry. */
	'registry'
] as const;

export type UsageCapability = (typeof usageCapabilityKeys)[number];

export const usageOsNames = ['linux', 'darwin', 'win32', 'freebsd', 'other'] as const;
export type UsageOs = (typeof usageOsNames)[number];

export const usageArchNames = ['x64', 'arm64', 'arm', 'other'] as const;
export type UsageArch = (typeof usageArchNames)[number];

export const installIdLength = 32;

/** A random 128-bit hex id, generated once when record is switched on. */
export const installIdPattern = /^[0-9a-f]{32}$/;

export const usageMetricsSchema = z.object(
	Object.fromEntries(
		usageMetricKeys.map((key) => [
			key,
			z.number().int().min(0).max(USAGE_METRIC_MAX).default(0)
		])
	) as Record<UsageMetricKey, z.ZodDefault<z.ZodNumber>>
);

export const usagePingSchema = z
	.object({
		v: z.literal(USAGE_ANALYTICS_VERSION),
		/** Per-ping id, so a retried POST is stored once. */
		id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
		installId: z.string().regex(installIdPattern),
		sentAt: z.string().datetime({ offset: true }),
		/** The Yoal release, for example `0.4.2`. */
		version: z.string().trim().min(1).max(40),
		os: z.enum(usageOsNames),
		arch: z.enum(usageArchNames),
		metrics: usageMetricsSchema,
		/** Only the flags that are on. */
		features: z.array(z.enum(usageFeatureNames as [string, ...string[]])).max(64).default([]),
		/** Only the capabilities that are configured. */
		capabilities: z
			.array(z.enum(usageCapabilityKeys as unknown as [string, ...string[]]))
			.max(32)
			.default([])
	})
	.strict();

export type UsagePing = z.infer<typeof usagePingSchema>;

/** What an operator may change from the dashboard. */
export const usageAnalyticsSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	/** Empty means the built-in endpoint. Must be an absolute http(s) URL. */
	endpoint: z
		.string()
		.trim()
		.max(300)
		.refine((value) => value === '' || usageEndpointProblem(value) === null, {
			message: 'Enter an absolute http(s) URL, such as https://usage.example.com/api/v1/ping.'
		})
		.nullable()
		.optional()
});

export type UsageAnalyticsSettingsInput = z.input<typeof usageAnalyticsSettingsSchema>;

export function usageEndpointProblem(endpoint: string): string | null {
	let url: URL;
	try {
		url = new URL(endpoint.trim());
	} catch {
		return 'Enter an absolute URL, such as https://usage.example.com/api/v1/ping.';
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		return 'The endpoint must use https:// (http:// is accepted only for a collector on your own network).';
	if (url.username || url.password) return 'The endpoint must not carry credentials.';
	return null;
}

/** What Settings → Usage analytics and the setup wizard show. */
export interface UsageAnalyticsView {
	/** Off until the platform owner turns it on. */
	enabled: boolean;
	/** The random id this install sends; null until it is first enabled. */
	installId: string | null;
	/** The endpoint in use, and whether it came from the environment rather than the dashboard. */
	endpoint: string;
	endpointSource: 'default' | 'environment' | 'setting';
	/** ISO timestamps, or null when nothing has been sent yet. */
	lastSentAt: string | null;
	lastAttemptAt: string | null;
	lastError: string | null;
	/** When the next ping is due while off or waiting; null when nothing is scheduled. */
	nextSendAt: string | null;
	intervalMs: number;
	/** Exactly what the next ping would contain, so the page can show it before enabling. */
	sample: UsagePing;
	enabledFeatures: string[];
	enabledCapabilities: UsageCapability[];
}
