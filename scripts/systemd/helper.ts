/**
 * `skiff-helper.service`: the privileged runtime helper. It renders systemd units and Quadlet
 * files from validated desired state and is the only Skiff process that runs as root (D26).
 *
 * Shared by the installer and `skiff-update-self`. The binary lives inside a release
 * (`<optDir>/current/helper/skiff-helper`) so an atomic `current` swap also upgrades the helper;
 * the caller restarts the unit after the swap.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HELPER_UNIT = 'skiff-helper.service';
export const HELPER_ENV_FILE = '/etc/skiff/helper.env';

export interface HelperPaths {
	optDir?: string;
	etcDir?: string;
	varDir?: string;
	bunBin?: string;
}

export function helperUnit(paths: HelperPaths = {}): string {
	const optDir = paths.optDir ?? '/opt/skiff';
	const etcDir = paths.etcDir ?? '/etc/skiff';
	return `[Unit]
Description=Skiff privileged workload helper
Documentation=https://github.com/kieranholroyd/private-cloud-deploys/blob/main/docs/DESIGN.md
After=network-online.target
Wants=network-online.target
# Enrolment writes nothing here; the file is installed by the installer/updater.
ConditionPathExists=${etcDir}/helper.env
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=root
ExecStartPre=+/usr/bin/install -d -o root -g skiff -m 0750 /run/skiff-helper
ExecStartPre=+/usr/bin/install -d -o root -g root -m 0755 /etc/containers/systemd
ExecStart=${optDir}/current/helper/skiff-helper
EnvironmentFile=${etcDir}/helper.env
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
`;
}

/** Default environment for a fresh install. Existing files are never overwritten. */
export function helperEnv(paths: HelperPaths = {}): string {
	const optDir = paths.optDir ?? '/opt/skiff';
	const varDir = paths.varDir ?? '/var/lib/skiff';
	const bunBin = paths.bunBin ?? join(optDir, 'runtime', 'bin', 'bun');
	return [
		`SKIFF_HELPER_BUN_PATH=${bunBin}`,
		`SKIFF_HELPER_RELEASE_DIRS=${varDir}/agent/releases,${optDir}/releases`,
		'SKIFF_HELPER_CONTROL_SOCKET_GROUP=skiff',
		'SKIFF_HELPER_WORKLOAD_SOCKET_GROUP=caddy',
		'SKIFF_HELPER_WORKLOAD_SOCKET_MODE=0660',
		'SKIFF_HELPER_QUADLET_DIR=/etc/containers/systemd',
		// `auto` disables AppArmor only on kernels that stack unprivileged profile changes.
		'SKIFF_HELPER_APPARMOR_PROFILE=auto',
		'',
	].join('\n');
}

export interface EnsureHelperOptions extends HelperPaths {
	systemdDir?: string;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
	/** Start or restart the helper now (false when the caller starts it separately). */
	start?: boolean;
}

/** Install the helper unit and its env file. Idempotent; returns whether anything was written. */
export function ensureHelper(options: EnsureHelperOptions): boolean {
	const systemdDir = options.systemdDir ?? '/etc/systemd/system';
	const etcDir = options.etcDir ?? '/etc/skiff';
	const envFile = join(etcDir, 'helper.env');
	let changed = false;
	mkdirSync(etcDir, { recursive: true, mode: 0o750 });
	mkdirSync('/etc/containers/systemd', { recursive: true, mode: 0o755 });
	if (!existsSync(envFile)) {
		writeFileSync(envFile, helperEnv(options), { mode: 0o640 });
		options.run(['chown', 'root:skiff', envFile]);
		options.log?.(`wrote ${envFile}`);
		changed = true;
	}
	const unitFile = join(systemdDir, HELPER_UNIT);
	const rendered = helperUnit(options);
	const previous = existsSync(unitFile) ? readFileSync(unitFile, 'utf8') : null;
	if (previous !== rendered) {
		writeFileSync(unitFile, rendered);
		chmodSync(unitFile, 0o644);
		options.log?.(`wrote ${unitFile}`);
		changed = true;
	}
	options.run(['systemctl', 'daemon-reload']);
	if (options.start !== false) {
		options.run(['systemctl', 'enable', HELPER_UNIT]);
		options.run(['systemctl', 'restart', HELPER_UNIT]);
	}
	return changed;
}
