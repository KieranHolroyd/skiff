import { eq } from 'drizzle-orm';
import { settings } from '@yoal/db';
import {
	sentryDsnProblem,
	sentrySettingsInputSchema,
	type Principal,
	type SentrySettingsView,
	type SentrySettingsInput
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ForbiddenError, ValidationError } from './errors.ts';
import { parseJson } from './util.ts';

/**
 * Optional Sentry forwarding for the control plane's own errors (docs/SERVER-ERRORS.md §6, D171).
 *
 * The built-in tracker is always the source of truth; this service only stores and validates the
 * destination an operator enters under Settings → Server errors. The SDK lives in the control
 * plane (`lib/server/sentry.ts`), which reads `config()` and forwards every captured error. No
 * request path calls Sentry directly, so a Sentry outage never affects the dashboard.
 *
 * The auth token is sealed with the platform data key and `view()` never returns it. Reads need
 * platform read; writes need platform administration (config) or maintenance (the same people who
 * can already resolve or delete error issues).
 */

const SETTINGS_KEY = 'sentry.config';
/** Sentinel org id for secrets that belong to the install rather than an organisation. */
const PLATFORM_KEY_ORG = 'platform';

interface StoredSentry {
	enabled: boolean;
	dsn: string | null;
	environment: string;
	release: string | null;
	tracesSampleRate: number;
	sendDefaultPii: boolean;
	organizationSlug: string | null;
	projectSlug: string | null;
	authTokenSealed: string | null;
	updatedAt: number;
	updatedBy: string;
}

/** The full config, including the opened auth token; for the control plane's Sentry bridge only. */
export interface SentryConfig {
	enabled: boolean;
	dsn: string | null;
	environment: string;
	release: string | null;
	tracesSampleRate: number;
	sendDefaultPii: boolean;
	organizationSlug: string | null;
	projectSlug: string | null;
	authToken: string | null;
	updatedAt: number;
	updatedBy: string;
}

export class SentryService {
	constructor(private readonly ctx: CoreContext) {}

	/** Stored config without the token; `null` until an operator saves it once. */
	private stored(): StoredSentry | null {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
		if (!row) return null;
		const parsed = parseJson<Partial<StoredSentry> | null>(row.value, null);
		if (!parsed || typeof parsed !== 'object' || typeof parsed.enabled !== 'boolean') return null;
		return {
			enabled: parsed.enabled,
			dsn: typeof parsed.dsn === 'string' ? parsed.dsn : null,
			environment: typeof parsed.environment === 'string' ? parsed.environment : 'production',
			release: typeof parsed.release === 'string' ? parsed.release : null,
			tracesSampleRate: typeof parsed.tracesSampleRate === 'number' ? parsed.tracesSampleRate : 0,
			sendDefaultPii: parsed.sendDefaultPii === true,
			organizationSlug:
				typeof parsed.organizationSlug === 'string' ? parsed.organizationSlug : null,
			projectSlug: typeof parsed.projectSlug === 'string' ? parsed.projectSlug : null,
			authTokenSealed:
				typeof parsed.authTokenSealed === 'string' ? parsed.authTokenSealed : null,
			updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
			updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : 'system'
		};
	}

	/**
	 * Config for the SDK, with the auth token opened. `null` when nothing is saved. Never throws:
	 * a sealed token that cannot be opened (a rotated master key) becomes `null`, so events still
	 * go out.
	 */
	config(): SentryConfig | null {
		const stored = this.stored();
		if (!stored) return null;
		let authToken: string | null = null;
		if (stored.authTokenSealed) {
			try {
				authToken = this.ctx.secrets.open(PLATFORM_KEY_ORG, stored.authTokenSealed);
			} catch {
				authToken = null;
			}
		}
		return {
			enabled: stored.enabled,
			dsn: stored.dsn,
			environment: stored.environment,
			release: stored.release,
			tracesSampleRate: stored.tracesSampleRate,
			sendDefaultPii: stored.sendDefaultPii,
			organizationSlug: stored.organizationSlug,
			projectSlug: stored.projectSlug,
			authToken,
			updatedAt: stored.updatedAt,
			updatedBy: stored.updatedBy
		};
	}

	/** Whether a complete destination is saved and switched on. */
	active(): boolean {
		const config = this.config();
		return Boolean(config?.enabled && config.dsn);
	}

	view(principal: Principal): SentrySettingsView {
		this.assertRead(principal);
		return this.buildView();
	}

	private buildView(): SentrySettingsView {
		const stored = this.stored();
		let authTokenHint: string | null = null;
		if (stored?.authTokenSealed) {
			try {
				const token = this.ctx.secrets.open(PLATFORM_KEY_ORG, stored.authTokenSealed);
				authTokenHint = token.length > 4 ? `…${token.slice(-4)}` : '…';
			} catch {
				authTokenHint = 'unreadable';
			}
		}
		return {
			enabled: stored?.enabled ?? false,
			dsn: stored?.dsn ?? null,
			environment: stored?.environment ?? 'production',
			release: stored?.release ?? null,
			tracesSampleRate: stored?.tracesSampleRate ?? 0,
			sendDefaultPii: stored?.sendDefaultPii ?? false,
			organizationSlug: stored?.organizationSlug ?? null,
			projectSlug: stored?.projectSlug ?? null,
			hasAuthToken: Boolean(stored?.authTokenSealed),
			authTokenHint,
			releaseReady: Boolean(
				stored?.authTokenSealed && stored.organizationSlug && stored.projectSlug
			),
			updatedAt: stored?.updatedAt ? new Date(stored.updatedAt).toISOString() : null,
			updatedBy: stored?.updatedBy ?? null
		};
	}

	/** Save the destination. Turning forwarding on requires a valid DSN. */
	save(principal: Principal, raw: SentrySettingsInput): SentrySettingsView {
		this.assertWrite(principal);
		const rate = raw.tracesSampleRate;
		if (rate !== undefined && (!Number.isFinite(rate) || rate < 0 || rate > 1))
			throw new ValidationError('The performance sample rate must be between 0 and 1.');
		const input = sentrySettingsInputSchema.parse(raw);
		const dsn = input.dsn?.trim() ? input.dsn.trim() : null;
		if (input.enabled && !dsn)
			throw new ValidationError(
				'Add a Sentry DSN before turning error reporting on. You can save a DSN with it off.'
			);
		if (dsn) {
			const problem = sentryDsnProblem(dsn);
			if (problem) throw new ValidationError(problem);
		}

		const previous = this.stored();
		let authTokenSealed = previous?.authTokenSealed ?? null;
		if (input.clearAuthToken) authTokenSealed = null;
		else if (input.authToken) authTokenSealed = this.seal(input.authToken);

		const now = this.ctx.now();
		const stored: StoredSentry = {
			enabled: input.enabled,
			dsn,
			environment: input.environment,
			release: input.release?.trim() ? input.release.trim() : null,
			tracesSampleRate: input.tracesSampleRate,
			sendDefaultPii: input.sendDefaultPii,
			organizationSlug: input.organizationSlug?.trim() ? input.organizationSlug.trim() : null,
			projectSlug: input.projectSlug?.trim() ? input.projectSlug.trim() : null,
			authTokenSealed,
			updatedAt: now,
			updatedBy: principal.userId
		};
		const value = JSON.stringify(stored);
		this.ctx.db
			.insert(settings)
			.values({ key: SETTINGS_KEY, value, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
			.run();
		this.ctx.audit.record({
			principal,
			action: 'sentry.config.update',
			resource: 'sentry',
			args: {
				enabled: stored.enabled,
				dsnHost: dsn ? safeHost(dsn) : null,
				environment: stored.environment,
				release: stored.release,
				tracesSampleRate: stored.tracesSampleRate,
				// Never record the token, the DSN key, or the DSN path.
				authToken: stored.authTokenSealed ? 'set' : 'unset'
			},
			result: 'ok'
		});
		return this.buildView();
	}

	private seal(value: string): string {
		return this.ctx.secrets.seal(PLATFORM_KEY_ORG, value);
	}

	private assertRead(principal: Principal): void {
		if (this.ctx.platformIam.allows(principal, 'platform:read')) return;
		throw new ForbiddenError('platform:read', 'Sentry settings are platform-wide.');
	}

	private assertWrite(principal: Principal): void {
		if (
			this.ctx.platformIam.canAdminister(principal) ||
			this.ctx.platformIam.canMaintain(principal)
		)
			return;
		throw new ForbiddenError('platform:settings', 'Only a platform admin can configure Sentry.');
	}
}

/** The DSN's host for audit; keeps the public key and project id out of the log. */
function safeHost(dsn: string): string | null {
	try {
		return new URL(dsn).host;
	} catch {
		return null;
	}
}
