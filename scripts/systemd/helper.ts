/**
 * `yoal-helper.service`: the privileged runtime helper. It renders systemd units and Quadlet
 * files from validated desired state and is the only Yoal process that runs as root (D26).
 *
 * Shared by the installer and `yoal-update-self`. Each release carries its own helper binary;
 * activation copies it to the stable `<optDir>/helper/yoal-helper` path the unit runs, so a
 * rollback to a release that predates the helper keeps the working binary.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesEqual } from './files.ts';

export const HELPER_UNIT = 'yoal-helper.service';
export const HELPER_ENV_FILE = '/etc/yoal/helper.env';

export interface HelperPaths {
	optDir?: string;
	etcDir?: string;
	varDir?: string;
	bunBin?: string;
}

export function helperUnit(paths: HelperPaths = {}): string {
	const optDir = paths.optDir ?? '/opt/yoal';
	const etcDir = paths.etcDir ?? '/etc/yoal';
	return `[Unit]
Description=Yoal privileged workload helper
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
ExecStartPre=+/usr/bin/install -d -o root -g yoal -m 0750 /run/yoal-helper
ExecStartPre=+/usr/bin/install -d -o root -g root -m 0755 /etc/containers/systemd
ExecStart=${optDir}/helper/yoal-helper
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
	const optDir = paths.optDir ?? '/opt/yoal';
	const varDir = paths.varDir ?? '/var/lib/yoal';
	const bunBin = paths.bunBin ?? join(optDir, 'runtime', 'bin', 'bun');
	return [
		`YOAL_HELPER_BUN_PATH=${bunBin}`,
		`YOAL_HELPER_RELEASE_DIRS=${varDir}/agent/releases,${optDir}/releases`,
		'YOAL_HELPER_CONTROL_SOCKET_GROUP=yoal',
		'YOAL_HELPER_WORKLOAD_SOCKET_GROUP=caddy',
		'YOAL_HELPER_WORKLOAD_SOCKET_MODE=0660',
		'YOAL_HELPER_QUADLET_DIR=/etc/containers/systemd',
		// `auto` disables AppArmor only on kernels that stack unprivileged profile changes.
		'YOAL_HELPER_APPARMOR_PROFILE=auto',
		'',
	].join('\n');
}

export interface EnsureHelperOptions extends HelperPaths {
	systemdDir?: string;
	/** Active release whose `helper/yoal-helper` is installed at the stable path. */
	release?: string;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
	/** Start or restart the helper now (false when the caller starts it separately). */
	start?: boolean;
}

/**
 * Copy a release's helper binary to the stable path the unit runs. Atomic, so a running helper
 * keeps its old inode until the restart. A release without a helper leaves the current binary.
 */
export function installHelperBinary(
	options: Pick<EnsureHelperOptions, 'optDir' | 'release' | 'log'>,
): boolean {
	if (!options.release) return false;
	const source = join(options.release, 'helper', 'yoal-helper');
	if (!existsSync(source)) return false;
	const optDir = options.optDir ?? '/opt/yoal';
	const dir = join(optDir, 'helper');
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	const target = join(dir, 'yoal-helper');
	try {
		if (filesEqual(target, source)) return false;
	} catch {
		// Missing or unreadable target: replace it.
	}
	const tmp = `${target}.new`;
	rmSync(tmp, { force: true });
	copyFileSync(source, tmp);
	chmodSync(tmp, 0o755);
	renameSync(tmp, target);
	options.log?.(`installed ${target}`);
	return true;
}

/** Install the helper binary, unit and env file. Idempotent; returns whether anything changed. */
export function ensureHelper(options: EnsureHelperOptions): boolean {
	const systemdDir = options.systemdDir ?? '/etc/systemd/system';
	const etcDir = options.etcDir ?? '/etc/yoal';
	const envFile = join(etcDir, 'helper.env');
	let changed = installHelperBinary(options);
	mkdirSync(etcDir, { recursive: true, mode: 0o750 });
	if (!existsSync(envFile)) {
		writeFileSync(envFile, helperEnv(options), { mode: 0o640 });
		options.run(['chown', 'root:yoal', envFile]);
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
