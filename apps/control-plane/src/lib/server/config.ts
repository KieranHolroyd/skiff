import { building } from '$app/env';

// Runtime config comes from the process environment (systemd EnvironmentFile / credentials in production).
const env = process.env;

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
	'',
);

/** Canonical MCP protected-resource URL; tokens are audience-bound to it. */
export const mcpResource = `${platformOrigin}/mcp`;

export const dataDir = required('SKIFF_DATA_DIR', '.data');

export const authSecret = required(
	'BETTER_AUTH_SECRET',
	'dev-only-insecure-secret-change-me-0123456789',
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
