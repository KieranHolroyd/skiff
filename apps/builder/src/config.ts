/**
 * Builder configuration (D3). Everything comes from the environment so the compiled daemon can
 * be dropped into a systemd unit with an EnvironmentFile:
 *
 *   SKIFF_CONTROL_URL   control-plane origin, no trailing slash
 *   SKIFF_NODE_TOKEN    token for a node marked `can_build`
 *   SKIFF_BUILD_DIR     scratch root for clones and artifacts
 *
 * Optional: `SKIFF_GIT_TOKEN` for private HTTPS repositories (never logged), sent only to the
 * hosts in `SKIFF_GIT_TOKEN_HOSTS` (comma-separated, default `github.com`), and
 * `SKIFF_BUILDER_SYSTEMD=false` to force direct execution on a development workstation.
 *
 * On a node, `skiff-builder.service` runs `skiff-agent builder` with the agent's own
 * `/etc/skiff/agent.env`, so every enrolled node can build once an admin turns the role on (D47).
 * Builds then run as `SKIFF_BUILDER_USER` (default `skiff-build`) in a sandboxed transient unit.
 */

/** Toolchains a build can find: Skiff's own Bun first, then the system's. */
export const DEFAULT_BUILD_PATH =
	'/opt/skiff/current/runtime/bin:/opt/skiff/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface BuilderConfig {
	controlUrl: string;
	nodeToken: string;
	buildDir: string;
	/**
	 * Credential for private HTTPS repositories. It is handed to `git clone` as an HTTP header in
	 * the clone's environment, never in the URL or `.git/config`, and only for `gitTokenHosts`.
	 */
	gitToken: string | null;
	/** Hosts (`host` or `host:port`) the git token may be sent to. */
	gitTokenHosts: string[];
	pollMs: number;
	/** Run each build in a transient systemd unit; false uses a direct child process. */
	systemd: boolean;
	timeoutSeconds: number;
	memoryMax: string;
	cpuQuota: string;
	/** Account each sandboxed build runs as; null runs as the daemon's own user (development). */
	buildUser: string | null;
	/** PATH inside the build. */
	buildPath: string;
	/** How long to wait before asking again while this node does not have the Builder role. */
	idlePollMs: number;
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

/** Default: the token is for GitHub, and a repo URL elsewhere must never receive it. */
export const DEFAULT_GIT_TOKEN_HOSTS = ['github.com'];

function gitTokenHosts(value: string | undefined): string[] {
	if (value === undefined || !value.trim()) return DEFAULT_GIT_TOKEN_HOSTS;
	const hosts = value
		.split(',')
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	for (const host of hosts)
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(host))
			throw new ConfigError(`SKIFF_GIT_TOKEN_HOSTS has an invalid host "${host}"`);
	return hosts;
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
	const systemd = explicitSystemd ?? available;
	const rawUser = env.SKIFF_BUILDER_USER?.trim();
	const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
	// Only root can start a unit as another user; never run user code as root by default.
	const buildUser =
		rawUser === 'none' || rawUser === '' ? null : rawUser ?? (systemd && isRoot ? 'skiff-build' : null);
	if (buildUser && !/^[a-z_][a-z0-9_-]{0,31}$/.test(buildUser))
		throw new ConfigError('SKIFF_BUILDER_USER must be a plain system user name');
	if (buildUser && !systemd) throw new ConfigError('SKIFF_BUILDER_USER needs systemd-run (SKIFF_BUILDER_SYSTEMD)');
	if (isRoot && !buildUser)
		throw new ConfigError('Refusing to run builds as root; set SKIFF_BUILDER_USER and enable systemd-run');
	return {
		controlUrl,
		nodeToken: required(env, 'SKIFF_NODE_TOKEN'),
		buildDir: required(env, 'SKIFF_BUILD_DIR'),
		gitToken: env.SKIFF_GIT_TOKEN?.trim() || null,
		gitTokenHosts: gitTokenHosts(env.SKIFF_GIT_TOKEN_HOSTS),
		pollMs: positiveInt(env, 'SKIFF_BUILDER_POLL_MS', 5_000),
		systemd,
		timeoutSeconds: positiveInt(env, 'SKIFF_BUILDER_TIMEOUT_SECONDS', 600),
		memoryMax: env.SKIFF_BUILDER_MEMORY_MAX?.trim() || '2G',
		cpuQuota: env.SKIFF_BUILDER_CPU_QUOTA?.trim() || '200%',
		buildUser,
		buildPath: env.SKIFF_BUILDER_PATH?.trim() || DEFAULT_BUILD_PATH,
		idlePollMs: positiveInt(env, 'SKIFF_BUILDER_IDLE_POLL_MS', 30_000),
	};
}
