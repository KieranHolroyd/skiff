/**
 * `skiff-agent.service` on a control-plane host: the node agent of the edge node that shares the
 * machine with the control plane. Shared by the installer and the release's `converge` hook
 * (scripts/release/converge.ts), so a release that changes the unit also updates it on hosts
 * that only ever run `skiff-update-self`.
 *
 * `scripts/systemd/skiff-agent.service` is the hand-maintained copy for `skiff-caddy` hosts; this
 * module is what the installer writes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AGENT_UNIT = 'skiff-agent.service';
export const CADDY_ACCESS_LOG = '/var/log/caddy/skiff-access.log';

const CADDY_ADMIN_SOCKETS = ['/var/lib/caddy/admin.sock', '/run/caddy/admin.sock', '/etc/caddy/admin.sock'];

export interface AgentUnitPaths {
	optDir?: string;
	etcDir?: string;
	varDir?: string;
	runDir?: string;
	/** Caddy's admin socket; see {@link detectCaddyAdminSocket}. */
	caddyAdminSocket?: string;
	caddyAccessLog?: string;
}

/**
 * Where Caddy's admin API listens. The installer points it at a unix socket; an existing socket
 * wins, then the `admin unix/…` line of the Caddyfile, then the installer's default.
 */
export function detectCaddyAdminSocket(caddyfile = '/etc/caddy/Caddyfile'): string {
	for (const candidate of CADDY_ADMIN_SOCKETS) if (existsSync(candidate)) return candidate;
	try {
		const line = readFileSync(caddyfile, 'utf8')
			.split('\n')
			.find((entry) => /^\s*admin\s+/.test(entry));
		const match = line ? /admin\s+unix\/(\/[^\s|]+)/.exec(line) : null;
		if (match?.[1]) return match[1];
	} catch {
		// No Caddyfile: fall through to the default.
	}
	return CADDY_ADMIN_SOCKETS[0]!;
}

export function agentUnit(paths: AgentUnitPaths = {}): string {
	const optDir = paths.optDir ?? '/opt/skiff';
	const etcDir = paths.etcDir ?? '/etc/skiff';
	const varDir = paths.varDir ?? '/var/lib/skiff';
	const runDir = paths.runDir ?? '/run/skiff';
	const agentEnvFile = join(etcDir, 'agent.env');
	return `[Unit]
Description=Skiff node agent
After=network-online.target caddy.service
Wants=network-online.target
ConditionPathExists=${agentEnvFile}
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=skiff
Group=skiff
SupplementaryGroups=caddy
UMask=0007
WorkingDirectory=${optDir}/current/agent
EnvironmentFile=${join(etcDir, 'skiff.env')}
EnvironmentFile=-${agentEnvFile}
Environment=SKIFF_AGENT_SOCKET=${runDir}/agent.sock
Environment=SKIFF_CADDY_ADMIN_SOCKET=${paths.caddyAdminSocket ?? detectCaddyAdminSocket()}
Environment=SKIFF_CADDY_ACCESS_LOG=${paths.caddyAccessLog ?? CADDY_ACCESS_LOG}
ExecStart=${optDir}/current/agent/skiff-agent
Restart=on-failure
RestartSec=2
TimeoutStopSec=20
KillSignal=SIGTERM
LimitNOFILE=65535
TasksMax=128
MemoryMax=192M
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
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service io_uring_setup io_uring_enter io_uring_register
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths=${varDir} ${runDir}

[Install]
WantedBy=multi-user.target
`;
}

export interface EnsureAgentUnitOptions extends AgentUnitPaths {
	systemdDir?: string;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
}

/**
 * Rewrite the unit when it differs (daemon-reload; the caller restarts the agent). Never enables
 * or starts it: enrolment does that. Returns whether it changed.
 */
export function ensureAgentUnit(options: EnsureAgentUnitOptions): boolean {
	const path = join(options.systemdDir ?? '/etc/systemd/system', AGENT_UNIT);
	const body = agentUnit(options);
	if (existsSync(path) && readFileSync(path, 'utf8') === body) return false;
	writeFileSync(path, body, { mode: 0o644 });
	options.run(['systemctl', 'daemon-reload']);
	options.log?.(`wrote ${AGENT_UNIT}`);
	return true;
}
