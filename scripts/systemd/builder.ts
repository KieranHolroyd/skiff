/**
 * `skiff-builder.service`: the git Builder on every node (D47). It runs `skiff-agent builder`
 * from the agent binary already on the node, authenticates with the agent's own node token, and
 * idles until a platform admin gives the node the Builder role in the dashboard.
 *
 * It is root only so it can start each build as a transient unit for the unprivileged
 * `skiff-build` account (`systemd-run` needs the system manager); the build never runs as root and
 * never inherits this unit's environment, so user code cannot read the node token.
 *
 * Shared by the installer and `skiff-update-self` (which installs it on hosts that predate it).
 */
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILDER_UNIT = 'skiff-builder.service';
/**
 * `agent/skiff-builder -> skiff-agent` in a release. It marks an agent binary that has the
 * `builder` subcommand: an older binary would ignore the argument and start a second agent, so
 * the unit only starts when the active release carries this link (a rollback simply skips it).
 */
export const BUILDER_LINK = 'skiff-builder';
/** Same idea for `skiff-agent storage apply` (D48), used by skiff-storage.service. */
export const STORAGE_LINK = 'skiff-storage';
export const BUILD_USER = 'skiff-build';
export const BUILD_DIR = '/var/lib/skiff-builder';

export interface BuilderUnitPaths {
	optDir?: string;
	agentEnvFile?: string;
}

export function builderUnit(paths: BuilderUnitPaths = {}): string {
	const optDir = paths.optDir ?? '/opt/skiff';
	const agentEnvFile = paths.agentEnvFile ?? '/etc/skiff/agent.env';
	return `[Unit]
Description=Skiff git Builder (idle unless this node has the Builder role)
Documentation=https://github.com/KieranHolroyd/skiff/blob/main/docs/OPS.md
After=network-online.target skiff-agent.service
Wants=network-online.target
# Enrolment writes the node token here; a node that has not joined has nothing to build with.
ConditionPathExists=${agentEnvFile}
# Only releases whose agent has the builder subcommand ship this link (see BUILDER_LINK).
ConditionPathExists=${optDir}/current/agent/${BUILDER_LINK}
# Restarted with the agent, so a release update switches both to the new binary.
PartOf=skiff-agent.service
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=root
EnvironmentFile=${agentEnvFile}
Environment=SKIFF_BUILD_DIR=${BUILD_DIR}
Environment=SKIFF_BUILDER_USER=${BUILD_USER}
# ProtectHome hides /root; keep git's config lookups inside the scratch directory.
Environment=HOME=${BUILD_DIR}
StateDirectory=skiff-builder
StateDirectoryMode=0711
WorkingDirectory=${BUILD_DIR}
ExecStart=${optDir}/current/agent/${BUILDER_LINK} builder
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillSignal=SIGTERM
# The daemon clones and zips (artifacts are capped at 500 MB); the build has its own limits.
MemoryMax=1G
TasksMax=256
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
# Hand checkouts to ${BUILD_USER}, then read and remove what the build wrote.
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Add the subcommand links (`skiff-builder`, `skiff-storage`) to a release whose agent binary was
 * built from this source.
 */
export function linkAgentCommands(release: string): void {
	const agentDir = join(release, 'agent');
	if (!existsSync(join(agentDir, 'skiff-agent'))) return;
	for (const name of [BUILDER_LINK, STORAGE_LINK]) {
		const link = join(agentDir, name);
		try {
			lstatSync(link);
		} catch {
			symlinkSync('skiff-agent', link);
		}
	}
}

export interface EnsureBuilderOptions extends BuilderUnitPaths {
	systemdDir?: string;
	run: (cmd: string[]) => void;
	/** Read-only probe; returns null when the command fails. */
	capture: (cmd: string[]) => string | null;
	log?: (message: string) => void;
	/** Start (or restart) the unit now. Off when the caller restarts the agent itself (PartOf). */
	start?: boolean;
}

/** Create the build account and install/enable the unit. Idempotent; returns whether it changed. */
export function ensureBuilder(options: EnsureBuilderOptions): boolean {
	const systemdDir = options.systemdDir ?? '/etc/systemd/system';
	if (options.capture(['id', '-u', BUILD_USER]) === null) {
		options.run([
			'useradd',
			'--system',
			'--user-group',
			'--no-create-home',
			'--home-dir',
			'/nonexistent',
			'--shell',
			'/usr/sbin/nologin',
			BUILD_USER,
		]);
		options.log?.(`created the ${BUILD_USER} build account`);
	}
	const path = join(systemdDir, BUILDER_UNIT);
	const body = builderUnit(options);
	const changed = !existsSync(path) || readFileSync(path, 'utf8') !== body;
	if (changed) {
		writeFileSync(path, body, { mode: 0o644 });
		options.run(['systemctl', 'daemon-reload']);
		options.log?.(`installed ${BUILDER_UNIT}; it idles until the node has the Builder role`);
	}
	options.run(['systemctl', 'enable', BUILDER_UNIT]);
	if (options.start !== false && existsSync(options.agentEnvFile ?? '/etc/skiff/agent.env'))
		options.run(['systemctl', changed ? 'restart' : 'start', BUILDER_UNIT]);
	return changed;
}
