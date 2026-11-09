/**
 * `skiff-identity.service`: the standalone user-pool identity process (docs/IAM.md §11.2). It runs
 * the agent binary's `identity` entrypoint in its own cgroup and sandbox, as the agent's user, with
 * no extra capabilities: it listens on a loopback HTTP port and a group-readable unix socket.
 *
 * Like the studio and `skiff-mail`, the unit is static: installed beside the agent unit on every
 * host but never enabled. The identity node's agent starts it through the helper's fixed
 * `POST /v1/identity/start` verb (and again after every boot, when desired state says so).
 * `scripts/systemd/skiff-identity.service` is the rendered default, kept identical by a test.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const IDENTITY_UNIT = 'skiff-identity.service';
export const IDENTITY_LITESTREAM_UNIT = 'skiff-litestream-identity.service';

export interface IdentityUnitPaths {
	optDir?: string;
	runDir?: string;
	/** The group of the setgid runtime directory (`d /run/skiff 2770 root caddy`). */
	socketGroup?: string;
}

export function identityUnit(paths: IdentityUnitPaths = {}): string {
	const optDir = paths.optDir ?? '/opt/skiff';
	const runDir = paths.runDir ?? '/run/skiff';
	const socketGroup = paths.socketGroup ?? 'caddy';
	return `[Unit]
Description=Skiff identity (user pools)
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/IAM.md
After=network-online.target
Wants=network-online.target
# Started only by the helper's POST /v1/identity/start verb on the identity node. An agent update
# runs \`systemctl try-restart ${IDENTITY_UNIT}\` after restarting the agent, so a running identity
# process moves to the new binary and a stopped one stays stopped. Its database survives restarts.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=skiff
Group=skiff
# ${runDir} is setgid ${socketGroup} (2770), so creating identity.sock there needs the group. The
# socket comes out 0660 skiff:${socketGroup}; the agent (also skiff) is the only client.
SupplementaryGroups=${socketGroup}
UMask=0007
WorkingDirectory=${optDir}/current/agent

# No EnvironmentFile with secrets: the identity process holds pool signing keys in its own SQLite
# file and never sees the node token. The agent pushes the non-secret pool projection over the
# unix socket. Optional operator overrides (data dir, origin, mail relay, master key).
Environment=SKIFF_IDENTITY_SOCKET=${runDir}/identity.sock
Environment=SKIFF_IDENTITY_DATA_DIR=/var/lib/skiff/identity
Environment=SKIFF_IDENTITY_PORT=8788
Environment=SKIFF_IDENTITY_HOST=127.0.0.1
EnvironmentFile=-/etc/skiff/identity.env

ExecStart=${optDir}/current/agent/skiff-agent identity

Restart=always
RestartSec=2
TimeoutStopSec=30
KillSignal=SIGTERM
LimitNOFILE=4096
TasksMax=128
# Its own cgroup, separate from the agent's MemoryMax: an OOM kill here never picks the agent.
MemoryMax=256M

# The SQLite file and its -wal/-shm companions. StateDirectory creates it owned by User= and keeps
# it writable under ProtectSystem.
StateDirectory=skiff/identity
StateDirectoryMode=0700

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
# nothing starts it at boot except the identity node's agent.
`;
}

/**
 * `skiff-litestream-identity.service`: continuous replication of the identity database, kept apart
 * from the control-plane Litestream unit so a loss of the identity node never disturbs platform
 * backups (and vice versa). Static for the same reason as the process unit.
 */
export function identityLitestreamUnit(paths: { etcDir?: string; binPath?: string } = {}): string {
	const etcDir = paths.etcDir ?? '/etc/skiff';
	const binPath = paths.binPath ?? '/usr/local/bin/litestream';
	return `[Unit]
Description=Skiff identity SQLite continuous replication (Litestream)
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/IAM.md
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=10

[Service]
Type=simple
User=skiff
Group=skiff
UMask=0027
EnvironmentFile=/etc/skiff/skiff.env

ExecStart=${binPath} replicate -config ${etcDir}/litestream-identity.yml

Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
LimitNOFILE=4096
TasksMax=64
MemoryMax=128M

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
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=

ReadWritePaths=/var/lib/skiff/identity

# Deliberately no [Install] section: the identity node's helper starts it with the process.
`;
}

export interface EnsureIdentityOptions extends IdentityUnitPaths {
	systemdDir?: string;
	/** Absolute path to Litestream when the installer found one; defaults to the standard path. */
	litestreamPath?: string;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
}

/** Install or refresh both static units. Never enables or starts them. Returns whether anything changed. */
export function ensureIdentityUnits(options: EnsureIdentityOptions): boolean {
	const systemdDir = options.systemdDir ?? '/etc/systemd/system';
	let changed = false;
	const write = (name: string, body: string): void => {
		const path = join(systemdDir, name);
		if (existsSync(path) && readFileSync(path, 'utf8') === body) return;
		writeFileSync(path, body, { mode: 0o644 });
		changed = true;
	};
	write(IDENTITY_UNIT, identityUnit(options));
	write(
		IDENTITY_LITESTREAM_UNIT,
		identityLitestreamUnit(options.litestreamPath ? { binPath: options.litestreamPath } : {}),
	);
	if (changed) options.run(['systemctl', 'daemon-reload']);
	options.log?.(`installed ${IDENTITY_UNIT} (started by the identity node's agent, never enabled)`);
	return changed;
}
