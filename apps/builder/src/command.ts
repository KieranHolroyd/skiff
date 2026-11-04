/**
 * Pure command/argv helpers. The Builder intentionally runs the project's configured shell
 * command, but everything around it (directory, unit name, argv) is built as separate arguments
 * so no field can escape into another command.
 */

export class BuildValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BuildValidationError';
	}
}

/** Validate the user-configured build command before it reaches a shell. */
export function validateBuildCommand(command: string): string {
	const value = command.trim();
	if (!value) throw new BuildValidationError('buildCommand is empty');
	if (value.length > 2048) throw new BuildValidationError('buildCommand is longer than 2048 characters');
	if (value.includes('\0')) throw new BuildValidationError('buildCommand contains a NUL byte');
	return value;
}

/** Normalize a repo-relative directory (rootDir/outputDir) and reject traversal. */
export function safeRelativeDir(value: string, label: string): string {
	const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
	if (!normalized || normalized === '.') return '.';
	if (normalized.startsWith('/')) throw new BuildValidationError(`${label} must be relative`);
	if (normalized.includes('\0')) throw new BuildValidationError(`${label} contains a NUL byte`);
	if (normalized.split('/').some((part) => part === '' || part === '.' || part === '..'))
		throw new BuildValidationError(`${label} must stay inside the repository`);
	return normalized;
}

/** systemd unit names are limited; build ids are already URL-safe. */
export function unitName(buildId: string): string {
	const safe = buildId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 200);
	return `skiff-build-${safe || 'job'}`;
}

export interface SystemdLimits {
	workDir: string;
	command: string;
	unit?: string;
	memoryMax?: string;
	cpuQuota?: string;
	timeoutSeconds?: number;
	/**
	 * Unprivileged account the build runs as. When set, the unit is also sandboxed: it can write
	 * only `workDir`, cannot see the node's Skiff state or secrets, and cannot gain privileges.
	 * This is what makes it safe for any node (the edge included) to be a Builder (D47).
	 */
	user?: string | null;
	/** The only writable path in the sandbox; defaults to `workDir` (the whole checkout in practice). */
	writableDir?: string;
	/** Variables for the build itself; systemd-run does not forward the daemon's environment. */
	env?: Record<string, string>;
	/** Cap on processes in the unit, so a fork bomb stays inside the build. */
	tasksMax?: number;
}

/** Paths a build must never read, whatever account it runs as. `-` tolerates a missing path. */
export const BUILD_INACCESSIBLE_PATHS = ['/etc/skiff', '/var/lib/skiff', '/run/skiff', '/srv/skiff', '/run/skiff-workloads'];

/** Hardening applied to every sandboxed build unit. */
function sandboxProperties(input: SystemdLimits): string[] {
	if (!input.user) return [];
	return [
		`User=${input.user}`,
		`Group=${input.user}`,
		'NoNewPrivileges=yes',
		'PrivateTmp=yes',
		'PrivateDevices=yes',
		'ProtectSystem=strict',
		'ProtectHome=yes',
		`ReadWritePaths=${input.writableDir ?? input.workDir}`,
		`InaccessiblePaths=${BUILD_INACCESSIBLE_PATHS.map((path) => `-${path}`).join(' ')}`,
		'ProtectKernelTunables=yes',
		'ProtectKernelModules=yes',
		'ProtectKernelLogs=yes',
		'ProtectControlGroups=yes',
		'ProtectClock=yes',
		'ProtectHostname=yes',
		'RestrictSUIDSGID=yes',
		'RestrictRealtime=yes',
		'LockPersonality=yes',
		'CapabilityBoundingSet=',
		`TasksMax=${input.tasksMax ?? 1024}`,
		'UMask=0022',
	];
}

/**
 * D3 limits: a transient unit per build, 2 GiB memory, 200% CPU and a 10-minute start timeout.
 * `--pipe --wait` gives the daemon the child's stdout/stderr and its exit code.
 */
export function systemdRunArgs(input: SystemdLimits): string[] {
	return [
		'systemd-run',
		'--quiet',
		'--collect',
		'--pipe',
		'--wait',
		`--unit=${input.unit ?? 'skiff-build-job'}`,
		`--property=MemoryMax=${input.memoryMax ?? '2G'}`,
		`--property=CPUQuota=${input.cpuQuota ?? '200%'}`,
		`--property=TimeoutStartSec=${input.timeoutSeconds ?? 600}`,
		// TimeoutStartSec only covers startup for Type=simple; RuntimeMaxSec bounds the build.
		`--property=RuntimeMaxSec=${input.timeoutSeconds ?? 600}`,
		...sandboxProperties(input).map((property) => `--property=${property}`),
		...Object.entries(input.env ?? {}).map(([key, value]) => `--setenv=${key}=${value}`),
		`--working-directory=${input.workDir}`,
		'/bin/bash',
		'-lc',
		validateBuildCommand(input.command),
	];
}

/** Direct-execution fallback for development; identical command boundary to the unit. */
export function directRunArgs(command: string): string[] {
	return ['/bin/bash', '-lc', validateBuildCommand(command)];
}

/**
 * Add a token to an HTTPS clone URL without touching SSH/`git://` URLs (a token can't help there).
 * The token is redacted from logs separately.
 */
export function repoUrlWithToken(repoUrl: string, token: string | null): string {
	if (!token || !repoUrl.startsWith('https://')) return repoUrl;
	try {
		const url = new URL(repoUrl);
		url.username = 'x-access-token';
		url.password = token;
		return url.toString();
	} catch {
		return repoUrl;
	}
}

/** Remove credentials from git output before it is streamed to the control plane. */
export function redactSecret(text: string, token: string | null): string {
	const withoutUrlToken = text.replace(/(https:\/\/)[^/@\s]+@/g, '$1***@');
	return token ? withoutUrlToken.replaceAll(token, '***') : withoutUrlToken;
}
