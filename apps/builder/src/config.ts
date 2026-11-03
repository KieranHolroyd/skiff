/**
 * Builder configuration (D3). Everything comes from the environment so the compiled daemon can
 * be dropped into a systemd unit with an EnvironmentFile:
 *
 *   SKIFF_CONTROL_URL   control-plane origin, no trailing slash
 *   SKIFF_NODE_TOKEN    token for a node marked `can_build`
 *   SKIFF_BUILD_DIR     scratch root for clones and artifacts
 *
 * Optional: `SKIFF_GIT_TOKEN` for private HTTPS repositories (never logged), and
 * `SKIFF_BUILDER_SYSTEMD=false` to force direct execution on a development workstation.
 */

export interface BuilderConfig {
	controlUrl: string;
	nodeToken: string;
	buildDir: string;
	/** Used as the password in an HTTPS clone URL when set. */
	gitToken: string | null;
	pollMs: number;
	/** Run each build in a transient systemd unit; false uses a direct child process. */
	systemd: boolean;
	timeoutSeconds: number;
	memoryMax: string;
	cpuQuota: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
	return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${name} must be a positive number`);
	return Math.floor(value);
}

function truthy(value: string | undefined): boolean | null {
	if (value === undefined) return null;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	throw new ConfigError('SKIFF_BUILDER_SYSTEMD must be true or false');
}

export function loadConfig(env: Env = process.env): BuilderConfig {
	const controlUrl = required(env, 'SKIFF_CONTROL_URL').replace(/\/+$/, '');
	let parsed: URL;
	try {
		parsed = new URL(controlUrl);
	} catch {
		throw new ConfigError('SKIFF_CONTROL_URL must be an absolute URL');
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
		throw new ConfigError('SKIFF_CONTROL_URL must use http or https');

	const explicitSystemd = truthy(env.SKIFF_BUILDER_SYSTEMD);
	const available = process.platform === 'linux' && Boolean(Bun.which('systemd-run'));
	return {
		controlUrl,
		nodeToken: required(env, 'SKIFF_NODE_TOKEN'),
		buildDir: required(env, 'SKIFF_BUILD_DIR'),
		gitToken: env.SKIFF_GIT_TOKEN?.trim() || null,
		pollMs: positiveInt(env, 'SKIFF_BUILDER_POLL_MS', 5_000),
		systemd: explicitSystemd ?? available,
		timeoutSeconds: positiveInt(env, 'SKIFF_BUILDER_TIMEOUT_SECONDS', 600),
		memoryMax: env.SKIFF_BUILDER_MEMORY_MAX?.trim() || '2G',
		cpuQuota: env.SKIFF_BUILDER_CPU_QUOTA?.trim() || '200%',
	};
}
