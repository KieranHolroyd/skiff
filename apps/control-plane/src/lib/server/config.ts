import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { building } from '$app/env';
import { parseFeatureFlags, retiredFeatureFlagsSet } from '@skiff/contracts';
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

/** Domain deployed sites are served from (D34: `examplecloud.com`). */
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
 * Development/test mode: open sign-up (including public email+password sign-up) and no owner
 * second factor, so local development and the e2e suites can sign in headlessly. Password sign-in
 * itself is always available (D103). Refused in production.
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

/**
 * Where the control plane reaches the edge's internal S3 gateway (D82). Defaults to
 * `http://127.0.0.1:8081`; `SKIFF_STORAGE_GATEWAY_URL` is for a dev control plane that does not share
 * a host with the edge Caddy (point it at a node's Caddy listener).
 */
export const storageGatewayPort = Number(env.SKIFF_STORAGE_GATEWAY_PORT) || undefined;
export const storageGatewayUrl = env.SKIFF_STORAGE_GATEWAY_URL?.replace(/\/+$/, '') || undefined;
export const webhookUrl = env.SKIFF_ALERT_WEBHOOK;
export const alertEmail = env.SKIFF_ALERT_EMAIL;

/**
 * The installer's one-time setup token (docs/OPS.md §2.1, D102). Unset in development: the control
 * plane then keeps its own token in the data directory (see setup.ts).
 */
export const setupTokenFile =
	env.SKIFF_SETUP_TOKEN_FILE ??
	(env.NODE_ENV === 'production' ? '/etc/skiff/setup-token' : undefined);

/** Escape hatch for local development; production is invite-only (D10). */
export const openSignup = env.SKIFF_OPEN_SIGNUP === '1' || devPasswordLogin;

/**
 * Feature flags read once at startup from `SKIFF_FEATURE_*` (docs/OPS.md §2.5). The same resolved
 * values are exposed by `/api/setup/status`; secrets are never involved.
 */
export const features = parseFeatureFlags(env);

// A retired flag (for example SKIFF_FEATURE_DB_CONSOLE after D96) is ignored; say so once.
if (!building) {
	for (const flag of retiredFeatureFlagsSet(env))
		console.warn(`[config] ${flag.env} is no longer used and is ignored. ${flag.reason}`);
}

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

/**
 * The optional ClickHouse telemetry store (D101, docs/OPS.md §3.6). Installing it (installer
 * prompt, or Settings → Telemetry) writes these to skiff.env; without them telemetry reports "not
 * installed". A dev server uses `bun run dev:clickhouse` (127.0.0.1:18123, fixed dev passwords)
 * once that has created `.data/clickhouse`, so a plain dev server stays as light as a default host.
 */
const devClickHouse =
	env.NODE_ENV !== 'production' &&
	!env.SKIFF_CLICKHOUSE_URL &&
	existsSync(join(dataDir, 'clickhouse'));
export const clickhouseEnv: Record<string, string | undefined> = devClickHouse
	? {
			SKIFF_CLICKHOUSE_URL: 'http://127.0.0.1:18123',
			SKIFF_CLICKHOUSE_USER: 'skiff',
			SKIFF_CLICKHOUSE_PASSWORD: 'skiff-dev',
			SKIFF_CLICKHOUSE_READER_USER: 'skiff_reader',
			SKIFF_CLICKHOUSE_READER_PASSWORD: 'skiff-dev-reader',
			SKIFF_CLICKHOUSE_DATABASE: 'skiff'
		}
	: env;
