import * as z from 'zod';

/**
 * Optional Sentry forwarding for the control plane's own errors (docs/SERVER-ERRORS.md §6).
 *
 * The built-in tracker always records locally; Sentry is a second destination an operator turns on
 * from Settings → Server errors. Nothing here is needed for the dashboard to work, and an install
 * with no DSN never talks to Sentry.
 *
 * A DSN is the minimum. The auth token is optional and only used to create a Sentry release on
 * boot (it needs the organisation and project slugs); events themselves are sent with the DSN.
 */

export const sentryDsnMaxLength = 500;
export const sentryAuthTokenMaxLength = 500;
export const sentryEnvironmentMaxLength = 64;
export const sentryReleaseMaxLength = 100;
export const sentrySlugMaxLength = 100;

/** Sentry DSNs are `<scheme>://<public key>@<host>[:port]/<project id>`. */
export function sentryDsnProblem(dsn: string): string | null {
	let url: URL;
	try {
		url = new URL(dsn.trim());
	} catch {
		return 'Enter the DSN from your Sentry project (it looks like https://key@o123.ingest.sentry.io/456).';
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		return 'The DSN must use https:// (or http:// for a Sentry instance on your own network).';
	if (!url.username) return 'The DSN is missing its public key.';
	if (!url.pathname || url.pathname === '/') return 'The DSN is missing its project id.';
	return null;
}

export const sentrySettingsInputSchema = z.object({
	enabled: z.boolean().default(false),
	dsn: z.string().trim().max(sentryDsnMaxLength).nullable().optional(),
	environment: z
		.string()
		.trim()
		.min(1)
		.max(sentryEnvironmentMaxLength)
		.default('production'),
	release: z.string().trim().max(sentryReleaseMaxLength).nullable().optional(),
	tracesSampleRate: z.number().min(0).max(1).default(0),
	/** Add IP addresses, cookies and request headers Sentry would otherwise drop. Off by default. */
	sendDefaultPii: z.boolean().default(false),
	/** Only travels one way: it is sealed before it is stored and never returned to the browser. */
	authToken: z.string().trim().max(sentryAuthTokenMaxLength).optional(),
	clearAuthToken: z.boolean().default(false),
	/** Sentry organisation and project slugs, used only for release creation. */
	organizationSlug: z.string().trim().max(sentrySlugMaxLength).nullable().optional(),
	projectSlug: z.string().trim().max(sentrySlugMaxLength).nullable().optional()
});

export type SentrySettingsInput = z.input<typeof sentrySettingsInputSchema>;
export type ParsedSentrySettingsInput = z.infer<typeof sentrySettingsInputSchema>;

export interface SentrySettingsView {
	/** Whether forwarding is on. A saved DSN with this off is kept for later. */
	enabled: boolean;
	/** The DSN, as typed. It is not a session secret, but only platform admins see this view. */
	dsn: string | null;
	environment: string;
	release: string | null;
	tracesSampleRate: number;
	sendDefaultPii: boolean;
	organizationSlug: string | null;
	projectSlug: string | null;
	hasAuthToken: boolean;
	/** Last four characters of the auth token, so an operator can tell which one is stored. */
	authTokenHint: string | null;
	/** A release can only be created with a token and both slugs. */
	releaseReady: boolean;
	updatedAt: string | null;
	updatedBy: string | null;
}

/** What the running process is doing right now, filled in by the control plane's bridge. */
export interface SentryRuntimeStatus {
	/** The SDK is initialised and forwarding. */
	active: boolean;
	/** Events handed to Sentry since this process started. */
	eventsSent: number;
	lastEventAt: string | null;
	lastError: string | null;
}
