/**
 * `skiff-studio.service`: the on-demand database studio process (plan 22). It runs the agent
 * binary's `studio` entrypoint in its own cgroup, so a driver crash or out-of-memory kill takes
 * down only the studio, never the agent.
 *
 * The unit is static: it is installed next to the agent unit but never enabled. The agent starts
 * it through the helper's fixed `POST /v1/studio/start` verb and the process exits by itself when
 * idle. `scripts/systemd/skiff-studio.service` is the rendered default, kept identical by a test.
 *
 * Shared by the installer and `skiff-update-self` (which installs it on hosts that predate it).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STUDIO_UNIT = 'skiff-studio.service';

export interface StudioUnitPaths {
	optDir?: string;
	runDir?: string;
	/** The group of the setgid runtime directory (`d /run/skiff 2770 root caddy`). */
	socketGroup?: string;
}

export function studioUnit(paths: StudioUnitPaths = {}): string {
	const optDir = paths.optDir ?? '/opt/skiff';
	const runDir = paths.runDir ?? '/run/skiff';
	const socketGroup = paths.socketGroup ?? 'caddy';
	return `[Unit]
Description=Skiff database studio (on demand)
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/build-plan/plans/22-native-studio.md
# Started only by the helper's POST /v1/studio/start verb when the agent sees a studio request.
# An agent update runs \`systemctl try-restart ${STUDIO_UNIT}\` after restarting the agent, so a
# running studio moves to the new binary and a stopped one stays stopped.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=skiff
Group=skiff
# ${runDir} is setgid ${socketGroup} (2770), so creating studio.sock there needs the group. The
# socket comes out 0660 skiff:${socketGroup}; the agent (also skiff) is the only client.
SupplementaryGroups=${socketGroup}
UMask=0007
WorkingDirectory=${optDir}/current/agent

# No EnvironmentFile: the studio never talks to the control plane, holds no node token, and gets
# each session's credentials from the agent over the socket.
Environment=SKIFF_STUDIO_SOCKET=${runDir}/studio.sock

ExecStart=${optDir}/current/agent/skiff-agent studio

# The process exits 0 after 5 idle minutes; on-failure leaves that clean exit stopped.
Restart=on-failure
RestartSec=1
TimeoutStopSec=10
KillSignal=SIGTERM
LimitNOFILE=4096
TasksMax=64
# Its own cgroup, separate from the agent's MemoryMax=192M: an OOM kill here never picks the agent.
MemoryMax=256M

# The agent's sandbox, minus netlink (no node metrics) and with only the runtime socket writable.
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

ReadWritePaths=${runDir}

# Deliberately no [Install] section: the unit is static, so \`systemctl enable\` refuses it and
# nothing starts it at boot. A node that never opens a studio never runs it.
`;
}

export interface EnsureStudioOptions extends StudioUnitPaths {
	systemdDir?: string;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
}

/** Install or refresh the unit. Never enables or starts it. Returns whether it changed. */
export function ensureStudioUnit(options: EnsureStudioOptions): boolean {
	const systemdDir = options.systemdDir ?? '/etc/systemd/system';
	const path = join(systemdDir, STUDIO_UNIT);
	const body = studioUnit(options);
	if (existsSync(path) && readFileSync(path, 'utf8') === body) return false;
	writeFileSync(path, body, { mode: 0o644 });
	options.run(['systemctl', 'daemon-reload']);
	options.log?.(`installed ${STUDIO_UNIT} (started on demand, never enabled)`);
	return true;
}
