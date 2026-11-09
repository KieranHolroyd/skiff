/**
 * `yoal-mail.service`: Yoal's MTA (docs/EMAIL.md §3.2, D115). It runs the agent binary's `mail`
 * entrypoint in its own cgroup and sandbox, as the agent's user, with one extra capability:
 * binding the SMTP ports (25, 465, 587).
 *
 * Like the studio, the unit is static: installed beside the agent unit on every host but never
 * enabled. The agent of the node chosen as the mail node starts it through the helper's fixed
 * `POST /v1/mail/start` verb (and again after every boot, when desired state says so). A node that
 * is not the mail node never runs it. `scripts/systemd/yoal-mail.service` is the rendered
 * default, kept identical by a test.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAIL_UNIT = 'yoal-mail.service';

export interface MailUnitPaths {
	optDir?: string;
	runDir?: string;
	/** The group of the setgid runtime directory (`d /run/yoal 2770 root caddy`). */
	socketGroup?: string;
}

export function mailUnit(paths: MailUnitPaths = {}): string {
	const optDir = paths.optDir ?? '/opt/yoal';
	const runDir = paths.runDir ?? '/run/yoal';
	const socketGroup = paths.socketGroup ?? 'caddy';
	return `[Unit]
Description=Yoal mail (MTA)
Documentation=https://github.com/KieranHolroyd/yoal/blob/main/docs/EMAIL.md
After=network-online.target
Wants=network-online.target
# Started only by the helper's POST /v1/mail/start verb on the mail node. An agent update runs
# \`systemctl try-restart ${MAIL_UNIT}\` after restarting the agent, so a running MTA moves to the
# new binary and a stopped one stays stopped. The spool survives restarts.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=yoal
Group=yoal
# ${runDir} is setgid ${socketGroup} (2770), so creating mail.sock there needs the group. The
# socket comes out 0660 yoal:${socketGroup}; the agent (also yoal) is the only client.
SupplementaryGroups=${socketGroup}
UMask=0007
WorkingDirectory=${optDir}/current/agent

# No EnvironmentFile with secrets: yoal-mail never talks to the control plane and holds no node
# token. DKIM keys and credential hashes arrive from the agent over the socket, into memory only.
Environment=YOAL_MAIL_SOCKET=${runDir}/mail.sock
Environment=YOAL_MAIL_DATA_DIR=/var/lib/yoal/mail
Environment=YOAL_MAIL_TLS_DIR=${runDir}/mail-tls
# Optional operator overrides (listen address, ports, YOAL_MAIL_IPV6=1).
EnvironmentFile=-/etc/yoal/mail.env

ExecStart=${optDir}/current/agent/yoal-agent mail

Restart=always
RestartSec=2
# Long enough for in-flight SMTP transactions to finish before SIGKILL.
TimeoutStopSec=30
KillSignal=SIGTERM
LimitNOFILE=16384
TasksMax=256
# Its own cgroup, separate from the agent's MemoryMax: an OOM kill here never picks the agent.
MemoryMax=512M

# The spool. StateDirectory creates it owned by User= and keeps it writable under ProtectSystem.
StateDirectory=yoal/mail
StateDirectoryMode=0700

# The only privilege: binding ports below 1024. Nothing else.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
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

ReadWritePaths=${runDir}

# Deliberately no [Install] section: the unit is static, so \`systemctl enable\` refuses it and
# nothing starts it at boot except the mail node's agent.
`;
}

export interface EnsureMailOptions extends MailUnitPaths {
	systemdDir?: string;
	run: (cmd: string[]) => void;
	log?: (message: string) => void;
}

/** Install or refresh the unit. Never enables or starts it. Returns whether it changed. */
export function ensureMailUnit(options: EnsureMailOptions): boolean {
	const systemdDir = options.systemdDir ?? '/etc/systemd/system';
	const path = join(systemdDir, MAIL_UNIT);
	const body = mailUnit(options);
	if (existsSync(path) && readFileSync(path, 'utf8') === body) return false;
	writeFileSync(path, body, { mode: 0o644 });
	options.run(['systemctl', 'daemon-reload']);
	options.log?.(`installed ${MAIL_UNIT} (started by the mail node's agent, never enabled)`);
	return true;
}
