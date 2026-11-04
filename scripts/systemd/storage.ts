/**
 * `skiff-storage.path` + `skiff-storage.service`: move a node's data when a platform admin changes
 * its storage locations (D48). The agent cannot do it: its sandbox only writes the current
 * directories. So it drops `/run/skiff/storage.request`, and systemd (root) runs
 * `skiff-agent storage apply`. That command ignores the request's contents and fetches the paths
 * from the control plane with the node token.
 *
 * Same trigger pattern as the dashboard self-update (scripts/update-self/units.ts). Shared by the
 * installer and `skiff-update-self`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORAGE_LINK } from './builder.ts';

export const STORAGE_PATH_UNIT = 'skiff-storage.path';
export const STORAGE_SERVICE_UNIT = 'skiff-storage.service';
export const STORAGE_REQUEST_FILE = '/run/skiff/storage.request';

export interface StorageUnitPaths {
	optDir?: string;
	agentEnvFile?: string;
	requestFile?: string;
}

export function storageUnits(paths: StorageUnitPaths = {}): Record<string, string> {
	const optDir = paths.optDir ?? '/opt/skiff';
	const agentEnvFile = paths.agentEnvFile ?? '/etc/skiff/agent.env';
	const requestFile = paths.requestFile ?? STORAGE_REQUEST_FILE;
	// On both units: a service whose condition fails would leave the request in place and make the
	// path unit re-trigger until it hits its trigger limit.
	const conditions = `ConditionPathExists=${agentEnvFile}
ConditionPathExists=${optDir}/current/agent/${STORAGE_LINK}`;
	return {
		[STORAGE_PATH_UNIT]: `[Unit]
Description=Move Skiff node storage when the agent requests it
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md
${conditions}

[Path]
PathExists=${requestFile}
Unit=${STORAGE_SERVICE_UNIT}

[Install]
WantedBy=paths.target
`,
		[STORAGE_SERVICE_UNIT]: `[Unit]
Description=Skiff node storage move (requested from the dashboard)
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md
# Deliberately no dependency on skiff-agent.service: this unit stops and starts it.
${conditions}

[Service]
Type=oneshot
# Consume the request first so a failing run cannot re-trigger in a loop. The agent asks again
# only when the setting changes, or every minute while a move waits for a running build.
ExecStartPre=/bin/rm -f ${requestFile}
ExecStart=${optDir}/current/agent/${STORAGE_LINK} storage apply
# The exit code reports a refused or failed move; the status file carries the reason.
SuccessExitStatus=1
# Copying a large release cache to another disk can take a while.
TimeoutStartSec=6h
Nice=10
IOSchedulingClass=idle
`,
	};
}

export interface EnsureStorageOptions extends StorageUnitPaths {
	systemdDir?: string;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
}

/** Install and enable the trigger. Idempotent; only reloads systemd when a unit changed. */
export function ensureStorageUnits(options: EnsureStorageOptions): boolean {
	const systemdDir = options.systemdDir ?? '/etc/systemd/system';
	let changed = false;
	for (const [name, body] of Object.entries(storageUnits(options))) {
		const path = join(systemdDir, name);
		if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
		writeFileSync(path, body, { mode: 0o644 });
		changed = true;
	}
	if (changed) {
		options.run(['systemctl', 'daemon-reload']);
		options.log?.(`installed ${STORAGE_PATH_UNIT}; storage locations can be changed from the dashboard`);
	}
	options.run(['systemctl', 'enable', '--now', STORAGE_PATH_UNIT]);
	return changed;
}
