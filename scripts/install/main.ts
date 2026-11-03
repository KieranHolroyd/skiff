#!/usr/bin/env bun
/**
 * Skiff installer / upgrader.
 *
 * The `install.sh` bootstrap downloads Bun and this repository, then runs this file. Everything
 * that can fail is explicit and reversible: preflight → build a new release → atomically switch
 * the `current` symlink → restart → health check → roll back on failure.
 *
 * Usage:
 *   bun scripts/install/main.ts [options]
 *
 * Options:
 *   --yes                     non-interactive (all required values must be flags/env)
 *   --dry-run                 print the plan; change nothing
 *   --upgrade                 reuse /etc/skiff + data, build a new release
 *   --uninstall [--purge]     stop/remove units (purge also deletes data/config)
 *   --platform-host <host>    dashboard/API host (default control.kieran.dev)
 *   --content-domain <domain> sites domain (default kierancloud.dev)
 *   --acme-email <email>      ACME account email (required for TLS)
 *   --admin-email <email>     first-owner email; the installer prints a one-time magic link
 *   --cloudflare-token-file   Caddy DNS-01 token file (default /etc/caddy/cloudflare.token)
 *   --github-client-id/--github-client-secret
 *   --smtp-host/--smtp-port/--smtp-user/--smtp-password/--smtp-from
 *   --object-store local|r2   storage backend (default local)
 *   --r2-account-id/--r2-bucket/--r2-access-key-id/--r2-secret-access-key
 *   --no-agent                install the control plane only
 *   --version <label>         release label (default 0.1.0)
 */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';

const SOURCE = process.env.SKIFF_SOURCE_DIR ? resolve(process.env.SKIFF_SOURCE_DIR) : resolve(import.meta.dir, '../..');
const OPT_DIR = process.env.SKIFF_OPT_DIR ?? '/opt/skiff';
const ETC_DIR = process.env.SKIFF_ETC_DIR ?? '/etc/skiff';
const VAR_DIR = process.env.SKIFF_VAR_DIR ?? '/var/lib/skiff';
const RUN_DIR = process.env.SKIFF_RUN_DIR ?? '/run/skiff';
const SYSTEMD_DIR = process.env.SKIFF_SYSTEMD_DIR ?? '/etc/systemd/system';
const BUN_BIN = process.env.SKIFF_BUN_BIN ?? join(OPT_DIR, 'runtime', 'bin', 'bun');
const ENV_FILE = join(ETC_DIR, 'skiff.env');
const AGENT_ENV_FILE = join(ETC_DIR, 'agent.env');
const MASTER_KEY_FILE = join(ETC_DIR, 'master.key');
const SETUP_TOKEN_FILE = join(ETC_DIR, 'setup-token');

const color = {
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface Options {
	yes: boolean;
	dryRun: boolean;
	upgrade: boolean;
	uninstall: boolean;
	purge: boolean;
	platformHost: string;
	contentDomain: string;
	acmeEmail: string;
	adminEmail: string;
	cloudflareTokenFile: string;
	githubClientId?: string;
	githubClientSecret?: string;
	smtp?: { host: string; port: number; user: string; password: string; from: string };
	objectStore: 'local' | 'r2';
	r2?: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
	noAgent: boolean;
	version: string;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
	console.log(readFileSync(import.meta.path.replace(/main\.ts$/, 'USAGE.txt'), 'utf8'));
	process.exit(0);
}
function has(flag: string): boolean {
	return args.includes(flag);
}
function value(flag: string, fallback = ''): string {
	const index = args.indexOf(flag);
	return index >= 0 && args[index + 1] && !args[index + 1]!.startsWith('--') ? args[index + 1]! : fallback;
}

const options: Options = {
	yes: has('--yes') || process.env.SKIFF_YES === '1',
	dryRun: has('--dry-run'),
	upgrade: has('--upgrade'),
	uninstall: has('--uninstall'),
	purge: has('--purge'),
	platformHost: value('--platform-host', process.env.SKIFF_PLATFORM_HOST ?? 'control.kieran.dev'),
	contentDomain: value('--content-domain', process.env.SKIFF_CONTENT_DOMAIN ?? 'kierancloud.dev'),
	acmeEmail: value('--acme-email', process.env.SKIFF_ACME_EMAIL ?? ''),
	adminEmail: value('--admin-email', process.env.SKIFF_ADMIN_EMAIL ?? ''),
	cloudflareTokenFile: value('--cloudflare-token-file', process.env.SKIFF_CLOUDFLARE_TOKEN_FILE ?? '/etc/caddy/cloudflare.token'),
	githubClientId: value('--github-client-id', process.env.GITHUB_CLIENT_ID ?? '') || undefined,
	githubClientSecret: value('--github-client-secret', process.env.GITHUB_CLIENT_SECRET ?? '') || undefined,
	objectStore: (value('--object-store', process.env.SKIFF_OBJECT_STORE ?? 'local') as 'local' | 'r2') || 'local',
	noAgent: has('--no-agent'),
	version: value('--version', process.env.SKIFF_VERSION ?? '0.1.0'),
};

if (process.env.SKIFF_SMTP_HOST || args.includes('--smtp-host')) {
	options.smtp = {
		host: value('--smtp-host', process.env.SKIFF_SMTP_HOST ?? ''),
		port: Number(value('--smtp-port', process.env.SKIFF_SMTP_PORT ?? '587')),
		user: value('--smtp-user', process.env.SKIFF_SMTP_USER ?? ''),
		password: value('--smtp-password', process.env.SKIFF_SMTP_PASSWORD ?? ''),
		from: value('--smtp-from', process.env.SKIFF_SMTP_FROM ?? `Skiff <noreply@${options.contentDomain}>`),
	};
}
if (options.objectStore === 'r2') {
	options.r2 = {
		accountId: value('--r2-account-id', process.env.R2_ACCOUNT_ID ?? process.env.SKIFF_R2_ACCOUNT_ID ?? ''),
		bucket: value('--r2-bucket', process.env.R2_BUCKET ?? process.env.SKIFF_R2_BUCKET ?? ''),
		accessKeyId: value('--r2-access-key-id', process.env.R2_ACCESS_KEY_ID ?? process.env.SKIFF_R2_ACCESS_KEY_ID ?? ''),
		secretAccessKey: value('--r2-secret-access-key', process.env.R2_SECRET_ACCESS_KEY ?? process.env.SKIFF_R2_SECRET_ACCESS_KEY ?? ''),
	};
}

const interactive = process.stdin.isTTY && !options.yes && !options.dryRun;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function ask(question: string, fallback = ''): Promise<string> {
	if (!rl) return fallback;
	const answer = (await rl.question(`${question}${fallback ? color.dim(` [${fallback}]`) : ''}: `)).trim();
	return answer || fallback;
}
async function askSecret(question: string): Promise<string> {
	if (!rl) return '';
	return (await rl.question(`${question}: `)).trim();
}

function run(
	command: string,
	commandArgs: string[],
	opts: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {},
): { code: number; stdout: string; stderr: string } {
	const display = [command, ...commandArgs].join(' ');
	if (!opts.allowFailure) log(`$ ${display}`);
	const result = Bun.spawnSync({
		cmd: [command, ...commandArgs],
		cwd: opts.cwd,
		env: {
			...process.env,
			PATH: `${dirname(BUN_BIN)}:${process.env.PATH ?? ''}`,
			...(opts.env ?? {}),
		},
		stdout: opts.allowFailure ? 'pipe' : 'inherit',
		stderr: opts.allowFailure ? 'pipe' : 'inherit',
	});
	if (result.exitCode !== 0 && !opts.allowFailure) {
		throw new Error(`Command failed (${result.exitCode}): ${display}`);
	}
	return {
		code: result.exitCode ?? 0,
		stdout: result.stdout ? new TextDecoder().decode(result.stdout) : '',
		stderr: result.stderr ? new TextDecoder().decode(result.stderr) : '',
	};
}

function capture(command: string, commandArgs: string[]): string | null {
	const result = Bun.spawnSync({ cmd: [command, ...commandArgs], stdout: 'pipe', stderr: 'pipe' });
	if (result.exitCode !== 0) return null;
	return new TextDecoder().decode(result.stdout).trim();
}

function log(message: string): void {
	console.log(color.dim('  •'), message);
}

function step(title: string): void {
	console.log(`\n${color.bold(title)}`);
}

function fail(message: string): never {
	throw new Error(message);
}

function readEnvFile(path: string): Map<string, string> {
	const map = new Map<string, string>();
	if (!existsSync(path)) return map;
	for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const index = line.indexOf('=');
		if (index < 0) continue;
		map.set(line.slice(0, index), line.slice(index + 1));
	}
	return map;
}

function writeEnvFile(path: string, map: Map<string, string>, mode = 0o640): void {
	const body = [...map.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`)
		.join('\n');
	writeFileSync(`${path}.tmp`, `${body}\n`, { mode });
	renameSync(`${path}.tmp`, path);
}

function ensureDir(path: string, mode: string, owner: string): void {
	if (options.dryRun) {
		log(`would create ${path} (${mode} ${owner})`);
		return;
	}
	run('install', ['-d', '-m', mode, '-o', owner.split(':')[0]!, '-g', owner.split(':')[1] ?? owner, path]);
}

function base64(bytes: number): string {
	return randomBytes(bytes).toString('base64');
}

function validDomain(value: string): boolean {
	return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value) && !value.includes('..');
}

async function promptOptions(): Promise<void> {
	if (!interactive) return;
	step('Configuration');
	options.platformHost = await ask('Platform host (dashboard/API/MCP)', options.platformHost);
	options.contentDomain = await ask('Content domain for deployed sites', options.contentDomain);
	options.acmeEmail = await ask('ACME email for Let\'s Encrypt', options.acmeEmail);
	options.adminEmail = await ask('First owner email (magic link)', options.adminEmail);
	if (!existsSync(options.cloudflareTokenFile)) {
		const token = await askSecret(
			`Cloudflare DNS token (will be written to ${options.cloudflareTokenFile})`,
		);
		if (token) {
			options.cloudflareTokenFile = join(ETC_DIR, 'cloudflare.token');
			if (!options.dryRun) {
				mkdirSync(dirname(options.cloudflareTokenFile), { recursive: true });
				writeFileSync(options.cloudflareTokenFile, `${token}\n`, { mode: 0o640 });
				run('chown', ['root:caddy', options.cloudflareTokenFile], { allowFailure: true });
			}
		}
	}
}

function preflight(): void {
	step('Preflight');
	if (process.platform !== 'linux') fail('Skiff installs on Linux only.');
	if (process.getuid?.() !== 0) fail('Run the installer as root (curl … | sudo sh).');
	if (!existsSync('/run/systemd/system')) fail('systemd is required.');

	const os = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
	const id = /^ID=(.*)$/m.exec(os)?.[1]?.replace(/"/g, '') ?? '';
	const versionId = /^VERSION_ID=(.*)$/m.exec(os)?.[1]?.replace(/"/g, '') ?? '';
	if (!['debian', 'ubuntu'].includes(id)) {
		if (process.env.SKIFF_FORCE_OS !== '1') fail(`Unsupported OS "${id}". Debian/Ubuntu is required (SKIFF_FORCE_OS=1 to override).`);
		log(color.yellow(`warning: unsupported OS ${id}`));
	} else {
		log(`${id} ${versionId}`);
	}
	const arch = process.arch;
	if (!['x64', 'arm64'].includes(arch)) fail(`Unsupported architecture ${arch}.`);
	log(`${arch}, bun ${Bun.version}`);

	for (const command of ['systemctl', 'journalctl', 'caddy']) {
		if (!capture('sh', ['-c', `command -v ${command}`])) fail(`Required command not found: ${command}`);
	}
	const caddyBin = capture('sh', ['-c', 'command -v caddy'])!;
	const modules = capture(caddyBin, ['list-modules']) ?? '';
	if (!modules.includes('dns.providers.cloudflare'))
		fail(`Caddy at ${caddyBin} has no caddy-dns/cloudflare module. Install the Skiff Caddy build first.`);
	log(`caddy ${capture(caddyBin, ['version']) ?? 'unknown'}`);

	if (options.objectStore === 'r2') {
		const missing = Object.entries(options.r2 ?? {}).filter(([, v]) => !v).map(([k]) => k);
		if (missing.length) fail(`R2 selected but missing: ${missing.join(', ')}`);
	}
	if (!validDomain(options.platformHost)) fail(`Invalid platform host "${options.platformHost}".`);
	if (!validDomain(options.contentDomain)) fail(`Invalid content domain "${options.contentDomain}".`);
	if (!options.acmeEmail) {
		if (options.yes) fail('--acme-email is required for TLS.');
		options.acmeEmail = 'admin@' + options.contentDomain;
		log(color.yellow(`warning: no ACME email; using ${options.acmeEmail}`));
	}

	const disk = Bun.spawnSync({ cmd: ['df', '-Pk', '/'], stdout: 'pipe' });
	const line = new TextDecoder().decode(disk.stdout).split('\n')[1] ?? '';
	const availableKb = Number(line.trim().split(/\s+/)[3] ?? 0);
	if (availableKb > 0 && availableKb < 2_000_000) fail('At least 2 GB free disk is required.');

	if (options.platformHost === options.contentDomain || options.platformHost.endsWith(`.${options.contentDomain}`)) {
		log(color.yellow('warning: platform and content domains share a registrable domain (shared-domain mode).'));
	}
}

function ensureUsersAndDirs(): void {
	step('Users and directories');
	if (!capture('getent', ['group', 'skiff'])) {
		if (options.dryRun) log('would create skiff group');
		else run('groupadd', ['--system', 'skiff']);
	}
	if (!capture('getent', ['group', 'caddy'])) {
		if (options.dryRun) log('would create caddy group');
		else run('groupadd', ['--system', 'caddy']);
	}
	if (!capture('id', ['-u', 'skiff'])) {
		if (options.dryRun) log('would create skiff user');
		else run('useradd', ['--system', '--gid', 'skiff', '--home-dir', VAR_DIR, '--shell', '/usr/sbin/nologin', 'skiff']);
	}
	const groups = (capture('id', ['-nG', 'skiff']) ?? '').split(/\s+/);
	if (!groups.includes('caddy')) {
		if (options.dryRun) log('would add skiff to caddy group');
		else run('usermod', ['-aG', 'caddy', 'skiff']);
	}

	ensureDir(OPT_DIR, '0755', 'root:root');
	ensureDir(join(OPT_DIR, 'releases'), '0755', 'root:root');
	ensureDir(ETC_DIR, '0750', 'root:skiff');
	ensureDir(VAR_DIR, '0751', 'skiff:skiff');
	for (const sub of ['data', 'data/objects', 'agent', 'backups']) ensureDir(join(VAR_DIR, sub), '0750', 'skiff:skiff');
	ensureDir(RUN_DIR, '2770', 'root:caddy');
	if (!options.dryRun) {
		writeFileSync('/etc/tmpfiles.d/skiff.conf', '# Skiff runtime directory (setgid so Caddy and the agent share sockets)\nd /run/skiff 2770 root caddy -\n');
		run('systemd-tmpfiles', ['--create', '/etc/tmpfiles.d/skiff.conf'], { allowFailure: true });
	}
}

function writeSecrets(): Map<string, string> {
	step('Secrets and environment');
	const existing = readEnvFile(ENV_FILE);
	const master = existsSync(MASTER_KEY_FILE) ? readFileSync(MASTER_KEY_FILE, 'utf8').trim() : base64(32);
	if (!options.dryRun) {
		writeFileSync(MASTER_KEY_FILE, `${master}\n`, { mode: 0o400 });
		run('chown', ['root:root', MASTER_KEY_FILE], { allowFailure: true });
	}

	const env = new Map(existing);
	env.set('NODE_ENV', 'production');
	env.set('SKIFF_PLATFORM_ORIGIN', `https://${options.platformHost}`);
	env.set('SKIFF_CONTENT_DOMAIN', options.contentDomain);
	env.set('SKIFF_DATA_DIR', join(VAR_DIR, 'data'));
	env.set('SKIFF_OBJECT_STORE', options.objectStore);
	env.set('SKIFF_AGENT_VERSION', options.version);
	env.set('SKIFF_EDGE_NODE_ID', existing.get('SKIFF_EDGE_NODE_ID') ?? '');
	env.set('BETTER_AUTH_SECRET', existing.get('BETTER_AUTH_SECRET') ?? base64(48));
	env.set('SKIFF_SITE_COOKIE_SECRET', existing.get('SKIFF_SITE_COOKIE_SECRET') ?? base64(32));
	env.set('SKIFF_OBJECT_STORE_SECRET', existing.get('SKIFF_OBJECT_STORE_SECRET') ?? base64(32));
	env.set('SKIFF_DAILY_BACKUPS', '1');
	if (options.smtp) {
		env.set('SKIFF_SMTP_HOST', options.smtp.host);
		env.set('SKIFF_SMTP_PORT', String(options.smtp.port));
		env.set('SKIFF_SMTP_USER', options.smtp.user);
		env.set('SKIFF_SMTP_PASSWORD', options.smtp.password);
		env.set('SKIFF_SMTP_FROM', options.smtp.from);
	}
	if (options.githubClientId && options.githubClientSecret) {
		env.set('GITHUB_CLIENT_ID', options.githubClientId);
		env.set('GITHUB_CLIENT_SECRET', options.githubClientSecret);
	}
	if (options.objectStore === 'r2' && options.r2) {
		env.set('R2_ACCOUNT_ID', options.r2.accountId);
		env.set('R2_BUCKET', options.r2.bucket);
		env.set('R2_ACCESS_KEY_ID', options.r2.accessKeyId);
		env.set('R2_SECRET_ACCESS_KEY', options.r2.secretAccessKey);
	}
	if (!options.dryRun) {
		writeEnvFile(ENV_FILE, env);
		run('chown', ['root:skiff', ENV_FILE], { allowFailure: true });
		run('chmod', ['0640', ENV_FILE], { allowFailure: true });
	}
	if (!existsSync(SETUP_TOKEN_FILE) && !options.dryRun) {
		writeFileSync(SETUP_TOKEN_FILE, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
	}
	return env;
}

function buildRelease(env: Map<string, string>): string {
	step('Build release');
	const releaseName = `v${options.version}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
	const release = join(OPT_DIR, 'releases', releaseName);
	if (options.dryRun) {
		log(`would build into ${release}`);
		return release;
	}
	rmSync(release, { recursive: true, force: true });
	mkdirSync(release, { recursive: true });
	log(`copying source from ${SOURCE}`);
	cpSync(SOURCE, join(release, 'repo'), {
		recursive: true,
		filter: (path) => {
			const normalized = path.replaceAll('\\', '/');
			if (normalized.includes('/.git/') || normalized.endsWith('/.git')) return false;
			if (normalized.includes('/node_modules')) return false;
			if (normalized.includes('/.svelte-kit')) return false;
			if (normalized.includes('/.data')) return false;
			if (normalized.endsWith('/dist') || normalized.includes('/dist/')) return false;
			if (/\/spikes\/[^/]+\/(tmp|bin)/.test(normalized)) return false;
			return true;
		},
	});
	ensureDir(join(release, 'runtime', 'bin'), '0755', 'root:root');
	run('ln', ['-sf', BUN_BIN, join(release, 'runtime', 'bin', 'bun')]);
	run('ln', ['-sf', BUN_BIN, join(release, 'runtime', 'bin', 'bunx')]);
	run('ln', ['-sf', BUN_BIN, join(release, 'runtime', 'bun')]);
	run('ln', ['-sf', BUN_BIN, join(release, 'runtime', 'bunx')]);
	ensureDir(join(release, 'agent'), '0755', 'root:root');

	run(BUN_BIN, ['install', '--frozen-lockfile'], { cwd: join(release, 'repo') });
	run(BUN_BIN, ['run', '--cwd', 'apps/control-plane', 'build'], { cwd: join(release, 'repo') });
	run(BUN_BIN, ['run', '--cwd', 'apps/agent', 'build'], { cwd: join(release, 'repo') });
	cpSync(join(release, 'repo', 'apps', 'agent', 'dist', 'skiff-agent'), join(release, 'agent', 'skiff-agent'));
	chmodSync(join(release, 'agent', 'skiff-agent'), 0o755);
	writeFileSync(
		join(release, 'meta.json'),
		`${JSON.stringify(
			{
				version: options.version,
				builtAt: new Date().toISOString(),
				source: process.env.SKIFF_SOURCE_REF ?? 'local',
				// Read by skiff-update-self to know where to pull updates from.
				...(process.env.SKIFF_REPO ? { repo: process.env.SKIFF_REPO } : {}),
				...(process.env.SKIFF_SOURCE_REF ? { ref: process.env.SKIFF_SOURCE_REF } : {}),
			},
			null,
			2,
		)}\n`,
	);
	return release;
}

function writeUnits(): void {
	step('systemd units');
	ensureCaddyAccess();
	const control = `[Unit]
Description=Skiff control plane (dashboard, REST, MCP)
After=network-online.target caddy.service
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=skiff
Group=skiff
SupplementaryGroups=caddy
UMask=0007
WorkingDirectory=${OPT_DIR}/current/repo/apps/control-plane
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=SOCKET_PATH=${RUN_DIR}/control.sock
Environment=PROTOCOL_HEADER=x-forwarded-proto
Environment=HOST_HEADER=x-forwarded-host
Environment=SKIFF_MASTER_KEY_FILE=%d/master-key
LoadCredential=master-key:${MASTER_KEY_FILE}
ExecStart=${OPT_DIR}/current/runtime/bun ${OPT_DIR}/current/repo/apps/control-plane/build/index.js
Restart=on-failure
RestartSec=2
TimeoutStopSec=35
KillSignal=SIGTERM
LimitNOFILE=65535
TasksMax=256
MemoryMax=512M
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
ReadWritePaths=${VAR_DIR} ${RUN_DIR}

[Install]
WantedBy=multi-user.target
`;
	const agent = `[Unit]
Description=Skiff node agent
After=network-online.target caddy.service
Wants=network-online.target
ConditionPathExists=${AGENT_ENV_FILE}
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=skiff
Group=skiff
SupplementaryGroups=caddy
UMask=0007
WorkingDirectory=${OPT_DIR}/current/agent
EnvironmentFile=${ENV_FILE}
EnvironmentFile=-${AGENT_ENV_FILE}
Environment=SKIFF_AGENT_SOCKET=${RUN_DIR}/agent.sock
Environment=SKIFF_CADDY_ADMIN_SOCKET=${detectCaddyAdminSocket()}
ExecStart=${OPT_DIR}/current/agent/skiff-agent
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
ReadWritePaths=${VAR_DIR} ${RUN_DIR}

[Install]
WantedBy=multi-user.target
`;
	if (options.dryRun) {
		log('would write skiff-control-plane.service and skiff-agent.service');
		return;
	}
	writeFileSync(join(SYSTEMD_DIR, 'skiff-control-plane.service'), control);
	writeFileSync(join(SYSTEMD_DIR, 'skiff-agent.service'), agent);
	run('systemctl', ['daemon-reload']);
}

function detectCaddyAdminSocket(): string {
	const candidates = ['/var/lib/caddy/admin.sock', '/run/caddy/admin.sock', '/etc/caddy/admin.sock'];
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	const caddyfile = capture('sh', ['-c', 'grep -E "^[[:space:]]*admin[[:space:]]+" /etc/caddy/Caddyfile | head -1']) ?? '';
	const match = /admin\s+unix\/(\/[^\s]+)/.exec(caddyfile);
	return match?.[1] ?? '/var/lib/caddy/admin.sock';
}

/**
 * Caddy creates its admin socket 0600. The agent must reach it, so grant the caddy group
 * read/write and make the change survive Caddy restarts. The socket is never exposed on TCP.
 */
function ensureCaddyAccess(): void {
	const socket = detectCaddyAdminSocket();
	if (options.dryRun) {
		log(`would grant group caddy rw on ${socket} and add a Caddy drop-in`);
		return;
	}
	const dropInDir = '/etc/systemd/system/caddy.service.d';
	mkdirSync(dropInDir, { recursive: true });
	writeFileSync(
		join(dropInDir, 'skiff-admin-socket.conf'),
		`[Service]\n# Caddy reads deployed artifacts from the agent cache and the agent needs the admin socket.\nSupplementaryGroups=skiff\nExecStartPost=/usr/bin/chmod 0660 ${socket}\n`,
	);
	run('systemctl', ['daemon-reload'], { allowFailure: true });
	if (existsSync(socket)) run('chmod', ['0660', socket], { allowFailure: true });
	const groups = capture('systemctl', ['show', 'caddy', '-p', 'SupplementaryGroups', '--value']) ?? '';
	if (!groups.split(/\s+/).includes('skiff'))
		run('systemctl', ['restart', 'caddy'], { allowFailure: true });
}

function switchCurrent(release: string): void {
	step('Activate release');
	const link = join(OPT_DIR, 'current');
	const tmp = `${link}.new`;
	if (options.dryRun) {
		log(`would point ${link} -> ${release}`);
		return;
	}
	// Keep the outgoing release as `previous` so `skiff-update-self rollback` can return to it.
	const outgoing = existsSync(link) ? capture('readlink', ['-f', link]) : null;
	if (outgoing && outgoing !== release) {
		const previous = join(OPT_DIR, 'previous');
		rmSync(`${previous}.new`, { force: true });
		run('ln', ['-s', outgoing, `${previous}.new`]);
		renameSync(`${previous}.new`, previous);
	}
	rmSync(tmp, { force: true });
	run('ln', ['-s', release, tmp]);
	renameSync(tmp, link);
	log(`${link} -> ${release}`);
}

/**
 * `skiff-update-self` runs the updater from the active release (falling back to the previous one,
 * e.g. after rolling back to a release that predates the updater), never from the release it is
 * about to install.
 */
function installUpdateCommand(): void {
	const path = '/usr/local/sbin/skiff-update-self';
	if (options.dryRun) {
		log(`would install ${path}`);
		return;
	}
	const script = `#!/bin/sh
# Installed by the Skiff installer. See docs/OPS.md §4.1.
set -eu
for release in ${OPT_DIR}/current ${OPT_DIR}/previous; do
	if [ -f "$release/repo/scripts/update-self/main.ts" ]; then
		exec ${BUN_BIN} "$release/repo/scripts/update-self/main.ts" "$@"
	fi
done
echo "skiff-update-self: no release under ${OPT_DIR} ships the updater; re-run the installer" >&2
exit 1
`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, script, { mode: 0o755 });
	renameSync(`${path}.tmp`, path);
	log(`installed ${path}`);
}

function waitFor(label: string, check: () => boolean, timeoutMs = 60_000): void {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		Bun.sleepSync(500);
	}
	fail(`Timed out waiting for ${label}.`);
}

function startServices(): void {
	step('Start services');
	if (options.dryRun) {
		log('would enable and restart skiff-control-plane, skiff-agent');
		return;
	}
	run('systemctl', ['enable', 'skiff-control-plane.service']);
	run('systemctl', ['restart', 'skiff-control-plane.service']);
	waitFor('control plane socket', () => existsSync(join(RUN_DIR, 'control.sock')), 90_000);
	patchCaddyfilePlatform();
	if (!options.noAgent && existsSync(AGENT_ENV_FILE)) {
		run('systemctl', ['enable', 'skiff-agent.service']);
		run('systemctl', ['restart', 'skiff-agent.service']);
		waitFor('agent socket', () => existsSync(join(RUN_DIR, 'agent.sock')), 90_000);
	}
}

/**
 * The agent pulls desired state over the platform hostname. Point the bootstrap Caddyfile at the
 * control-plane unix socket before the agent starts, otherwise it would 502 until the full config
 * is applied (the agent cannot apply it without reaching the control plane first).
 */
function patchCaddyfilePlatform(): void {
	const path = '/etc/caddy/Caddyfile';
	if (options.dryRun || !existsSync(path)) return;
	const original = readFileSync(path, 'utf8');
	let updated = original;

	// Caddy's admin socket defaults to 0200. The agent needs group access, so use Caddy's
	// documented `unix//path|0660` suffix (never expose the admin API on TCP).
	const socketPath = detectCaddyAdminSocket();
	const absolute = socketPath.startsWith('/') ? socketPath : `/${socketPath}`;
	updated = updated.replace(
		/^(\s*)admin\s+unix\/\/\S+.*$/m,
		`$1admin unix/${absolute}|0660`,
	);

	if (updated.includes(options.platformHost)) {
		updated = updated.replace(
			/reverse_proxy\s+127\.0\.0\.1:3000/g,
			'reverse_proxy unix//run/skiff/control.sock',
		);
	} else {
		log(color.yellow(`warning: ${path} has no ${options.platformHost} block; the agent will add it`));
	}

	if (updated === original) return;
	writeFileSync('/etc/caddy/Caddyfile.pre-skiff', original);
	writeFileSync(path, updated);
	run('systemctl', ['reload', 'caddy'], { allowFailure: true });
	log('Caddy platform upstream and admin socket permissions updated');
}

function bootstrapNode(env: Map<string, string>, release: string): void {
	if (options.noAgent) return;
	step('Enroll edge node');
	if (options.dryRun) {
		log('would create an edge node and write /etc/skiff/agent.env');
		return;
	}
	const platformOrigin = env.get('SKIFF_PLATFORM_ORIGIN')!;
	const platformHost = new URL(platformOrigin).host;
	waitFor(
		'control plane HTTP',
		() => (capture('curl', ['-fsS', '--unix-socket', join(RUN_DIR, 'control.sock'), '-H', `Host: ${platformHost}`, '-H', 'X-Forwarded-Proto: https', '-H', `X-Forwarded-Host: ${platformHost}`, 'http://localhost/api/setup/status']) ?? '').includes('needsSetup'),
		60_000,
	);
	const script = join(release, 'repo', 'scripts', 'install', 'bootstrap-node.ts');
	const result = run(BUN_BIN, ['run', script], {
		cwd: join(release, 'repo'),
		env: {
			SKIFF_DATA_DIR: env.get('SKIFF_DATA_DIR')!,
			SKIFF_PLATFORM_ORIGIN: platformOrigin,
			SKIFF_CONTENT_DOMAIN: env.get('SKIFF_CONTENT_DOMAIN')!,
			SKIFF_SITE_COOKIE_SECRET: env.get('SKIFF_SITE_COOKIE_SECRET')!,
			SKIFF_OBJECT_STORE_SECRET: env.get('SKIFF_OBJECT_STORE_SECRET')!,
			SKIFF_MASTER_KEY_FILE: MASTER_KEY_FILE,
			SKIFF_AGENT_ENV_FILE: AGENT_ENV_FILE,
			SKIFF_PLATFORM_HOST: platformHost,
			SKIFF_PLATFORM_UPSTREAM: `unix/${join(RUN_DIR, 'control.sock')}`,
			SKIFF_ACME_EMAIL: options.acmeEmail,
			SKIFF_CLOUDFLARE_API_TOKEN_FILE: options.cloudflareTokenFile,
			SKIFF_CADDY_ADMIN_SOCKET: detectCaddyAdminSocket(),
		},
	});
	if (result.code !== 0) fail('Node enrollment failed.');
	// The agent unit is gated on agent.env; restart to pick it up.
	run('systemctl', ['restart', 'skiff-agent.service']);
}

function publicHealth(env: Map<string, string>): void {
	if (options.dryRun) return;
	const origin = env.get('SKIFF_PLATFORM_ORIGIN')!;
	step('Health check');
	waitFor(
		`${origin}/api/setup/status`,
		() => {
			const result = Bun.spawnSync({
				cmd: ['curl', '-fsS', '--max-time', '10', `${origin}/api/setup/status`],
				stdout: 'pipe',
				stderr: 'pipe',
			});
			return result.exitCode === 0;
		},
		120_000,
	);
	log(`${origin} is responding`);
}

function requestMagicLink(env: Map<string, string>): void {
	if (options.dryRun) return;
	if (!options.adminEmail) return;
	step('First owner');
	const origin = env.get('SKIFF_PLATFORM_ORIGIN')!;
	const result = Bun.spawnSync({
		cmd: [
			'curl',
			'-fsS',
			'--unix-socket',
			join(RUN_DIR, 'control.sock'),
			'-H',
			`Host: ${new URL(origin).host}`,
			'-H',
			'X-Forwarded-Proto: https',
			'-H',
			`X-Forwarded-Host: ${new URL(origin).host}`,
			'-H',
			`Origin: ${origin}`,
			'-H',
			'content-type: application/json',
			'-X',
			'POST',
			'--data',
			JSON.stringify({ email: options.adminEmail, callbackURL: `${origin}/overview` }),
			'http://localhost/api/auth/sign-in/magic-link',
		],
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (result.exitCode !== 0) {
		log(color.yellow('could not request a magic link automatically; open /login and request one'));
		return;
	}
	if (options.smtp) {
		console.log(`\n${color.green('Sign-in email sent to')} ${options.adminEmail}`);
		return;
	}
	Bun.sleepSync(1000);
	const journal = capture('journalctl', ['-u', 'skiff-control-plane', '-n', '200', '--no-pager']) ?? '';
	const link = [...journal.matchAll(/https:\/\/[^\s]+\/api\/auth\/magic-link\/verify[^\s]+/g)].at(-1)?.[0];
	if (!link) {
		log(color.yellow('magic link not found in the journal; request one from /login'));
		return;
	}
	console.log(`\n${color.green('One-time sign-in link (also in journalctl -u skiff-control-plane):')}`);
	console.log(link);
}

/** Atomically point `link` at `target` (or remove it when `target` is null). */
function relink(link: string, target: string | null): void {
	if (!target) {
		rmSync(link, { force: true });
		return;
	}
	rmSync(`${link}.new`, { force: true });
	Bun.spawnSync({ cmd: ['ln', '-s', target, `${link}.new`], stdout: 'ignore', stderr: 'ignore' });
	renameSync(`${link}.new`, link);
}

function rollback(previous: string | null, snapshot: string | null, previousLink: string | null): void {
	console.error(color.red('\nInstall failed. Rolling back…'));
	for (const service of ['skiff-agent', 'skiff-control-plane']) {
		Bun.spawnSync({ cmd: ['systemctl', 'stop', `${service}.service`], stdout: 'ignore', stderr: 'ignore' });
	}
	if (snapshot && existsSync(snapshot)) {
		const target = join(VAR_DIR, 'data', 'skiff.db');
		rmSync(`${target}-wal`, { force: true });
		rmSync(`${target}-shm`, { force: true });
		copyFileSync(snapshot, target);
		console.error(color.yellow(`restored database snapshot ${snapshot}`));
	}
	if (previous) {
		relink(join(OPT_DIR, 'current'), previous);
		// switchCurrent() moved `previous` to the outgoing release; put back the real fallback.
		relink(join(OPT_DIR, 'previous'), previousLink && previousLink !== previous ? previousLink : null);
		console.error(color.yellow(`restored ${previous}`));
	}
	Bun.spawnSync({ cmd: ['systemctl', 'start', 'skiff-control-plane.service'], stdout: 'ignore', stderr: 'ignore' });
	if (!options.noAgent && existsSync(AGENT_ENV_FILE))
		Bun.spawnSync({ cmd: ['systemctl', 'start', 'skiff-agent.service'], stdout: 'ignore', stderr: 'ignore' });
}

/** Consistent SQLite snapshot without requiring the sqlite3 CLI. */
function snapshotDatabase(dbPath: string, destination: string): void {
	const sql = `VACUUM INTO '${destination.replaceAll("'", "''")}'`;
	run(BUN_BIN, [
		'-e',
		`import { Database } from 'bun:sqlite'; const db = new Database(${JSON.stringify(dbPath)}, { create: true, strict: true }); db.run('PRAGMA busy_timeout=5000'); db.run(${JSON.stringify(sql)}); db.close();`,
	]);
}

async function install(): Promise<void> {
	if (!options.upgrade) await promptOptions();
	preflight();
	ensureUsersAndDirs();
	const env = writeSecrets();
	const previousRelease = existsSync(join(OPT_DIR, 'current'))
		? capture('readlink', ['-f', join(OPT_DIR, 'current')])
		: null;
	const previousLink = existsSync(join(OPT_DIR, 'previous'))
		? capture('readlink', ['-f', join(OPT_DIR, 'previous')])
		: null;
	let snapshot: string | null = null;
	let release: string | null = null;
	try {
		if (options.upgrade && existsSync(join(VAR_DIR, 'data', 'skiff.db'))) {
			step('Snapshot SQLite');
			snapshot = join(VAR_DIR, 'backups', `pre-upgrade-${Date.now()}.db`);
			if (!options.dryRun) snapshotDatabase(join(VAR_DIR, 'data', 'skiff.db'), snapshot);
			log(snapshot);
		}
		release = buildRelease(env);
		switchCurrent(release);
		installUpdateCommand();
		writeUnits();
		startServices();
		bootstrapNode(env, release);
		if (!options.noAgent) {
			// Wait for the agent to reconcile and Caddy to serve the platform route.
			publicHealth(env);
		}
		requestMagicLink(env);
		step('Installed');
		console.log(`${color.green('Skiff is installed.')} Platform: ${env.get('SKIFF_PLATFORM_ORIGIN')}`);
		console.log(`Logs: ${color.dim('journalctl -u skiff-control-plane -f')}  ${color.dim('journalctl -u skiff-agent -f')}`);
	} catch (error) {
		console.error(color.red(`\nError: ${(error as Error).message}`));
		if (!options.dryRun) rollback(previousRelease, snapshot, previousLink);
		process.exit(1);
	}
}

function uninstall(): void {
	step('Uninstall');
	if (options.dryRun) {
		log('would stop/disable/remove skiff units and, with --purge, delete data');
		return;
	}
	for (const service of ['skiff-agent', 'skiff-control-plane']) {
		run('systemctl', ['disable', '--now', `${service}.service`], { allowFailure: true });
		rmSync(join(SYSTEMD_DIR, `${service}.service`), { force: true });
	}
	run('systemctl', ['daemon-reload'], { allowFailure: true });
	if (options.purge) {
		run('rm', ['-rf', OPT_DIR, VAR_DIR, ETC_DIR]);
		log('removed data and configuration');
	} else {
		log(`kept ${VAR_DIR} and ${ETC_DIR}; re-run with --uninstall --purge to delete`);
	}
}

const main = async (): Promise<void> => {
	console.log(`${color.bold('Skiff installer')} ${options.version}`);
	if (options.uninstall) return uninstall();
	return install();
};

main()
	.catch((error: unknown) => {
		console.error(color.red(`\nInstaller error: ${(error as Error).message}`));
		process.exit(1);
	})
	.finally(() => rl?.close());
