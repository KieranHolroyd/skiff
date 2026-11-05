/**
 * systemd units that let the dashboard request an update without giving the control plane any
 * privilege: the control plane drops a file, systemd (root) runs the updater. Shared by the
 * installer and by `skiff-update-self` itself, which re-creates them if missing so existing hosts
 * get the dashboard button on their next CLI run.
 */
import { SELF_UPDATE_DEFAULTS } from '../../packages/contracts/src/self-update.ts';

export const TRIGGER_PATH_UNIT = 'skiff-update-self.path';
export const TRIGGER_SERVICE_UNIT = 'skiff-update-self.service';

export interface TriggerPaths {
	requestFile: string;
	command: string;
}

export const DEFAULT_TRIGGER_PATHS: TriggerPaths = {
	requestFile: SELF_UPDATE_DEFAULTS.requestFile,
	command: '/usr/local/sbin/skiff-update-self',
};

export function triggerUnits(paths: TriggerPaths = DEFAULT_TRIGGER_PATHS): Record<string, string> {
	return {
		[TRIGGER_PATH_UNIT]: `[Unit]
Description=Start a Skiff self-update when the dashboard requests one
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md

[Path]
PathExists=${paths.requestFile}
Unit=${TRIGGER_SERVICE_UNIT}

[Install]
WantedBy=paths.target
`,
		[TRIGGER_SERVICE_UNIT]: `[Unit]
Description=Skiff self-update (requested from the dashboard)
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md
# Deliberately no dependency on skiff-control-plane.service: this unit stops and starts it.

[Service]
Type=oneshot
# Consume the request first (rm on a symlink removes the link, never its target), so a failing
# run cannot make the path unit re-trigger in a loop. A request made while this runs re-triggers
# once it finishes, and the updater then finds nothing newer.
ExecStartPre=/bin/rm -f ${paths.requestFile}
ExecStart=${paths.command} update --trigger dashboard
# Exit 1 means "nothing changed" or "rolled back, old release serving" — not a unit failure.
# Exit 2 (the old release did not come back) stays a failure so it shows in systemctl --failed.
SuccessExitStatus=1
TimeoutStartSec=60min
Nice=10
IOSchedulingClass=idle
`,
	};
}

export interface UpdateCommandPaths {
	optDir: string;
	bunBin: string;
	updaterDir: string;
}

/**
 * /usr/local/sbin/skiff-update-self. Prefers the qualified stage-0 binary; if it is missing or
 * does not even run (`--version`), falls back to the TypeScript updater shipped in the current,
 * then the previous, release. Set SKIFF_UPDATER=source to force the fallback.
 */
export function updateCommandScript(paths: UpdateCommandPaths): string {
	return `#!/bin/sh
# Installed by Skiff. See docs/OPS.md §4.1.
set -eu
stage0=${paths.updaterDir}/current/skiff-updated
if [ "\${SKIFF_UPDATER:-}" != source ] && [ -x "$stage0" ] && "$stage0" --version >/dev/null 2>&1; then
	exec "$stage0" "$@"
fi
for release in ${paths.optDir}/current ${paths.optDir}/previous; do
	if [ -f "$release/repo/scripts/update-self/main.ts" ]; then
		exec ${paths.bunBin} "$release/repo/scripts/update-self/main.ts" "$@"
	fi
done
echo "skiff-update-self: no working updater; see skiff-recover (docs/OPS.md)" >&2
exit 1
`;
}
