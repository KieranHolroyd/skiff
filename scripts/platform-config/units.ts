/**
 * systemd units + the `/usr/local/sbin` wrapper that let the dashboard change platform settings
 * (backups, email, alerts) without giving the control plane any privilege: the control plane drops
 * a request file, systemd (root) runs `yoal-platform-config apply-request`.
 *
 * Shared by `yoal-platform-config install`, `yoal-update-self` (which re-creates them if missing,
 * so existing hosts get the settings after one `sudo yoal-update-self check`) and the installer.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLATFORM_CONFIG_DEFAULTS } from '../../packages/contracts/src/platform-config.ts';

export const CONFIG_PATH_UNIT = 'yoal-platform-config.path';
export const CONFIG_SERVICE_UNIT = 'yoal-platform-config.service';
export const CONFIG_COMMAND = '/usr/local/sbin/yoal-platform-config';

export function platformConfigUnits(
	requestFile: string = PLATFORM_CONFIG_DEFAULTS.requestFile,
	command: string = CONFIG_COMMAND,
): Record<string, string> {
	return {
		[CONFIG_PATH_UNIT]: `[Unit]
Description=Apply Yoal platform settings when the dashboard requests it
Documentation=https://github.com/KieranHolroyd/yoal/blob/main/docs/OPS.md

[Path]
PathExists=${requestFile}
Unit=${CONFIG_SERVICE_UNIT}

[Install]
WantedBy=paths.target
`,
		[CONFIG_SERVICE_UNIT]: `[Unit]
Description=Yoal platform settings (requested from the dashboard)
Documentation=https://github.com/KieranHolroyd/yoal/blob/main/docs/OPS.md
# Deliberately no dependency on yoal-control-plane.service: this unit restarts it.

[Service]
Type=oneshot
# The helper claims (reads, then deletes) the request before acting, so a failure cannot make
# the path unit re-trigger in a loop. It re-validates every key and value itself.
ExecStart=${command} apply-request
TimeoutStartSec=15min
`,
	};
}

/** Runs the helper from the active release, falling back to `previous` (like yoal-update-self). */
export function platformConfigWrapper(optDir: string, bunBin: string): string {
	return `#!/bin/sh
# Installed by Yoal. See docs/OPS.md §4.3.
set -eu
for release in ${optDir}/current ${optDir}/previous; do
	if [ -f "$release/repo/scripts/platform-config/main.ts" ]; then
		exec ${bunBin} "$release/repo/scripts/platform-config/main.ts" "$@"
	fi
done
echo "yoal-platform-config: no release under ${optDir} ships the helper; re-run the installer" >&2
exit 1
`;
}

export interface EnsureOptions {
	systemdDir?: string;
	requestFile?: string;
	optDir?: string;
	bunBin: string;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
}

/**
 * Idempotently install the wrapper, the units and the yoal-owned request directory. Returns true
 * when something changed (and systemd was reloaded).
 */
export function ensurePlatformConfigUnits(options: EnsureOptions): boolean {
	const systemdDir = options.systemdDir ?? '/etc/systemd/system';
	const requestFile = options.requestFile ?? PLATFORM_CONFIG_DEFAULTS.requestFile;
	const optDir = options.optDir ?? '/opt/yoal';
	let changed = false;

	const wrapper = platformConfigWrapper(optDir, options.bunBin);
	if (!existsSync(CONFIG_COMMAND) || readFileSync(CONFIG_COMMAND, 'utf8') !== wrapper) {
		mkdirSync(dirname(CONFIG_COMMAND), { recursive: true });
		writeFileSync(`${CONFIG_COMMAND}.tmp`, wrapper, { mode: 0o755 });
		chmodSync(`${CONFIG_COMMAND}.tmp`, 0o755);
		renameSync(`${CONFIG_COMMAND}.tmp`, CONFIG_COMMAND);
		changed = true;
	}
	for (const [name, body] of Object.entries(platformConfigUnits(requestFile))) {
		const path = join(systemdDir, name);
		if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
		writeFileSync(path, body, { mode: 0o644 });
		changed = true;
	}
	// The control plane writes requests here; it must be the yoal user's, not root's.
	mkdirSync(dirname(requestFile), { recursive: true, mode: 0o750 });
	options.run(['chown', 'yoal:yoal', dirname(requestFile)]);
	if (changed) {
		options.run(['systemctl', 'daemon-reload']);
		options.run(['systemctl', 'enable', '--now', CONFIG_PATH_UNIT]);
		options.log?.(`dashboard platform settings enabled (${CONFIG_PATH_UNIT})`);
	}
	return changed;
}
