import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { settings } from '@yoal/db';
import {
	FEATURE_FLAGS,
	USAGE_ANALYTICS_DEFAULT_ENDPOINT,
	USAGE_ANALYTICS_INTERVAL_MS,
	USAGE_ANALYTICS_VERSION,
	usageAnalyticsSettingsSchema,
	usageCapabilityKeys,
	usageMetricKeys,
	usagePingSchema,
	usageEndpointProblem,
	type Principal,
	type UsageAnalyticsSettingsInput,
	type UsageAnalyticsView,
	type UsageArch,
	type UsageCapability,
	type UsageMetricKey,
	type UsageMetrics,
	type UsageOs,
	type UsagePing
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { featureEnabled } from './config.ts';
import { ForbiddenError, ValidationError } from './errors.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import { newId, parseJson } from './util.ts';

/**
 * Opt-in anonymous usage analytics (docs/USAGE-ANALYTICS.md, D211).
 *
 * Off until a platform owner ticks "Send anonymous usage data" in the setup wizard or in Settings.
 * When on, one ping a day reports counts (projects, deployments, nodes, databases, …), the release,
 * the OS/arch, the feature flags that are on and the optional services that are configured. It
 * never reports a hostname, address, id, name or free-form string: see the wire schema in
 * `@yoal/contracts`.
 *
 * `installId` is random, generated on this install when the setting is first turned on. It exists
 * only to count one install once; it is not derived from anything, and turning the setting off
 * stops all sending (the id is kept so a later opt-in does not look like a new install).
 *
 * Failures are recorded on the settings page and never retried in a loop: the next ping is a day
 * away, so a collector outage costs one day, not a request storm.
 */

const SETTINGS_KEY = 'usage.analytics';
const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface StoredUsageAnalytics {
	enabled: boolean;
	installId: string | null;
	/** A dashboard override; null means the default (or the environment's endpoint). */
	endpoint: string | null;
	consentedAt: number | null;
	consentedBy: string | null;
	lastAttemptAt: number | null;
	lastSentAt: number | null;
	lastError: string | null;
}

const EMPTY: StoredUsageAnalytics = {
	enabled: false,
	installId: null,
	endpoint: null,
	consentedAt: null,
	consentedBy: null,
	lastAttemptAt: null,
	lastSentAt: null,
	lastError: null
};

export interface UsageAnalyticsOptions {
	/** The control plane's release, reported as-is. */
	version: string;
}

export class UsageAnalyticsService {
	#sending = false;

	constructor(
		private readonly ctx: CoreContext,
		private readonly options: UsageAnalyticsOptions
	) {}

	// ---------------------------------------------------------------- state

	private stored(): StoredUsageAnalytics {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
		if (!row) return { ...EMPTY };
		const parsed = parseJson<Partial<StoredUsageAnalytics>>(row.value, {});
		if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY };
		return {
			enabled: parsed.enabled === true,
			installId:
				typeof parsed.installId === 'string' && /^[0-9a-f]{32}$/.test(parsed.installId)
					? parsed.installId
					: null,
			endpoint: typeof parsed.endpoint === 'string' && parsed.endpoint ? parsed.endpoint : null,
			consentedAt: typeof parsed.consentedAt === 'number' ? parsed.consentedAt : null,
			consentedBy: typeof parsed.consentedBy === 'string' ? parsed.consentedBy : null,
			lastAttemptAt: typeof parsed.lastAttemptAt === 'number' ? parsed.lastAttemptAt : null,
			lastSentAt: typeof parsed.lastSentAt === 'number' ? parsed.lastSentAt : null,
			lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null
		};
	}

	private write(next: StoredUsageAnalytics): void {
		const now = this.ctx.now();
		const value = JSON.stringify(next);
		this.ctx.db
			.insert(settings)
			.values({ key: SETTINGS_KEY, value, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
			.run();
	}

	/** The environment overrides the dashboard, so a host can pin its collector. */
	private endpoint(): { url: string; source: UsageAnalyticsView['endpointSource'] } {
		const fromEnv = process.env.YOAL_USAGE_ANALYTICS_ENDPOINT?.trim();
		if (fromEnv) return { url: fromEnv, source: 'environment' };
		const stored = this.stored().endpoint;
		if (stored) return { url: stored, source: 'setting' };
		return { url: USAGE_ANALYTICS_DEFAULT_ENDPOINT, source: 'default' };
	}

	// ---------------------------------------------------------------- access

	private assertView(principal: Principal): void {
		if (!this.ctx.platformIam.canView(principal))
			throw new ForbiddenError('Only a platform admin can see usage analytics settings.');
	}

	private assertWrite(principal: Principal): void {
		if (!this.ctx.platformIam.canAdminister(principal))
			throw new ForbiddenError('platform:settings');
	}

	// ---------------------------------------------------------------- settings surface

	view(principal: Principal): UsageAnalyticsView {
		this.assertView(principal);
		return this.buildView();
	}

	private buildView(): UsageAnalyticsView {
		const stored = this.stored();
		const endpoint = this.endpoint();
		const now = this.ctx.now();
		const due = stored.lastAttemptAt === null ? now : stored.lastAttemptAt + USAGE_ANALYTICS_INTERVAL_MS;
		const sample = this.samplePing(stored);
		return {
			enabled: stored.enabled,
			installId: stored.installId,
			endpoint: endpoint.url,
			endpointSource: endpoint.source,
			lastSentAt: stored.lastSentAt ? new Date(stored.lastSentAt).toISOString() : null,
			lastAttemptAt: stored.lastAttemptAt ? new Date(stored.lastAttemptAt).toISOString() : null,
			lastError: stored.lastError,
			nextSendAt: stored.enabled ? new Date(Math.max(due, now)).toISOString() : null,
			intervalMs: USAGE_ANALYTICS_INTERVAL_MS,
			sample,
			enabledFeatures: sample.features,
			enabledCapabilities: sample.capabilities as UsageCapability[]
		};
	}

	/** Exactly what the next ping would contain. No ids are created or stored by looking. */
	preview(principal: Principal): UsagePing {
		this.assertView(principal);
		return this.samplePing(this.stored());
	}

	/** Turn sending on or off, and optionally pin a collector endpoint. */
	setEnabled(principal: Principal, raw: UsageAnalyticsSettingsInput): UsageAnalyticsView {
		this.assertWrite(principal);
		const input = usageAnalyticsSettingsSchema.parse(raw);
		const previous = this.stored();
		let endpoint = previous.endpoint;
		if (input.endpoint !== undefined) {
			const value = input.endpoint?.trim() ?? '';
			if (value) {
				const problem = usageEndpointProblem(value);
				if (problem) throw new ValidationError(problem);
				endpoint = value;
			} else {
				endpoint = null;
			}
		}

		const now = this.ctx.now();
		const next: StoredUsageAnalytics = {
			...previous,
			enabled: input.enabled,
			endpoint,
			installId: previous.installId ?? (input.enabled ? randomBytes(16).toString('hex') : null),
			consentedAt: input.enabled ? (previous.enabled ? previous.consentedAt : now) : previous.consentedAt,
			consentedBy: input.enabled ? (previous.enabled ? previous.consentedBy : principal.userId ?? 'system') : previous.consentedBy,
			lastAttemptAt: input.enabled ? previous.lastAttemptAt : null,
			lastError: input.enabled ? previous.lastError : null
		};
		this.write(next);
		this.ctx.audit.record({
			principal,
			action: 'usage.analytics.update',
			resource: 'usage',
			args: {
				enabled: next.enabled,
				// The id itself is only used to count installs, so the audit log never needs it.
				endpoint: this.endpoint().source === 'setting' ? 'custom' : this.endpoint().source
			},
			result: 'ok'
		});
		return this.buildView();
	}

	// ---------------------------------------------------------------- sending

	/** Called by the maintenance loop every minute. Cheap when off or not due. */
	async tick(): Promise<void> {
		if (this.#sending) return;
		const stored = this.stored();
		if (!stored.enabled || !stored.installId) return;
		if (stored.lastAttemptAt !== null && this.ctx.now() - stored.lastAttemptAt < USAGE_ANALYTICS_INTERVAL_MS)
			return;
		await this.send(stored);
	}

	/** Send one ping now. Exposed for tests and a future "send a test ping" button. */
	async send(stored = this.stored()): Promise<{ sent: boolean; error: string | null }> {
		if (!stored.enabled || !stored.installId) return { sent: false, error: null };
		if (this.#sending) return { sent: false, error: null };
		this.#sending = true;
		const now = this.ctx.now();
		const endpoint = this.endpoint().url;
		const ping = this.samplePing(stored);
		let error: string | null = null;
		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(ping),
				// A slow collector must never hold the maintenance loop open.
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (!response.ok) error = `The collector answered HTTP ${response.status}.`;
			else this.ctx.audit.record({
				principal: buildSystemPrincipal('system:usage-analytics', ''),
				action: 'usage.analytics.send',
				resource: 'usage',
				args: { version: ping.version },
				result: 'ok'
			});
		} catch (caught) {
			error = (caught as Error).message.slice(0, 200);
		} finally {
			this.#sending = false;
		}

		const latest = this.stored();
		this.write({
			...latest,
			lastAttemptAt: now,
			lastSentAt: error ? latest.lastSentAt : now,
			lastError: error
		});
		if (error) console.warn(`[usage-analytics] ping failed: ${error}`);
		return { sent: error === null, error };
	}

	// ---------------------------------------------------------------- the payload

	private samplePing(stored: StoredUsageAnalytics): UsagePing {
		const now = this.ctx.now();
		return {
			v: USAGE_ANALYTICS_VERSION,
			id: newId('usage'),
			installId: stored.installId ?? '0'.repeat(32),
			sentAt: new Date(now).toISOString(),
			version: this.options.version,
			os: platformOs(),
			arch: platformArch(),
			metrics: this.metrics(now),
			features: Object.keys(FEATURE_FLAGS).filter((name) =>
				featureEnabled(this.ctx.config, name as keyof typeof FEATURE_FLAGS)
			),
			capabilities: this.capabilities()
		};
	}

	/** A `COUNT(*)`, or 0 when the table does not exist on this version. */
	private count(sql: string, ...params: Array<string | number>): number {
		try {
			const row = this.ctx.sqlite
				.query<{ count: number }, Array<string | number>>(sql)
				.get(...params);
			return Number.isFinite(row?.count) ? Math.max(0, row!.count) : 0;
		} catch {
			return 0;
		}
	}

	private metrics(now: number): UsageMetrics {
		const dayAgo30 = now - 30 * DAY_MS;
		const values: Record<UsageMetricKey, number> = {
			orgs: this.count('SELECT COUNT(*) AS count FROM organization'),
			users: this.count('SELECT COUNT(*) AS count FROM user'),
			members: this.count('SELECT COUNT(*) AS count FROM member'),
			nodes: this.count('SELECT COUNT(*) AS count FROM nodes'),
			nodesOnline: this.count("SELECT COUNT(*) AS count FROM nodes WHERE status = 'online'"),
			projects: this.count('SELECT COUNT(*) AS count FROM projects WHERE deleted_at IS NULL'),
			projectsStatic: this.count(
				"SELECT COUNT(*) AS count FROM projects WHERE deleted_at IS NULL AND COALESCE(runtime_name, runtime) = 'static'"
			),
			projectsProcess: this.count(
				"SELECT COUNT(*) AS count FROM projects WHERE deleted_at IS NULL AND COALESCE(runtime_name, runtime) = 'process'"
			),
			projectsContainer: this.count(
				"SELECT COUNT(*) AS count FROM projects WHERE deleted_at IS NULL AND COALESCE(runtime_name, runtime) = 'container'"
			),
			deployments: this.count('SELECT COUNT(*) AS count FROM deployments WHERE deleted_at IS NULL'),
			deploymentsActive: this.count(
				"SELECT COUNT(*) AS count FROM deployments WHERE deleted_at IS NULL AND status = 'active'"
			),
			deployments30d: this.count(
				'SELECT COUNT(*) AS count FROM deployments WHERE deleted_at IS NULL AND created_at >= ?',
				dayAgo30
			),
			databases: this.count('SELECT COUNT(*) AS count FROM databases WHERE deleted_at IS NULL'),
			databaseEngines: this.count(
				'SELECT COUNT(DISTINCT engine) AS count FROM databases WHERE deleted_at IS NULL'
			),
			storageInstances: this.count(
				'SELECT COUNT(*) AS count FROM storage_instances WHERE deleted_at IS NULL'
			),
			brokers: this.count('SELECT COUNT(*) AS count FROM brokers WHERE deleted_at IS NULL'),
			volumes: this.count('SELECT COUNT(*) AS count FROM app_volumes WHERE deleted_at IS NULL'),
			functions: this.count(
				"SELECT COUNT(*) AS count FROM projects WHERE deleted_at IS NULL AND COALESCE(runtime_name, runtime) = 'function'"
			),
			pipelines: this.count('SELECT COUNT(*) AS count FROM pipeline_repositories'),
			registryRepositories: this.count('SELECT COUNT(*) AS count FROM registry_repositories'),
			emailDomains: this.count('SELECT COUNT(*) AS count FROM email_domains'),
			ssoProviders: this.count('SELECT COUNT(*) AS count FROM sso_providers'),
			userPools: this.count('SELECT COUNT(*) AS count FROM user_pools WHERE disabled_at IS NULL'),
			domains: this.count('SELECT COUNT(*) AS count FROM domains'),
			shareLinks: this.count('SELECT COUNT(*) AS count FROM share_links WHERE revoked_at IS NULL'),
			accessKeys: this.count('SELECT COUNT(*) AS count FROM access_keys WHERE revoked_at IS NULL')
		};
		// The contract fixes the key set; a missing key is a bug, not something to send as null.
		for (const key of usageMetricKeys) if (values[key] === undefined) values[key] = 0;
		return values;
	}

	private capabilities(): UsageCapability[] {
		const enabled: UsageCapability[] = [];
		if (this.ctx.telemetry?.installed) enabled.push('telemetryStore');
		if (this.count('SELECT COUNT(*) AS count FROM email_domains') > 0) enabled.push('email');
		if (this.count('SELECT COUNT(*) AS count FROM backup_targets') > 0) enabled.push('backups');
		if (this.count('SELECT COUNT(*) AS count FROM github_installations') > 0) enabled.push('githubApp');
		if (this.ctx.sentry.active()) enabled.push('sentry');
		if (this.count('SELECT COUNT(*) AS count FROM log_drains WHERE enabled = 1') > 0)
			enabled.push('logDrains');
		if (this.count('SELECT COUNT(*) AS count FROM sso_providers WHERE enabled = 1') > 0)
			enabled.push('sso');
		if (this.count('SELECT COUNT(*) AS count FROM user_pools WHERE disabled_at IS NULL') > 0)
			enabled.push('userPools');
		if (this.count('SELECT COUNT(*) AS count FROM registry_repositories') > 0)
			enabled.push('registry');
		// Keep the order stable and drop anything the contract does not know (a rolled-back release).
		return usageCapabilityKeys.filter((key) => enabled.includes(key));
	}
}

function platformOs(): UsageOs {
	switch (process.platform) {
		case 'linux':
		case 'darwin':
		case 'win32':
		case 'freebsd':
			return process.platform;
		default:
			return 'other';
	}
}

function platformArch(): UsageArch {
	switch (process.arch) {
		case 'x64':
		case 'arm64':
		case 'arm':
			return process.arch;
		default:
			return 'other';
	}
}

/** The schema is the last line of defence: a ping that would break it is not sent at all. */
export function validateUsagePing(ping: UsagePing): UsagePing {
	return usagePingSchema.parse(ping);
}
