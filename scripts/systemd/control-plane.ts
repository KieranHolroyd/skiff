/**
 * Control-plane systemd units, shared by the installer and the self-updater.
 *
 * Zero-downtime updates use two units and one stable socket path:
 *
 *   skiff-control-plane.service          primary: runs /opt/skiff/current, socket control-primary.sock
 *   skiff-control-plane-standby.service  standby: runs /opt/skiff/standby, socket control-standby.sock
 *   /run/skiff/control.sock              symlink to whichever socket serves now
 *
 * Caddy, the agent, the CLI and every script keep talking to control.sock. The updater boots the
 * incoming release as the standby, proves it healthy, and renames control.sock to point at it
 * (one atomic rename; new connections follow, open ones finish on the old process). After a
 * bake it restarts the primary on the new release and points control.sock back. The standby is
 * never enabled, so a reboot always comes up on the primary and `current`.
 *
 * The standby runs with SKIFF_STANDBY=1: no maintenance loop, no operation resume. Exactly one
 * process (the primary) owns background work at any time.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRIMARY_UNIT = 'skiff-control-plane.service';
export const STANDBY_UNIT = 'skiff-control-plane-standby.service';
export const GUARD_UNIT = 'skiff-update-guard.service';

export interface ControlPlanePaths {
	optDir: string;
	runDir: string;
	varDir: string;
	envFile: string;
	masterKeyFile: string;
	/** Command run at boot by the guard (stage-0 updater). */
	updateCommand: string;
}

export const DEFAULT_CONTROL_PLANE_PATHS: ControlPlanePaths = {
	optDir: '/opt/skiff',
	runDir: '/run/skiff',
	varDir: '/var/lib/skiff',
	envFile: '/etc/skiff/skiff.env',
	masterKeyFile: '/etc/skiff/master.key',
	updateCommand: '/usr/local/sbin/skiff-update-self',
};

export function socketPaths(runDir = DEFAULT_CONTROL_PLANE_PATHS.runDir) {
	return {
		public: join(runDir, 'control.sock'),
		primary: join(runDir, 'control-primary.sock'),
		standby: join(runDir, 'control-standby.sock'),
	};
}

function serviceBody(input: {
	description: string;
	slot: 'current' | 'standby';
	socketName: string;
	paths: ControlPlanePaths;
	extraEnv?: string[];
	preStart?: string;
	install: boolean;
}): string {
	const { paths } = input;
	const root = `${paths.optDir}/${input.slot}`;
	return `[Unit]
Description=${input.description}
After=network-online.target caddy.service ${GUARD_UNIT}
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=skiff
Group=skiff
SupplementaryGroups=caddy
UMask=0007
WorkingDirectory=${root}/repo/apps/control-plane
EnvironmentFile=${paths.envFile}
Environment=NODE_ENV=production
Environment=SOCKET_PATH=${paths.runDir}/${input.socketName}
Environment=PROTOCOL_HEADER=x-forwarded-proto
Environment=HOST_HEADER=x-forwarded-host
Environment=BODY_SIZE_LIMIT=520M
Environment=SKIFF_MASTER_KEY_FILE=%d/master-key
${(input.extraEnv ?? []).map((line) => `Environment=${line}\n`).join('')}LoadCredential=master-key:${paths.masterKeyFile}
${input.preStart ? `ExecStartPre=${input.preStart}\n` : ''}ExecStart=${root}/runtime/bun ${root}/repo/apps/control-plane/build/index.js
Restart=on-failure
RestartSec=2
TimeoutStopSec=35
KillSignal=SIGTERM
LimitNOFILE=65535
TasksMax=256
MemoryMax=1G
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectClock=yes
ProtectHostname=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service io_uring_setup io_uring_enter io_uring_register
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=${paths.varDir} ${paths.runDir}
${input.install ? '\n[Install]\nWantedBy=multi-user.target\n' : ''}`;
}

/**
 * Point control.sock at the primary unless the standby is serving through it. During an update
 * it names the standby, so a primary (re)start must not steal traffic back before the primary is
 * healthy; in every other case (reboot: /run is empty; a legacy real socket file; a link left
 * on a standby that has since stopped) the primary owns it. `$$` is systemd's escape for `$`.
 */
function primaryPreStart(runDir: string): string {
	const link = `${runDir}/control.sock`;
	return `+/bin/sh -c 'l=${link}; if [ "$$(readlink "$$l" 2>/dev/null)" = control-standby.sock ] && systemctl is-active --quiet ${STANDBY_UNIT}; then exit 0; fi; ln -sfn control-primary.sock "$$l.tmp" && mv -Tf "$$l.tmp" "$$l"'`;
}

export function controlPlaneUnits(paths: ControlPlanePaths = DEFAULT_CONTROL_PLANE_PATHS): Record<string, string> {
	return {
		[PRIMARY_UNIT]: serviceBody({
			description: 'Skiff control plane (dashboard, REST, MCP)',
			slot: 'current',
			socketName: 'control-primary.sock',
			paths,
			preStart: primaryPreStart(paths.runDir),
			install: true,
		}),
		[STANDBY_UNIT]: serviceBody({
			description: 'Skiff control plane standby (serves during zero-downtime updates)',
			slot: 'standby',
			socketName: 'control-standby.sock',
			paths,
			extraEnv: ['SKIFF_STANDBY=1'],
			install: false,
		}),
		[GUARD_UNIT]: `[Unit]
Description=Skiff update guard (reverts an update interrupted by a crash or reboot)
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md
DefaultDependencies=no
After=local-fs.target
Before=${PRIMARY_UNIT} ${STANDBY_UNIT} skiff-litestream.service
ConditionPathExists=${paths.optDir}/update-state.json

[Service]
Type=oneshot
# Filesystem-only: restores the committed release pointers if an update never finished. It never
# waits on the control plane (which is ordered after it), and a failure here never blocks boot.
ExecStart=-${paths.updateCommand} recover --boot
TimeoutStartSec=60

[Install]
WantedBy=multi-user.target
`,
	};
}

export interface EnsureControlPlaneUnitsInput {
	systemdDir: string;
	paths?: ControlPlanePaths;
	run: (cmd: string[]) => void;
	log: (message: string) => void;
	dryRun?: boolean;
}

/** Write the units if they differ. Returns true when anything changed (daemon-reload ran). */
export function ensureControlPlaneUnits(input: EnsureControlPlaneUnitsInput): boolean {
	const changed: string[] = [];
	for (const [name, body] of Object.entries(controlPlaneUnits(input.paths))) {
		const path = join(input.systemdDir, name);
		if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
		changed.push(name);
		if (!input.dryRun) writeFileSync(path, body, { mode: 0o644 });
	}
	if (!changed.length) return false;
	if (input.dryRun) {
		input.log(`would write ${changed.join(', ')}`);
		return true;
	}
	input.run(['systemctl', 'daemon-reload']);
	input.run(['systemctl', 'enable', GUARD_UNIT]);
	input.log(`control-plane units updated (${changed.join(', ')})`);
	return true;
}

/** Atomically point `link` at `targetName` (a sibling file name, kept relative). */
export function pointSocket(link: string, targetName: string, ops: {
	symlink: (target: string, path: string) => void;
	rename: (from: string, to: string) => void;
	rm: (path: string) => void;
}): void {
	const tmp = `${link}.tmp-${process.pid}`;
	ops.rm(tmp);
	ops.symlink(targetName, tmp);
	ops.rename(tmp, link);
}
