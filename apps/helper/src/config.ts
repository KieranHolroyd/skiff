import { readFileSync } from 'node:fs';
import { BUILD_VERSION } from './build-version.ts';
import { assertAbsolutePath } from './validate.ts';

/**
 * Helper configuration. Everything is an environment variable so the root unit can ship a fixed
 * `EnvironmentFile=` and the binary stays position-independent.
 */

export interface HelperConfig {
	/** Root-only unix socket the agent connects to. */
	socketPath: string;
	/** Where generated unit files are written (systemd's unit directory). */
	unitDir: string;
	/**
	 * Where Quadlet `.container` / `.network` files are written. Quadlet's generator only reads
	 * /etc/containers/systemd (and /run, /usr/share variants), never systemd's unit directory.
	 */
	quadletDir: string;
	/** Root-owned runtime directory: env files, secret files and workload sockets. */
	runtimeDir: string;
	/** Persistent container data root. */
	stateDir: string;
	/** Release roots to probe, in order. The agent's cache and /srv/skiff may differ. */
	releaseDirs: string[];
	/** Absolute bun used for the default `bun run start` process command. */
	bunPath: string;
	systemctlPath: string;
	/** Absolute journalctl used to drain workload stdout/stderr for the agent. */
	journalctlPath: string;
	/** Absolute podman used for fixed database dump/restore verbs. */
	podmanPath: string;
	/** Absolute openssl used to generate per-database TLS certificates (DB_TLS). */
	opensslPath: string;
	/**
	 * AppArmor profile applied to container workloads, or null for the runtime default.
	 * `auto` selects `unconfined` only on hosts where the kernel stacks unprivileged profile
	 * changes; the stock profile then denies a container's own processes signals (see units.ts).
	 */
	apparmorProfile: string | null;
	/** Socket file mode for workload sockets; the Caddy user must be able to connect. */
	workloadSocketMode: string;
	/** Optional group for workload sockets (e.g. the Caddy group). */
	workloadSocketGroup: string | null;
	/** Mode for the helper's own control socket (owner/group only). */
	controlSocketMode: string;
	/** Group allowed to connect to the helper socket; the agent runs as this user. */
	controlSocketGroup: string | null;
	/** Advertised helper version. */
	version: string;
	/** Binaries the `node/update` verb replaces (D99). */
	nodeUpdate: {
		agentBinary: string;
		helperBinary: string;
		releaseLink: string;
		workDir: string;
	};
	/** Root-owned control socket directory. */
	socketDirMode: number;
}

type Env = Record<string, string | undefined>;

const DEFAULT_RELEASE_DIRS = ['/srv/skiff/releases', '/var/lib/skiff/agent/releases'];

export class HelperConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HelperConfigError';
	}
}

function optional(env: Env, name: string, fallback: string): string {
	const value = env[name]?.trim();
	return value ? value : fallback;
}

function optionalValue(env: Env, name: string): string | null {
	const value = env[name]?.trim();
	return value ? value : null;
}

function absolute(env: Env, name: string, fallback: string): string {
	const value = optional(env, name, fallback);
	try {
		return assertAbsolutePath(value, name);
	} catch (error) {
		throw new HelperConfigError(error instanceof Error ? error.message : String(error));
	}
}

function releaseDirs(value: string): string[] {
	const dirs = value
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (dirs.length === 0) throw new HelperConfigError('SKIFF_HELPER_RELEASE_DIRS must not be empty');
	try {
		return dirs.map((dir) => assertAbsolutePath(dir, 'SKIFF_HELPER_RELEASE_DIRS entry'));
	} catch (error) {
		throw new HelperConfigError(error instanceof Error ? error.message : String(error));
	}
}

function socketMode(value: string, label: string): string {
	if (!/^0[0-7]{3}$/.test(value)) throw new HelperConfigError(`${label} must be an octal mode like 0660`);
	return value;
}

/** The helper socket must not be reachable by "other". */
function controlSocketMode(value: string): string {
	const mode = socketMode(value, 'SKIFF_HELPER_CONTROL_SOCKET_MODE');
	if ((Number.parseInt(mode, 8) & 0o007) !== 0)
		throw new HelperConfigError('SKIFF_HELPER_CONTROL_SOCKET_MODE must not grant permissions to other users');
	return mode;
}

function socketGroup(value: string | null, label: string): string | null {
	if (value === null) return null;
	if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value))
		throw new HelperConfigError(`${label} is not a valid group name`);
	return value;
}

const APPARMOR_RESTRICT_SYSCTL = '/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined';

/**
 * `auto` (the default) turns AppArmor off for containers only when the kernel restricts
 * unprivileged profile changes. With that sysctl the runtime's profile change is converted to a
 * stack, and the stock profile does not allow a process to signal a peer in the stacked label, so
 * Postgres cannot stop or checkpoint itself. `none` keeps the runtime default; any other value is
 * passed through as an explicit profile name.
 */
function apparmorProfile(value: string | null): string | null {
	if (value === null || value === 'auto') {
		try {
			return readFileSync(APPARMOR_RESTRICT_SYSCTL, 'utf8').trim() === '1' ? 'unconfined' : null;
		} catch {
			return null;
		}
	}
	if (value === 'none') return null;
	if (!/^[A-Za-z0-9_.-]+$/.test(value))
		throw new HelperConfigError('SKIFF_HELPER_APPARMOR_PROFILE must be "auto", "none" or a profile name');
	return value;
}

export function loadHelperConfig(env: Env = process.env): HelperConfig {
	const socketPath = absolute(env, 'SKIFF_HELPER_SOCKET', '/run/skiff-helper/helper.sock');
	const runtimeDir = absolute(env, 'SKIFF_HELPER_RUNTIME_DIR', '/run/skiff-workloads');
	if (socketPath.startsWith(`${runtimeDir}/`))
		throw new HelperConfigError('SKIFF_HELPER_SOCKET must not live inside the workload runtime dir');


	return {
		socketPath,
		unitDir: absolute(env, 'SKIFF_HELPER_UNIT_DIR', '/etc/systemd/system'),
		quadletDir: absolute(env, 'SKIFF_HELPER_QUADLET_DIR', '/etc/containers/systemd'),
		runtimeDir,
		stateDir: absolute(env, 'SKIFF_HELPER_STATE_DIR', '/var/lib/skiff-workloads'),
		releaseDirs: releaseDirs(optional(env, 'SKIFF_HELPER_RELEASE_DIRS', DEFAULT_RELEASE_DIRS.join(','))),
		bunPath: absolute(env, 'SKIFF_HELPER_BUN_PATH', '/usr/local/bin/bun'),
		systemctlPath: absolute(env, 'SKIFF_HELPER_SYSTEMCTL', '/usr/bin/systemctl'),
		journalctlPath: absolute(env, 'SKIFF_HELPER_JOURNALCTL', '/usr/bin/journalctl'),
		podmanPath: absolute(env, 'SKIFF_HELPER_PODMAN', '/usr/bin/podman'),
		opensslPath: absolute(env, 'SKIFF_HELPER_OPENSSL', '/usr/bin/openssl'),
		apparmorProfile: apparmorProfile(optionalValue(env, 'SKIFF_HELPER_APPARMOR_PROFILE')),
		workloadSocketMode: socketMode(
			optional(env, 'SKIFF_HELPER_WORKLOAD_SOCKET_MODE', '0666'),
			'SKIFF_HELPER_WORKLOAD_SOCKET_MODE',
		),
		workloadSocketGroup: socketGroup(
			optionalValue(env, 'SKIFF_HELPER_WORKLOAD_SOCKET_GROUP'),
			'SKIFF_HELPER_WORKLOAD_SOCKET_GROUP',
		),
		controlSocketMode: controlSocketMode(
			optional(env, 'SKIFF_HELPER_CONTROL_SOCKET_MODE', '0660'),
		),
		controlSocketGroup: socketGroup(
			optional(env, 'SKIFF_HELPER_CONTROL_SOCKET_GROUP', 'skiff'),
			'SKIFF_HELPER_CONTROL_SOCKET_GROUP',
		),
		// Embedded at build time, never configurable: it must name the binary that is running (D99).
		version: BUILD_VERSION,
		nodeUpdate: {
			agentBinary: absolute(env, 'SKIFF_HELPER_AGENT_BINARY', '/opt/skiff/current/agent/skiff-agent'),
			helperBinary: absolute(env, 'SKIFF_HELPER_SELF_BINARY', '/opt/skiff/helper/skiff-helper'),
			releaseLink: absolute(env, 'SKIFF_HELPER_RELEASE_LINK', '/opt/skiff/current'),
			workDir: absolute(env, 'SKIFF_HELPER_UPDATE_DIR', '/var/lib/skiff-helper/node-update'),
		},
		socketDirMode: 0o750,
	};
}
