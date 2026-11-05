import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { building } from '$app/env';
import { parseFeatureFlags } from '@skiff/contracts';
import { isSharedDomain } from './domains';
import { loadLocalSettings } from './local-settings';

// Runtime config comes from the process environment (systemd EnvironmentFile / credentials in production).
const env = process.env;
// Dev servers only: settings saved from Settings → Backups / Notifications (.data/platform-settings.json).
loadLocalSettings(env);

function required(name: string, devDefault?: string): string {
	// SvelteKit evaluates server modules while analysing the build; real values are only needed at runtime.
	if (building) return devDefault ?? `__build_placeholder_${name}__`;
	const value = env[name] ?? (env.NODE_ENV !== 'production' ? devDefault : undefined);
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

/** Public origin of the platform domain (dashboard, API, MCP, auth). */
export const platformOrigin = required('SKIFF_PLATFORM_ORIGIN', 'http://localhost:5173').replace(
	/\/$/,
	''
);

/** Domain deployed sites are served from (D34: `kierancloud.dev`). */
export const contentDomain = required('SKIFF_CONTENT_DOMAIN', 'localhost');

/**
 * Shared-domain mode (DESIGN §5, D19): content is same-site with the dashboard, so the dashboard
 * shows a persistent warning. One definition for the dashboard and the setup status endpoint.
 */
export const sharedDomain = (() => {
	try {
		return isSharedDomain(new URL(platformOrigin).hostname, contentDomain);
	} catch {
		return false; // build-time placeholders
	}
})();

/** Canonical MCP protected-resource URL; tokens are audience-bound to it. */
export const mcpResource = `${platformOrigin}/mcp`;

export const dataDir = required('SKIFF_DATA_DIR', '.data');

export const authSecret = required(
	'BETTER_AUTH_SECRET',
	'dev-only-insecure-secret-change-me-0123456789'
);

/**
 * Email+password sign-in is NOT part of Skiff's auth design (passkeys + GitHub only, D10).
 * It exists solely so local development and automated tests can sign in headlessly.
 * Refused in production.
 */
export const devPasswordLogin = env.SKIFF_DEV_PASSWORD_LOGIN === '1';
if (devPasswordLogin && env.NODE_ENV === 'production')
	throw new Error('SKIFF_DEV_PASSWORD_LOGIN must not be enabled in production');

/** Allow legacy Dynamic Client Registration alongside CIMD for older MCP clients. */
export const allowDcr = (env.SKIFF_MCP_ALLOW_DCR ?? '1') === '1';

export const github =
	env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
		? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
		: undefined;

export const smtp = env.SKIFF_SMTP_HOST
	? {
			host: env.SKIFF_SMTP_HOST,
			port: Number(env.SKIFF_SMTP_PORT ?? 587),
			user: env.SKIFF_SMTP_USER ?? '',
			password: env.SKIFF_SMTP_PASSWORD ?? '',
			from: env.SKIFF_SMTP_FROM ?? `Skiff <noreply@${contentDomain}>`,
			secure: env.SKIFF_SMTP_SECURE === '1'
		}
	: undefined;

export const objectStoreKind = (env.SKIFF_OBJECT_STORE ?? 'local') as 'local' | 'r2';
export const objectStoreSecret =
	env.SKIFF_OBJECT_STORE_SECRET ?? env.BETTER_AUTH_SECRET ?? 'dev-object-store-secret-change-me';
export const siteCookieSecret =
	env.SKIFF_SITE_COOKIE_SECRET ?? env.BETTER_AUTH_SECRET ?? 'dev-site-cookie-secret-change-me';

/** 32-byte master key for envelope encryption; systemd-creds supplies this in production. */
const masterKeySource =
	env.SKIFF_MASTER_KEY ??
	(env.SKIFF_MASTER_KEY_FILE ? readFileSync(env.SKIFF_MASTER_KEY_FILE, 'utf8').trim() : undefined);
export const masterKey: Uint8Array = masterKeySource
	? Buffer.from(masterKeySource, 'base64')
	: createHash('sha256').update(`dev-master:${authSecret}`).digest();
if (masterKey.byteLength !== 32) throw new Error('SKIFF_MASTER_KEY must be 32 bytes (base64).');

export const edgeNodeId = env.SKIFF_EDGE_NODE_ID || undefined;
export const agentVersion = env.SKIFF_AGENT_VERSION ?? '0.1.0';
export const webhookUrl = env.SKIFF_ALERT_WEBHOOK;
export const alertEmail = env.SKIFF_ALERT_EMAIL;

/** Escape hatch for local development; production is invite-only (D10). */
export const openSignup = env.SKIFF_OPEN_SIGNUP === '1' || devPasswordLogin;

/**
 * Feature flags read once at startup from `SKIFF_FEATURE_*` (docs/OPS.md §2.5). The same resolved
 * values are exposed by `/api/setup/status`; secrets are never involved.
 */
export const features = parseFeatureFlags(env);

export const r2 =
	objectStoreKind === 'r2'
		? {
				accountId: required('R2_ACCOUNT_ID'),
				bucket: required('R2_BUCKET'),
				accessKeyId: required('R2_ACCESS_KEY_ID'),
				secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
				endpoint: env.R2_ENDPOINT
			}
		: undefined;
