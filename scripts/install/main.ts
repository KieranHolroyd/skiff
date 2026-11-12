#!/usr/bin/env bun
/**
 * Yoal installer / upgrader.
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
 *   --upgrade                 reuse /etc/yoal + data, build a new release
 *   --uninstall [--purge]     stop/remove units (purge also deletes data/config)
 *   --platform-host <host>    dashboard/API domain; blank serves the dashboard at http://<server-ip>
 *   --content-domain <domain> sites domain; blank uses the temporary <server-ip>.sslip.io (HTTP)
 *   --acme-email <email>      ACME account email; turns on HTTPS (needs real domains)
 *   --public-address <ipv4>   this server's address for IP-only installs (default: detected)
 *   --skip-deps               don't install Caddy, Podman or the storage tools (they must already be there)
 *   --admin-email <email>     prefills the owner email in the setup wizard (optional)
 *   --cloudflare-token-file   optional Caddy DNS-01 token file, used only if it exists
 *                             (default /etc/caddy/cloudflare.token)
 *   --skip-dns-check          do not check that the domains resolve before installing
 *   --github-client-id/--github-client-secret
 *   --smtp-host/--smtp-port/--smtp-user/--smtp-password/--smtp-from
 *   --object-store local|r2   storage backend (default local)
 *   --r2-account-id/--r2-bucket/--r2-access-key-id/--r2-secret-access-key
 *   --no-agent                install the control plane only
 *   --no-python               skip warming the Pyodide cache Python functions need (D121; ~36 MB)
 *   --with-php                install the pinned FrankenPHP runtime for PHP process apps (D121;
 *                             ~175 MB; or YOAL_INSTALL_PHP=1)
 *   --no-node                 skip the pinned Node.js LTS for Node.js process apps (D125; ~190 MB;
 *                             or YOAL_NO_NODE=1)
 *   --version <label>         release label (default: the repository VERSION file)
 *   --canary                  follow the canary channel (install.sh then builds main instead of
 *                             the newest stable release; D128)
 */
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { confirm } from './confirm.ts';
import { randomBytes } from 'node:crypto';
import { isSelfUpdateChannel, SELF_UPDATE_DEFAULTS, type SelfUpdateChannel } from '../../packages/contracts/src/self-update.ts';
import { parseSemver } from '../../packages/contracts/src/semver.ts';
import { TRIGGER_PATH_UNIT, triggerUnits, updateCommandScript } from '../update-self/units.ts';
import { controlPlaneUnits, DEFAULT_CONTROL_PLANE_PATHS, ensureMasterKeyDropIns, GUARD_UNIT, MASTER_KEY_DROP_IN, PRIMARY_UNIT, STANDBY_UNIT } from '../systemd/control-plane.ts';
import { CONFIG_COMMAND, CONFIG_PATH_UNIT, CONFIG_SERVICE_UNIT, ensurePlatformConfigUnits } from '../platform-config/units.ts';
import { readEnvFile, writeEnvFile } from './env-file.ts';
import { ensureVapidKeys } from '../../packages/contracts/src/vapid.ts';
import { ensureWorkerd, pinnedWorkerdVersion, workerdArch } from './workerd.ts';
import { ensureFrankenphp, frankenphpArch, FRANKENPHP_LINK, FRANKENPHP_PINNED_VERSION } from './frankenphp.ts';
import { ensureNode, nodeArch, NODE_OPT_OUT_MARKER, NODE_PINNED_VERSION } from './node.ts';
import { pythonBundleEras, warmPyodideCache } from './pyodide.ts';
import { checkDns, digLookup, dnsTargets, parseServerAddresses, resolverLookup, type DnsResult } from './dns-check.ts';
import { parseGetentGroupId, processHasGroup } from './caddy-access.ts';
import { probeServedCertificate, tlsPortFromListen, wildcardProbeHost } from './tls-check.ts';
import {
	CONTROL_SOCKET,
	isDomainName,
	isIpv4,
	isTemporaryContentDomain,
	temporaryContentDomain,
} from '../../packages/contracts/src/platform-domains.ts';
import { BUILDER_UNIT, ensureBuilder, linkAgentCommands } from '../systemd/builder.ts';
import { HELPER_UNIT, ensureHelper } from '../systemd/helper.ts';
import { ensureStorageUnits, STORAGE_PATH_UNIT } from '../systemd/storage.ts';
import { STUDIO_UNIT, studioUnit } from '../systemd/studio.ts';
import { MAIL_UNIT, mailUnit } from '../systemd/mail.ts';
import { IDENTITY_LITESTREAM_UNIT, IDENTITY_UNIT, identityLitestreamUnit, identityUnit } from '../systemd/identity.ts';
import { agentUnit, CADDY_ACCESS_LOG, detectCaddyAdminSocket } from '../systemd/agent.ts';
import { CLI_COMMANDS, ensureHostCommands, RELEASE_COMMANDS } from './commands.ts';
import { ensureMasterKey, finishMasterKeyMigration, revertMasterKeyMigration, type EnsureMasterKeyResult } from './master-key.ts';
import { CLICKHOUSE_UNIT, clickhouseInstalled, ensureClickHouse, removeClickHouseUnit } from '../systemd/clickhouse.ts';
import {
	createUpgradeSnapshotBundle,
	pruneUpgradeSnapshotBundles,
	readDesiredStateVersion,
	retireUpgradeSnapshotBundles
} from '../../packages/core/src/upgrade-plan.ts';

const SOURCE = process.env.YOAL_SOURCE_DIR ? resolve(process.env.YOAL_SOURCE_DIR) : resolve(import.meta.dir, '../..');
const OPT_DIR = process.env.YOAL_OPT_DIR ?? '/opt/yoal';
const ETC_DIR = process.env.YOAL_ETC_DIR ?? '/etc/yoal';
const VAR_DIR = process.env.YOAL_VAR_DIR ?? '/var/lib/yoal';
const RUN_DIR = process.env.YOAL_RUN_DIR ?? '/run/yoal';
const SYSTEMD_DIR = process.env.YOAL_SYSTEMD_DIR ?? '/etc/systemd/system';
const BUN_BIN = process.env.YOAL_BUN_BIN ?? join(OPT_DIR, 'runtime', 'bin', 'bun');
const ENV_FILE = join(ETC_DIR, 'yoal.env');
const AGENT_ENV_FILE = join(ETC_DIR, 'agent.env');
const MASTER_KEY_FILE = join(ETC_DIR, 'master.key');
const SETUP_TOKEN_FILE = join(ETC_DIR, 'setup-token');

/** The platform version is the repository-root VERSION file (semver); yoal-update-self compares it. */
function sourceVersion(): string {
	try {
		const raw = readFileSync(join(SOURCE, 'VERSION'), 'utf8');
		const parsed = parseSemver(raw);
		if (parsed) return parsed.version;
		console.warn(`warning: ${join(SOURCE, 'VERSION')} is not semver ("${raw.trim()}"); using 0.0.0`);
	} catch {
		console.warn(`warning: no VERSION file in ${SOURCE}; using 0.0.0`);
	}
	return '0.0.0';
}

/** Version from an existing release's meta.json, or null for a first install. */
function releaseVersion(release: string | null): string | null {
	if (!release) return null;
	try {
		const meta = JSON.parse(readFileSync(join(release, 'meta.json'), 'utf8')) as { version?: unknown };
		return typeof meta.version === 'string' ? meta.version : null;
	} catch {
		return null;
	}
}

/** Migration file names in the target/source tree, recorded in the pre-upgrade bundle. */
function migrationIds(root: string): string[] {
	try {
		return readdirSync(join(root, 'packages', 'db', 'migrations'))
			.filter((name) => /^\d{4}_.*\.sql$/.test(name))
			.sort();
	} catch {
		return [];
	}
}

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
	/** HTTPS through Let's Encrypt; decided by resolveDomains() (D105). */
	tls: boolean;
	/** Server IPv4 for IP-only installs (--public-address / YOAL_PUBLIC_HOST, else detected). */
	publicAddress: string;
	adminEmail: string;
	cloudflareTokenFile: string;
	skipDnsCheck: boolean;
	/** Leave package installation (Caddy, Podman) to the operator. */
	skipDeps: boolean;
	githubClientId?: string;
	githubClientSecret?: string;
	smtp?: { host: string; port: number; user: string; password: string; from: string };
	objectStore: 'local' | 'r2';
	r2?: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string };
	noAgent: boolean;
	/** Install the pinned FrankenPHP binary for PHP process apps (D121). Opt-in: it is large. */
	withPhp: boolean;
	/** Skip the Pyodide cache for Python functions (D121). */
	noPython: boolean;
	/** Skip the pinned Node.js for Node.js process apps (D125). */
	noNode: boolean;
	/**
	 * Install the optional ClickHouse telemetry store (D101). Undefined: ask (interactive), else no.
	 * A host that already has it keeps it either way unless --no-clickhouse.
	 */
	clickhouse?: boolean;
	version: string;
	/** The release channel the self-updater follows (D128). Stable unless --canary. */
	channel: SelfUpdateChannel;
	/**
	 * `--join <control-url>`: install this machine as a worker of an existing control plane on the
	 * managed overlay (docs/CLUSTERING.md §4.1, C1) instead of installing a control plane.
	 */
	join?: { controlUrl: string; token: string; name: string; endpoint: string };
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

/**
 * Re-running the installer (with or without --upgrade) must not reset an existing install: every
 * setting defaults to flag → process env → the current /etc/yoal/yoal.env → built-in default.
 */
const existingEnv = (() => {
	try {
		return readEnvFile(ENV_FILE);
	} catch {
		return new Map<string, string>();
	}
})();
function existingHost(key: string): string | undefined {
	const raw = existingEnv.get(key);
	if (!raw) return undefined;
	try {
		return new URL(raw).host;
	} catch {
		return undefined;
	}
}
function setting(flag: string, envKeys: string[], fallback = ''): string {
	for (const key of envKeys) {
		const fromProcess = process.env[key];
		if (fromProcess) return value(flag, fromProcess);
	}
	for (const key of envKeys) {
		const fromFile = existingEnv.get(key);
		if (fromFile) return value(flag, fromFile);
	}
	return value(flag, fallback);
}

/**
 * --canary, else what install.sh resolved (YOAL_CHANNEL or the host's remembered channel), else
 * the existing yoal.env default, else stable. A fresh install follows promoted releases only.
 */
function installChannel(): SelfUpdateChannel {
	if (has('--canary')) return 'canary';
	for (const candidate of [process.env.YOAL_INSTALL_CHANNEL, process.env.YOAL_CHANNEL, existingEnv.get('YOAL_UPDATE_CHANNEL')]) {
		if (!candidate) continue;
		if (isSelfUpdateChannel(candidate)) return candidate;
		console.error(`release channel must be stable or canary (got "${candidate}")`);
		process.exit(64);
	}
	return 'stable';
}

const options: Options = {
	yes: has('--yes') || process.env.YOAL_YES === '1',
	dryRun: has('--dry-run'),
	upgrade: has('--upgrade'),
	uninstall: has('--uninstall'),
	purge: has('--purge'),
	platformHost: value(
		'--platform-host',
		process.env.YOAL_PLATFORM_HOST ?? existingHost('YOAL_PLATFORM_ORIGIN') ?? '',
	),
	contentDomain: setting('--content-domain', ['YOAL_CONTENT_DOMAIN'], ''),
	acmeEmail: setting('--acme-email', ['YOAL_ACME_EMAIL']),
	tls: false,
	publicAddress: value('--public-address', process.env.YOAL_PUBLIC_HOST ?? ''),
	adminEmail: value('--admin-email', process.env.YOAL_ADMIN_EMAIL ?? ''),
	cloudflareTokenFile: setting('--cloudflare-token-file', ['YOAL_CLOUDFLARE_TOKEN_FILE'], '/etc/caddy/cloudflare.token'),
	skipDnsCheck: has('--skip-dns-check'),
	skipDeps: has('--skip-deps') || process.env.YOAL_SKIP_DEPS === '1',
	githubClientId: setting('--github-client-id', ['GITHUB_CLIENT_ID']) || undefined,
	githubClientSecret: setting('--github-client-secret', ['GITHUB_CLIENT_SECRET']) || undefined,
	objectStore: (setting('--object-store', ['YOAL_OBJECT_STORE'], 'local') as 'local' | 'r2') || 'local',
	noAgent: has('--no-agent'),
	withPhp: has('--with-php') || process.env.YOAL_INSTALL_PHP === '1',
	noPython: has('--no-python') || process.env.YOAL_NO_PYTHON === '1',
	noNode: has('--no-node') || process.env.YOAL_NO_NODE === '1',
	clickhouse: has('--no-clickhouse')
		? false
		: has('--clickhouse') || process.env.YOAL_INSTALL_CLICKHOUSE === '1'
			? true
			: undefined,
	version: value('--version', process.env.YOAL_VERSION ?? sourceVersion()),
	channel: installChannel(),
};
if (has('--join')) {
	const controlUrl = value('--join');
	const token = value('--token', process.env.YOAL_JOIN_TOKEN ?? '');
	const name = value('--name', '');
	if (!controlUrl || !token || !name) {
		console.error('--join needs <control-url>, --token <join-token> and --name <node-name>');
		process.exit(64);
	}
	options.join = { controlUrl: controlUrl.replace(/\/+$/, ''), token, name, endpoint: value('--endpoint', '') };
}
if (options.objectStore !== 'local' && options.objectStore !== 'r2') {
	console.error(`--object-store must be local or r2 (got "${options.objectStore}")`);
	process.exit(64);
}

if (process.env.YOAL_SMTP_HOST || args.includes('--smtp-host') || existingEnv.get('YOAL_SMTP_HOST')) {
	options.smtp = {
		host: setting('--smtp-host', ['YOAL_SMTP_HOST']),
		port: Number(setting('--smtp-port', ['YOAL_SMTP_PORT'], '587')),
		user: setting('--smtp-user', ['YOAL_SMTP_USER']),
		password: setting('--smtp-password', ['YOAL_SMTP_PASSWORD']),
		from: setting('--smtp-from', ['YOAL_SMTP_FROM'], `Yoal <noreply@${options.contentDomain}>`),
	};
}
if (options.objectStore === 'r2') {
	options.r2 = {
		accountId: setting('--r2-account-id', ['R2_ACCOUNT_ID', 'YOAL_R2_ACCOUNT_ID']),
		bucket: setting('--r2-bucket', ['R2_BUCKET', 'YOAL_R2_BUCKET']),
		accessKeyId: setting('--r2-access-key-id', ['R2_ACCESS_KEY_ID', 'YOAL_R2_ACCESS_KEY_ID']),
		secretAccessKey: setting('--r2-secret-access-key', ['R2_SECRET_ACCESS_KEY', 'YOAL_R2_SECRET_ACCESS_KEY']),
	};
}

const interactive = process.stdin.isTTY && !options.yes && !options.dryRun;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
async function ask(question: string, fallback = ''): Promise<string> {
	if (!rl) return fallback;
	const answer = (await rl.question(`${question}${fallback ? color.dim(` [${fallback}]`) : ''}: `)).trim();
	return answer || fallback;
}

/** A line read without echo, for secrets that must not end up in the terminal scrollback. */
async function askSecret(question: string): Promise<string> {
	if (!rl) return '';
	const stty = (args: string[]) =>
		Bun.spawnSync({ cmd: ['stty', ...args], stdin: 'inherit', stdout: 'ignore', stderr: 'ignore' });
	stty(['-echo']);
	try {
		return (await rl.question(`${question}: `)).trim();
	} finally {
		stty(['echo']);
		process.stdout.write('\n');
	}
}

/** An interactive Yes / No toggle (scripts/install/confirm.ts); `fallback` when not interactive. */
/**
 * Hand the terminal to a child process. readline (and the yes/no toggle) keep stdin in raw mode,
 * where Enter sends `\r` and Ctrl-C is just a byte, so a child that reads a line would hang with
 * no way out. Switch to normal line mode for the child, and let Ctrl-C reach the child alone
 * (the installer ignores it meanwhile), then put things back.
 */
function withTerminal<T>(fn: () => T): T {
	const stdin = process.stdin;
	const wasRaw = Boolean(stdin.isTTY && stdin.isRaw);
	rl?.pause();
	if (stdin.isTTY) stdin.setRawMode(false);
	stdin.pause();
	const ignore = () => {};
	process.on('SIGINT', ignore);
	try {
		return fn();
	} finally {
		process.off('SIGINT', ignore);
		if (wasRaw) stdin.setRawMode(true);
		rl?.resume();
	}
}

async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
	if (!rl) return fallback;
	rl.pause(); // the toggle reads raw keypresses from the same terminal
	try {
		return await confirm(question, fallback, { input: process.stdin, output: process.stdout, ask });
	} catch (error) {
		console.error(color.red(`\n${(error as Error).message}`));
		process.exit(130);
	} finally {
		rl.resume();
	}
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
	const address = serverAddress();
	log(color.dim('Domains are optional: leave them blank to start on the IP address and add them later in Settings → Domains.'));
	options.platformHost = await ask(
		`Dashboard domain ${color.dim(`(blank: http://${address ?? '<server-ip>'})`)}`,
		options.platformHost,
	);
	options.contentDomain = await ask(
		`Domain for deployed sites ${color.dim(`(blank: ${address ? temporaryContentDomain(address) : '<ip>.sslip.io'})`)}`,
		options.contentDomain,
	);
	if (isDomainName(options.platformHost) && (!options.contentDomain || !isTemporaryContentDomain(options.contentDomain)))
		options.acmeEmail = await ask(`Let's Encrypt email for HTTPS ${color.dim('(blank: HTTP only)')}`, options.acmeEmail);
	if (httpsWanted()) await promptCloudflareToken();
	options.adminEmail = await ask('Owner email (prefills the setup wizard; optional)', options.adminEmail);
	if (options.clickhouse === undefined && !clickhouseInstalled(SYSTEMD_DIR)) {
		log(
			color.dim(
				'Traffic charts and custom dashboards need the optional ClickHouse telemetry store: a ~240 MB\n' +
					'download and ~300–800 MB of RAM. Skip it to keep the install light; you can add it any time\n' +
					'from Settings → Telemetry.',
			),
		);
		options.clickhouse = await askYesNo('Install the ClickHouse telemetry store now?', false);
	}
}

/** The DNS-01 token file, only when one is actually there; the agent refuses to start on a missing path. */
function cloudflareTokenFile(): string {
	return options.cloudflareTokenFile && existsSync(options.cloudflareTokenFile) ? options.cloudflareTokenFile : '';
}

/** HTTPS needs real domains for both hosts plus an ACME email; mirrors resolveDomains(). */
function httpsWanted(): boolean {
	return (
		isDomainName(options.platformHost) &&
		!isTemporaryContentDomain(options.platformHost) &&
		isDomainName(options.contentDomain) &&
		!isTemporaryContentDomain(options.contentDomain) &&
		Boolean(options.acmeEmail)
	);
}

/**
 * Sites share the wildcard certificate `*.<content domain>`, which Let's Encrypt only issues over
 * DNS-01. Caddy's Cloudflare provider is the only solver in the Yoal build, so without this token
 * the install looks healthy while every deployed site returns Cloudflare error 525.
 */
async function promptCloudflareToken(): Promise<void> {
	if (cloudflareTokenFile()) return;
	log(
		color.dim(
			'Sites share one wildcard certificate, which Let\'s Encrypt only issues over DNS.\n' +
				'Create an API token with Zone → DNS → Edit for the sites domain\n' +
				'(Cloudflare dashboard → My Profile → API Tokens) so Caddy can answer the challenge.',
		),
	);
	const token = await askSecret('Cloudflare DNS token');
	if (!token) {
		log(
			color.yellow(
				'warning: no DNS token, so the wildcard certificate cannot be issued; deployed sites will fail HTTPS (error 525)',
			),
		);
		return;
	}
	writeCloudflareToken(token);
}

/** The agent reads this file as the `yoal` user through the caddy group. */
function writeCloudflareToken(token: string): void {
	const path = options.cloudflareTokenFile;
	if (options.dryRun) {
		log(`would write the Cloudflare DNS token to ${path}`);
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${token.trim()}\n`, { mode: 0o640 });
	run('chown', ['root:caddy', path], { allowFailure: true });
	log(`Cloudflare DNS token written to ${path}`);
}

/**
 * A token Cloudflare rejects is worse than a missing one: the install would finish and the wildcard
 * would silently never issue. Only a network failure is non-fatal, because the host may be offline
 * or restricted at install time.
 */
async function verifyCloudflareToken(): Promise<void> {
	let token = '';
	try {
		token = readFileSync(cloudflareTokenFile(), 'utf8').trim();
	} catch {
		/* reported below */
	}
	if (!token) fail(`The Cloudflare DNS token file ${cloudflareTokenFile()} is empty.`);
	let response: Response;
	try {
		response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		log(
			color.yellow(
				`warning: could not reach Cloudflare to verify the DNS token (${(error as Error).message}); continuing`,
			),
		);
		return;
	}
	const body = (await response.json().catch(() => ({}))) as {
		success?: boolean;
		errors?: Array<{ message?: string }>;
	};
	if (response.ok && body.success) {
		log('Cloudflare DNS token verified');
		return;
	}
	const detail = body.errors?.map((error) => error.message).filter(Boolean).join('; ') || `HTTP ${response.status}`;
	fail(
		`Cloudflare rejected the DNS token in ${cloudflareTokenFile()}: ${detail}.\n` +
			`  Create a token with Zone → DNS → Edit for ${options.contentDomain}, or pass --cloudflare-token-file <path>.`,
	);
}

function dnsLine(result: DnsResult): string {
	const addresses = result.addresses.join(', ');
	if (result.status === 'ok') return `${color.green('✓')} ${result.display} → ${addresses}`;
	if (result.status === 'elsewhere')
		return `${color.yellow('!')} ${result.display} → ${addresses} ${color.dim('(not this server; fine if proxied, e.g. Cloudflare)')}`;
	return `${color.red('✗')} ${result.display} ${color.dim('does not resolve yet')}`;
}

/**
 * DNS is the operator's job; the installer only checks it. Missing records are not fatal: in an
 * interactive run the operator can re-check as often as needed while records propagate, instead
 * of restarting the install.
 */
async function verifyDns(): Promise<void> {
	step('DNS');
	if (options.skipDnsCheck) {
		log('skipped (--skip-dns-check); assuming the records exist');
		return;
	}
	// An IP and the temporary sslip.io domain need no records.
	const realPlatform = !isIpv4(options.platformHost);
	const realContent = !isTemporaryContentDomain(options.contentDomain);
	if (!realPlatform && !realContent) {
		log('nothing to check: the dashboard is on the IP address and sites use sslip.io');
		return;
	}
	const serverAddresses = parseServerAddresses(capture('hostname', ['-I']) ?? '');
	const hasDig = Boolean(capture('sh', ['-c', 'command -v dig']));
	const lookup = hasDig ? digLookup((cmd) => capture(cmd[0]!, cmd.slice(1))) : resolverLookup();
	const target = serverAddresses.find((address) => !address.includes(':')) ?? serverAddresses[0] ?? "<this server's IP>";
	log(color.dim(`querying public resolvers via ${hasDig ? 'dig' : 'the built-in resolver'}`));
	for (;;) {
		const targets = dnsTargets(options.platformHost, options.contentDomain).filter((target) =>
			target.name === options.platformHost ? realPlatform : realContent,
		);
		const results = await checkDns(targets, lookup, serverAddresses);
		for (const result of results) log(dnsLine(result));
		const missing = results.filter((result) => result.status === 'missing');
		if (!missing.length) return;
		log(color.yellow(`Create A (or AAAA) records pointing at ${target}:`));
		for (const result of missing) log(`  ${result.display}`);
		if (!rl) {
			log(color.yellow('warning: continuing anyway; HTTPS certificates will not issue until these names resolve'));
			return;
		}
		const answer = (await ask('[r]e-check, [c]ontinue anyway, or [q]uit', 'r')).toLowerCase();
		if (answer.startsWith('c')) return;
		if (answer.startsWith('q')) fail('Stopped before installing anything. Re-run once DNS is set up.');
	}
}

/** This server's IPv4 for an IP-only install: --public-address, else a public, else any interface address. */
function serverAddress(): string | null {
	if (options.publicAddress) return options.publicAddress;
	const output = capture('hostname', ['-I']) ?? '';
	const ipv4 = (list: string[]) => list.find((address) => isIpv4(address)) ?? null;
	return ipv4(parseServerAddresses(output)) ?? ipv4(output.split(/\s+/).filter((address) => !address.startsWith('127.')));
}

/**
 * Fill in what was left blank (D105): no dashboard domain → the server's IP; no content domain →
 * `<ip>.sslip.io`. HTTPS only with an ACME email and real domains for both; everything else is
 * plain HTTP until Settings → Domains changes it.
 */
function resolveDomains(): void {
	options.platformHost = options.platformHost.trim().toLowerCase();
	options.contentDomain = options.contentDomain.trim().toLowerCase();
	if (options.publicAddress && !isIpv4(options.publicAddress)) fail(`--public-address must be an IPv4 address (got "${options.publicAddress}").`);
	const address = serverAddress();
	if (!options.platformHost) {
		if (!address) fail("Could not detect this server's IPv4 address. Pass --public-address <ip> or --platform-host <domain>.");
		options.platformHost = address;
		log(`no dashboard domain: serving it at http://${address}`);
	}
	if (!options.contentDomain) {
		const ip = isIpv4(options.platformHost) ? options.platformHost : address;
		if (!ip) fail("Could not detect this server's IPv4 address for the temporary sites domain. Pass --content-domain or --public-address.");
		options.contentDomain = temporaryContentDomain(ip);
		log(`no sites domain: using the temporary ${options.contentDomain} (resolves to ${ip}; HTTP only)`);
	}
	const realDomains =
		isDomainName(options.platformHost) &&
		!isTemporaryContentDomain(options.platformHost) &&
		isDomainName(options.contentDomain) &&
		!isTemporaryContentDomain(options.contentDomain);
	if (!options.acmeEmail && options.upgrade) {
		// Older installs kept the ACME email only in agent.env.
		try {
			options.acmeEmail = readEnvFile(AGENT_ENV_FILE).get('YOAL_ACME_EMAIL') ?? '';
		} catch {
			/* no agent */
		}
	}
	options.tls = realDomains && Boolean(options.acmeEmail);
	if (options.acmeEmail && !realDomains) {
		log(color.yellow('warning: ignoring the ACME email: HTTPS needs real domains for the dashboard and sites (not an IP or sslip.io)'));
		options.acmeEmail = '';
	} else if (realDomains && !options.tls) {
		log(color.yellow('warning: no ACME email, so this install serves plain HTTP. Add HTTPS later in Settings → Domains.'));
	}
}

const CADDY_DNS_MODULE = 'github.com/caddy-dns/cloudflare';
const PODMAN_PACKAGES = ['podman', 'uidmap', 'passt', 'netavark', 'aardvark-dns'];
/**
 * Storage tools (docs/STORAGE.md §5): fio profiles volumes, nfs-common and cifs-utils mount network
 * shares. Keep in step with STORAGE_TOOL_PACKAGES in apps/helper/src/storage-tools.ts, which
 * installs them on nodes that update in place.
 */
const STORAGE_TOOL_PACKAGES = ['fio', 'nfs-common', 'cifs-utils'];
/** Kernel WireGuard for the managed overlay (docs/CLUSTERING.md §4.1); the helper runs `wg`. */
const OVERLAY_PACKAGES = ['wireguard-tools'];
const CADDYFILE = '/etc/caddy/Caddyfile';

function hasCommand(command: string): boolean {
	return Boolean(capture('sh', ['-c', `command -v ${command}`]));
}

let aptUpdated = false;
function aptInstall(packages: string[]): boolean {
	const env = { DEBIAN_FRONTEND: 'noninteractive' };
	if (!aptUpdated) {
		run('apt-get', ['update', '-q'], { env });
		aptUpdated = true;
	}
	return run('apt-get', ['install', '-y', '-q', '--no-install-recommends', ...packages], { env, allowFailure: true }).code === 0;
}

/**
 * Install what Yoal runs on before setting it up: Caddy (with the DNS-01 module HTTPS needs) and,
 * for the agent, Podman for managed databases and object storage. Debian/Ubuntu only (checked
 * above). `--skip-deps` leaves packages to the operator; the checks below still report gaps.
 */
function installPrerequisites(): void {
	if (options.skipDeps) {
		log('skipping package installation (--skip-deps)');
		return;
	}
	const installed = (name: string) => capture('dpkg-query', ['-W', '-f=${Status}', name])?.includes('install ok installed') ?? false;
	const missingCaddy = !hasCommand('caddy');
	const missingPodman = !options.noAgent && PODMAN_PACKAGES.some((name) => !installed(name));
	const missingStorage = options.noAgent
		? []
		: [...STORAGE_TOOL_PACKAGES, ...OVERLAY_PACKAGES].filter((name) => !installed(name));
	if (!missingCaddy && !missingPodman && missingStorage.length === 0) return;
	if (options.dryRun) {
		if (missingCaddy) log(`would install Caddy from the official apt repository and add ${CADDY_DNS_MODULE}`);
		if (missingPodman) log(`would install ${PODMAN_PACKAGES.join(' ')}`);
		if (missingStorage.length) log(`would install ${missingStorage.join(' ')}`);
		return;
	}
	step('Prerequisites');
	if (missingCaddy) installCaddy();
	if (missingPodman) installPodman();
	if (missingStorage.length) installStorageTools(missingStorage);
}

/** Best effort: Yoal runs without them, but profiling and network shares are limited. */
function installStorageTools(packages: string[]): void {
	log(`installing ${packages.join(' ')} (volume profiling and network shares)`);
	if (aptInstall(packages)) return;
	const missing = packages.filter((name) => !aptInstall([name]));
	if (missing.length)
		log(color.yellow(`warning: could not install ${missing.join(', ')}; volume profiling or network share mounts will be limited`));
}

function installCaddy(): void {
	log('installing Caddy (official apt repository)');
	if (!aptInstall(['debian-keyring', 'debian-archive-keyring', 'apt-transport-https', 'ca-certificates', 'curl', 'gnupg']))
		fail('Could not install the packages needed to add the Caddy repository (see the apt output above).');
	const keyring = '/usr/share/keyrings/caddy-stable-archive-keyring.gpg';
	const list = '/etc/apt/sources.list.d/caddy-stable.list';
	run('sh', ['-c', `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o ${keyring}`]);
	run('sh', ['-c', `curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > ${list}`]);
	run('chmod', ['o+r', keyring, list]);
	aptUpdated = false;
	if (!aptInstall(['caddy'])) fail('Could not install Caddy (see the apt output above).');

	// The package's Caddyfile serves a welcome page with the admin API on TCP. Yoal wants the admin
	// API on a unix socket only (the agent pushes the real config through it).
	ensureBootstrapCaddyfile(':80');
	run('systemctl', ['enable', 'caddy'], { allowFailure: true });
	run('systemctl', ['restart', 'caddy'], { allowFailure: true });

	// Wildcard HTTPS for sites needs DNS-01. HTTP installs work without it, so a failed download
	// (the module comes from caddyserver.com's build service) is a warning, not a stop.
	const modules = capture('caddy', ['list-modules']) ?? '';
	if (!modules.includes('dns.providers.cloudflare')) {
		log(`adding ${CADDY_DNS_MODULE} to Caddy`);
		if (run('caddy', ['add-package', CADDY_DNS_MODULE], { allowFailure: true }).code === 0) {
			// Keep apt from replacing the custom build on upgrade.
			run('apt-mark', ['hold', 'caddy'], { allowFailure: true });
			run('systemctl', ['restart', 'caddy'], { allowFailure: true });
		} else
			log(color.yellow(`warning: could not add ${CADDY_DNS_MODULE}; HTTPS for sites needs it (retry: sudo caddy add-package ${CADDY_DNS_MODULE})`));
	}
	log(`caddy ${capture('caddy', ['version']) ?? 'installed'}`);
}

/** Admin API on a unix socket only; the agent pushes the real config through it. */
function ensureBootstrapCaddyfile(listen: string, bind?: string): boolean {
	const stock = existsSync(CADDYFILE) ? readFileSync(CADDYFILE, 'utf8') : '';
	if (stock.includes('admin unix/')) return false;
	if (stock) writeFileSync(`${CADDYFILE}.dist`, stock);
	writeFileSync(
		CADDYFILE,
		[
			'# Bootstrap config written by the Yoal installer. The Yoal agent replaces it at runtime',
			'# through the admin socket below; this only serves until the agent starts.',
			'{',
			'\tadmin unix//var/lib/caddy/admin.sock|0660',
			'}',
			'',
			`${listen} {`,
			// A site address alone does not limit the socket; Caddy binds every interface without this.
			...(bind ? [`\tbind ${bind}`] : []),
			'\trespond "Yoal is starting." 503',
			'}',
			'',
		].join('\n'),
	);
	return true;
}

function installPodman(): void {
	log(`installing ${PODMAN_PACKAGES.join(' ')}`);
	if (aptInstall(PODMAN_PACKAGES)) return;
	// Older releases lack some of these (for example passt or netavark); install what exists.
	const missing = PODMAN_PACKAGES.filter((name) => !aptInstall([name]));
	if (missing.includes('podman')) log(color.yellow('warning: could not install podman; managed databases and object storage cannot start'));
	else if (missing.length) log(color.yellow(`warning: not available on this release: ${missing.join(', ')}`));
}

/** The pinned runtimes apps run on: workerd (+ Pyodide), Node.js, and FrankenPHP when asked for. */
async function installAgentRuntimes(): Promise<void> {
	// Functions run on a pinned workerd binary (docs/FUNCTIONS.md FN1). Install it now, outside
	// the runtime, so a function host never fetches its runtime while serving. A download
	// failure is a warning: the FUNCTIONS flag is off by default and the operator can install
	// the same pin later.
	const workerdArchitecture = workerdArch(process.arch);
	if (!workerdArchitecture) fail(`Unsupported architecture for workerd: ${process.arch}`);
	try {
		const version = pinnedWorkerdVersion(SOURCE);
		await ensureWorkerd({
			version,
			arch: workerdArchitecture,
			dryRun: options.dryRun,
			log,
		});
		log(`workerd ${version} ready in /usr/lib/yoal/workerd`);
		// Python functions load Pyodide from a read-only cache next to the binary (D121); the
		// agent advertises `functions-python` only once it is there.
		if (!options.noPython) {
			try {
				const result = await warmPyodideCache({
					workerdPath: join('/usr/lib/yoal/workerd', version, 'workerd'),
					cacheDir: join('/usr/lib/yoal/workerd', version, 'pyodide'),
					eras: await pythonBundleEras(SOURCE),
					dryRun: options.dryRun,
					log,
				});
				if (result !== 'would-warm') log(`Pyodide cache ${result} for workerd ${version}`);
			} catch (error) {
				log(
					color.yellow(
						`warning: could not warm the Pyodide cache (${error instanceof Error ? error.message : String(error)}); ` +
							'Python functions stay unavailable on this node until `bun scripts/install/pyodide.ts` succeeds',
					),
				);
			}
		}
	} catch (error) {
		log(
			color.yellow(
				`warning: could not install the pinned workerd binary (${error instanceof Error ? error.message : String(error)}); ` +
					'Functions stay unavailable until it is installed',
			),
		);
	}
	// Node.js process apps run on a pinned LTS (D125). On by default; a failure is a warning,
	// since only Node apps need it and `bun scripts/install/node.ts` adds it later.
	const jsArch = nodeArch(process.arch);
	if (options.noNode) {
		if (!options.dryRun) {
			mkdirSync(dirname(NODE_OPT_OUT_MARKER), { recursive: true });
			writeFileSync(NODE_OPT_OUT_MARKER, 'Node.js process apps were declined with --no-node (D125).\n');
		}
	} else if (jsArch) {
		try {
			if (!options.dryRun) rmSync(NODE_OPT_OUT_MARKER, { force: true });
			const result = await ensureNode({ arch: jsArch, dryRun: options.dryRun, log });
			log(`Node.js ${NODE_PINNED_VERSION} ${result === 'would-install' ? 'would be installed' : 'ready'} at /usr/local/bin/node`);
		} catch (error) {
			log(
				color.yellow(
					`warning: could not install Node.js (${error instanceof Error ? error.message : String(error)}); ` +
						'Node.js apps cannot be placed on this node until `bun scripts/install/node.ts` succeeds',
				),
			);
		}
	}
	// PHP apps are process apps on a pinned FrankenPHP (D121). Opt-in; a failure is a warning,
	// since only PHP apps need it and `bun scripts/install/frankenphp.ts` adds it later.
	const phpArch = frankenphpArch(process.arch);
	if (options.withPhp && phpArch) {
		try {
			const result = await ensureFrankenphp({ arch: phpArch, dryRun: options.dryRun, log });
			log(`FrankenPHP ${FRANKENPHP_PINNED_VERSION} ${result === 'would-install' ? 'would be installed' : 'ready'} at ${FRANKENPHP_LINK}`);
		} catch (error) {
			log(
				color.yellow(
					`warning: could not install FrankenPHP (${error instanceof Error ? error.message : String(error)}); ` +
						'PHP apps cannot start on this node until it is installed',
				),
			);
		}
	}
}

async function preflight(): Promise<void> {
	step('Preflight');
	if (process.platform !== 'linux') fail('Yoal installs on Linux only.');
	if (process.getuid?.() !== 0) fail('Run the installer as root (curl … | sudo sh).');
	if (!existsSync('/run/systemd/system')) fail('systemd is required.');

	const os = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
	const id = /^ID=(.*)$/m.exec(os)?.[1]?.replace(/"/g, '') ?? '';
	const versionId = /^VERSION_ID=(.*)$/m.exec(os)?.[1]?.replace(/"/g, '') ?? '';
	if (!['debian', 'ubuntu'].includes(id)) {
		if (process.env.YOAL_FORCE_OS !== '1') fail(`Unsupported OS "${id}". Debian/Ubuntu is required (YOAL_FORCE_OS=1 to override).`);
		log(color.yellow(`warning: unsupported OS ${id}`));
	} else {
		log(`${id} ${versionId}`);
	}
	const arch = process.arch;
	if (!['x64', 'arm64'].includes(arch)) fail(`Unsupported architecture ${arch}.`);
	log(`${arch}, bun ${Bun.version}`);

	installPrerequisites();

	if (!options.noAgent) await installAgentRuntimes();
	if (!options.noAgent) {
		if (!capture('sh', ['-c', 'command -v podman']))
			log(
				color.yellow(
					'warning: podman is not installed; managed databases and object storage cannot start. ' +
						'Install it with: apt-get install podman uidmap passt netavark aardvark-dns',
				),
			);
		else if (!existsSync('/usr/lib/systemd/system-generators/podman-system-generator'))
			log(color.yellow('warning: the Podman Quadlet generator is missing; container workloads cannot start'));
	}

	for (const command of ['systemctl', 'journalctl', 'caddy']) {
		if (!capture('sh', ['-c', `command -v ${command}`])) fail(`Required command not found: ${command}`);
	}
	const caddyBin = capture('sh', ['-c', 'command -v caddy'])!;
	const modules = capture(caddyBin, ['list-modules']) ?? '';
	if (!modules.includes('dns.providers.cloudflare')) {
		// Only the wildcard HTTPS certificate needs DNS-01; HTTP installs work with any Caddy.
		if (options.tls) fail(`Caddy at ${caddyBin} has no caddy-dns/cloudflare module. Install the Yoal Caddy build first.`);
		log(color.yellow(`warning: Caddy at ${caddyBin} has no caddy-dns/cloudflare module; install the Yoal Caddy build before turning on HTTPS`));
	}
	log(`caddy ${capture(caddyBin, ['version']) ?? 'unknown'}`);

	if (options.objectStore === 'r2') {
		const missing = Object.entries(options.r2 ?? {}).filter(([, v]) => !v).map(([k]) => k);
		if (missing.length) fail(`R2 selected but missing: ${missing.join(', ')}`);
	}
	if (!isDomainName(options.platformHost) && !isIpv4(options.platformHost) && !validDomain(options.platformHost))
		fail(`Invalid platform host "${options.platformHost}" (a domain or an IPv4 address).`);
	if (!isDomainName(options.contentDomain)) fail(`Invalid content domain "${options.contentDomain}".`);
	if (options.platformHost === options.contentDomain) fail('The dashboard and sites need different domains.');
	log(`${options.tls ? 'https' : 'http'}://${options.platformHost}, sites at *.${options.contentDomain}`);

	// Sites share the wildcard certificate, and only DNS-01 can issue it. Fail a fresh install here
	// rather than finishing one whose every deployed site returns Cloudflare error 525. An upgrade
	// only warns: a host with working certificates must not be blocked from updating.
	if (options.tls) {
		if (!cloudflareTokenFile()) {
			const message =
				`HTTPS for sites needs a Cloudflare DNS-01 token, because they share the wildcard certificate *.${options.contentDomain}.\n` +
				`  Put a Zone → DNS → Edit token in ${options.cloudflareTokenFile} (root:caddy, 0640),\n` +
				'  or pass --cloudflare-token-file <path>. Without it every site returns Cloudflare error 525.';
			if (!options.upgrade) fail(message);
			log(color.yellow(`warning: ${message.replace(/\n\s*/g, ' ')}`));
		} else {
			await verifyCloudflareToken();
		}
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
	if (!capture('getent', ['group', 'yoal'])) {
		if (options.dryRun) log('would create yoal group');
		else run('groupadd', ['--system', 'yoal']);
	}
	if (!capture('getent', ['group', 'caddy'])) {
		if (options.dryRun) log('would create caddy group');
		else run('groupadd', ['--system', 'caddy']);
	}
	// The release-managed Caddy unit uses Group=yoal-caddy, and the control plane lists it as a
	// supplementary group. Older installs (and the pre-rename skiff-caddy group) need it created.
	if (!capture('getent', ['group', 'yoal-caddy'])) {
		if (options.dryRun) log('would create yoal-caddy group');
		else run('groupadd', ['--system', 'yoal-caddy']);
	}
	if (!capture('id', ['-u', 'yoal'])) {
		if (options.dryRun) log('would create yoal user');
		else run('useradd', ['--system', '--gid', 'yoal', '--home-dir', VAR_DIR, '--shell', '/usr/sbin/nologin', 'yoal']);
	}
	const groups = (capture('id', ['-nG', 'yoal']) ?? '').split(/\s+/);
	if (!groups.includes('caddy')) {
		if (options.dryRun) log('would add yoal to caddy group');
		else run('usermod', ['-aG', 'caddy', 'yoal']);
	}

	ensureDir(OPT_DIR, '0755', 'root:root');
	ensureDir(join(OPT_DIR, 'releases'), '0755', 'root:root');
	ensureDir(ETC_DIR, '0750', 'root:yoal');
	ensureDir(VAR_DIR, '0751', 'yoal:yoal');
	for (const sub of ['data', 'data/objects', 'backups']) ensureDir(join(VAR_DIR, sub), '0750', 'yoal:yoal');
	// Traverse-only for others: process apps run as a DynamicUser inside agent/releases/<sha>.
	ensureDir(join(VAR_DIR, 'agent'), '0751', 'yoal:yoal');
	// Dashboard-requested updates: the control plane drops a request in a directory it owns; the
	// root updater reports progress from a directory the control plane can read but not write.
	ensureDir(dirname(SELF_UPDATE_DEFAULTS.requestFile), '0750', 'yoal:yoal');
	ensureDir(dirname(SELF_UPDATE_DEFAULTS.statusFile), '0750', 'root:yoal');
	ensureDir(RUN_DIR, '2770', 'root:caddy');
	// Quadlet's generator reads .container/.network files from here for managed services.
	ensureDir('/etc/containers/systemd', '0755', 'root:root');
	// Caddy writes its JSON access log here (0640); the agent reads it via the caddy group (DESIGN §8).
	ensureDir(dirname(CADDY_ACCESS_LOG), '0750', 'caddy:caddy');
	if (!options.dryRun) {
		writeFileSync('/etc/tmpfiles.d/yoal.conf', '# Yoal runtime directory (setgid so Caddy and the agent share sockets)\nd /run/yoal 2770 root caddy -\n');
		run('systemd-tmpfiles', ['--create', '/etc/tmpfiles.d/yoal.conf'], { allowFailure: true });
	}
}

/** Set by writeSecrets: the key (for node enrolment) and whether this run sealed a plaintext one. */
let masterKey: EnsureMasterKeyResult | null = null;

/**
 * A host that once chose a channel keeps it in the updater's channel file, which outranks
 * yoal.env. install.sh starts from that file, so a difference here means --canary or
 * YOAL_CHANNEL asked for another one: rewrite it the way the updater does (root:yoal 0640).
 */
function syncRememberedChannel(): void {
	const file = SELF_UPDATE_DEFAULTS.channelFile;
	let current: string;
	try {
		current = readFileSync(file, 'utf8').trim();
	} catch {
		return;
	}
	if (current === options.channel) return;
	writeFileSync(`${file}.tmp-${process.pid}`, `${options.channel}\n`, { mode: 0o640 });
	run('chown', ['root:yoal', `${file}.tmp-${process.pid}`], { allowFailure: true });
	renameSync(`${file}.tmp-${process.pid}`, file);
	log(`release channel changed: ${current || 'unset'} -> ${options.channel}`);
}

function writeSecrets(): Map<string, string> {
	step('Secrets and environment');
	const existing = readEnvFile(ENV_FILE);
	// Sealed with systemd-creds (TPM2 + host key, or host key) when the host has it; an existing
	// plaintext key is sealed in place and kept as master.key.pre-seal until the control plane starts.
	masterKey = ensureMasterKey({ plainPath: MASTER_KEY_FILE, dryRun: options.dryRun, log });

	const env = new Map(existing);
	env.set('NODE_ENV', 'production');
	env.set('YOAL_PLATFORM_ORIGIN', `${options.tls ? 'https' : 'http'}://${options.platformHost}`);
	env.set('YOAL_CONTENT_DOMAIN', options.contentDomain);
	env.set('YOAL_DATA_DIR', join(VAR_DIR, 'data'));
	env.set('YOAL_OBJECT_STORE', options.objectStore);
	env.set('YOAL_AGENT_VERSION', options.version);
	// The updater's default channel until the host chooses one (D128).
	env.set('YOAL_UPDATE_CHANNEL', options.channel);
	env.set('YOAL_EDGE_NODE_ID', existing.get('YOAL_EDGE_NODE_ID') ?? '');
	env.set('BETTER_AUTH_SECRET', existing.get('BETTER_AUTH_SECRET') ?? base64(48));
	env.set('YOAL_SITE_COOKIE_SECRET', existing.get('YOAL_SITE_COOKIE_SECRET') ?? base64(32));
	env.set('YOAL_OBJECT_STORE_SECRET', existing.get('YOAL_OBJECT_STORE_SECRET') ?? base64(32));
	// Web Push alerts (D108): kept across re-runs, since a new pair orphans every subscribed device.
	if (ensureVapidKeys(env)) log('generated the Web Push (VAPID) key pair');
	// Nothing reads it (backups are Litestream + per-database schedules); drop it from old installs.
	env.delete('YOAL_DAILY_BACKUPS');
	// Remembered so a later re-run/upgrade keeps them without repeating the flags.
	if (options.tls) env.set('YOAL_ACME_EMAIL', options.acmeEmail);
	else env.delete('YOAL_ACME_EMAIL');
	if (cloudflareTokenFile()) env.set('YOAL_CLOUDFLARE_TOKEN_FILE', cloudflareTokenFile());
	else env.delete('YOAL_CLOUDFLARE_TOKEN_FILE');
	if (options.smtp) {
		env.set('YOAL_SMTP_HOST', options.smtp.host);
		env.set('YOAL_SMTP_PORT', String(options.smtp.port));
		env.set('YOAL_SMTP_USER', options.smtp.user);
		env.set('YOAL_SMTP_PASSWORD', options.smtp.password);
		env.set('YOAL_SMTP_FROM', options.smtp.from);
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
		// Litestream (scripts/litestream.yml) cannot derive the endpoint from the account id, so
		// write it explicitly. The control plane reads the same optional R2_ENDPOINT.
		env.set('R2_ENDPOINT', existing.get('R2_ENDPOINT') || `https://${options.r2.accountId}.r2.cloudflarestorage.com`);
	}
	if (!options.dryRun) {
		writeEnvFile(ENV_FILE, env);
		syncRememberedChannel();
		run('chown', ['root:yoal', ENV_FILE], { allowFailure: true });
		run('chmod', ['0640', ENV_FILE], { allowFailure: true });
	}
	if (!options.dryRun) {
		if (!existsSync(SETUP_TOKEN_FILE))
			writeFileSync(SETUP_TOKEN_FILE, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o640 });
		// The control plane (user yoal) reads it to verify the setup link (D102). Installs before
		// 0.6.x wrote it root 0600, so fix the mode on every run.
		run('chown', ['root:yoal', SETUP_TOKEN_FILE], { allowFailure: true });
		run('chmod', ['0640', SETUP_TOKEN_FILE], { allowFailure: true });
	}
	return env;
}

function buildRelease(env: Map<string, string>, scope: 'full' | 'worker' = 'full'): string {
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
	// A worker runs no control plane and no CLI: building them would only cost time and memory.
	if (scope === 'full') run(BUN_BIN, ['run', '--cwd', 'apps/control-plane', 'build'], { cwd: join(release, 'repo') });
	run(BUN_BIN, ['run', '--cwd', 'apps/agent', 'build'], { cwd: join(release, 'repo') });
	if (scope === 'full') run(BUN_BIN, ['run', '--cwd', 'apps/cli', 'build'], { cwd: join(release, 'repo') });
	run(BUN_BIN, ['run', '--cwd', 'apps/helper', 'build'], { cwd: join(release, 'repo') });
	cpSync(join(release, 'repo', 'apps', 'agent', 'dist', 'yoal-agent'), join(release, 'agent', 'yoal-agent'));
	chmodSync(join(release, 'agent', 'yoal-agent'), 0o755);
	linkAgentCommands(release);
	ensureDir(join(release, 'helper'), '0755', 'root:root');
	cpSync(join(release, 'repo', 'apps', 'helper', 'dist', 'yoal-helper'), join(release, 'helper', 'yoal-helper'));
	chmodSync(join(release, 'helper', 'yoal-helper'), 0o755);
	if (scope === 'full') {
		ensureDir(join(release, 'cli'), '0755', 'root:root');
		cpSync(join(release, 'repo', 'apps', 'cli', 'dist', 'yoal.js'), join(release, 'cli', 'yoal.js'));
		chmodSync(join(release, 'cli', 'yoal.js'), 0o644);
	}
	writeFileSync(
		join(release, 'meta.json'),
		`${JSON.stringify(
			{
				version: options.version,
				builtAt: new Date().toISOString(),
				source: process.env.YOAL_SOURCE_TAG ?? process.env.YOAL_SOURCE_REF ?? 'local',
				// Read by yoal-update-self to know where to pull updates from. `ref` is the branch
				// source builds track, never a release tag; a stable install records its tag apart.
				...(process.env.YOAL_REPO ? { repo: process.env.YOAL_REPO } : {}),
				...(process.env.YOAL_SOURCE_REF ? { ref: process.env.YOAL_SOURCE_REF } : {}),
				...(process.env.YOAL_SOURCE_TAG ? { tag: process.env.YOAL_SOURCE_TAG } : {}),
			},
			null,
			2,
		)}\n`,
	);
	return release;
}

function writeUnits(release: string): void {
	step('systemd units');
	ensureCaddyAccess();
	// Primary + standby (zero-downtime updates) + boot guard; shared with the self-updater.
	const controlUnits = controlPlaneUnits({
		...DEFAULT_CONTROL_PLANE_PATHS,
		optDir: OPT_DIR,
		runDir: RUN_DIR,
		varDir: VAR_DIR,
		envFile: ENV_FILE,
		masterKeyFile: MASTER_KEY_FILE,
	});
	const agent = agentUnit({ optDir: OPT_DIR, etcDir: ETC_DIR, varDir: VAR_DIR, runDir: RUN_DIR });
	if (options.dryRun) {
		log(`would write ${Object.keys(controlUnits).join(', ')}, yoal-agent.service, ${STUDIO_UNIT} and ${IDENTITY_UNIT}`);
		if (masterKey?.store.kind === 'sealed' || masterKey?.action === 'seal-existing')
			log(`would point both control-plane units at the sealed master key (${MASTER_KEY_DROP_IN} drop-ins)`);
		return;
	}
	for (const [name, body] of Object.entries(controlUnits)) writeFileSync(join(SYSTEMD_DIR, name), body);
	// LoadCredentialEncrypted= when the key is sealed (removed again if it is not).
	ensureMasterKeyDropIns({ systemdDir: SYSTEMD_DIR, masterKeyFile: MASTER_KEY_FILE });
	writeFileSync(join(SYSTEMD_DIR, 'yoal-agent.service'), agent);
	// The on-demand database studio (plan 22): installed beside the agent, never enabled. The
	// agent starts it through the helper; it exits by itself when idle.
	writeFileSync(join(SYSTEMD_DIR, STUDIO_UNIT), studioUnit({ optDir: OPT_DIR, runDir: RUN_DIR, socketGroup: 'caddy' }));
	// Static, like the studio: the mail node's agent starts it (docs/EMAIL.md).
	writeFileSync(join(SYSTEMD_DIR, MAIL_UNIT), mailUnit({ optDir: OPT_DIR, runDir: RUN_DIR, socketGroup: 'caddy' }));
	// Static, like mail: the identity node's agent starts it (docs/IAM.md §11.2).
	writeFileSync(join(SYSTEMD_DIR, IDENTITY_UNIT), identityUnit({ optDir: OPT_DIR, runDir: RUN_DIR, socketGroup: 'caddy' }));
	writeFileSync(join(SYSTEMD_DIR, IDENTITY_LITESTREAM_UNIT), identityLitestreamUnit());
	// The privileged runtime helper ships in the active release so a `current` swap upgrades it.
	ensureHelper({
		systemdDir: SYSTEMD_DIR,
		optDir: OPT_DIR,
		etcDir: ETC_DIR,
		varDir: VAR_DIR,
		bunBin: BUN_BIN,
		release,
		run: (cmd) => void run(cmd[0]!, cmd.slice(1), { allowFailure: true }),
		log,
		start: false,
	});
	// `--skip-deps` leaves packages to the operator: the helper must not apt-install storage tools later either.
	if (options.skipDeps) {
		const helperEnvFile = join(ETC_DIR, 'helper.env');
		const body = existsSync(helperEnvFile) ? readFileSync(helperEnvFile, 'utf8') : '';
		if (!/^YOAL_HELPER_STORAGE_TOOLS=/m.test(body))
			writeFileSync(helperEnvFile, `${body}${body && !body.endsWith('\n') ? '\n' : ''}YOAL_HELPER_STORAGE_TOOLS=0\n`);
	}
	for (const [name, body] of Object.entries(triggerUnits())) writeFileSync(join(SYSTEMD_DIR, name), body);
	run('systemctl', ['daemon-reload']);
	// Settings → Backups / Notifications in the dashboard (docs/OPS.md §4.3).
	ensurePlatformConfigUnits({
		systemdDir: SYSTEMD_DIR,
		optDir: OPT_DIR,
		bunBin: BUN_BIN,
		run: (cmd) => void run(cmd[0]!, cmd.slice(1), { allowFailure: true }),
		log,
	});
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
		join(dropInDir, 'yoal-admin-socket.conf'),
		`[Service]\n# Caddy reads deployed artifacts from the agent cache and the agent needs the admin socket.\nSupplementaryGroups=yoal\nExecStartPost=/usr/bin/chmod 0660 ${socket}\n`,
	);
	run('systemctl', ['daemon-reload'], { allowFailure: true });
	if (existsSync(socket)) run('chmod', ['0660', socket], { allowFailure: true });
	// `systemctl show -p SupplementaryGroups` reports the unit file, which already lists yoal once
	// the drop-in is written, so it cannot tell whether the running process has it. A Caddy started
	// before this drop-in does not, and then it cannot read release artifacts: every site is a 403
	// while the node otherwise looks healthy. Inspect the process, and restart only when it is stale.
	const pid = (capture('systemctl', ['show', 'caddy', '-p', 'MainPID', '--value']) ?? '').trim();
	const gid = parseGetentGroupId(capture('getent', ['group', 'yoal']) ?? '');
	let status = '';
	try {
		if (pid && pid !== '0') status = readFileSync(`/proc/${pid}/status`, 'utf8');
	} catch {
		/* no running process yet: startServices/reload picks the unit up */
	}
	const running = pid !== '' && pid !== '0';
	if (running && gid !== null && !processHasGroup(status, gid)) {
		log('restarting caddy so it picks up the yoal group');
		run('systemctl', ['restart', 'caddy'], { allowFailure: true });
	}
}

function switchCurrent(release: string): void {
	step('Activate release');
	const link = join(OPT_DIR, 'current');
	const tmp = `${link}.new`;
	if (options.dryRun) {
		log(`would point ${link} -> ${release}`);
		return;
	}
	// Keep the outgoing release as `previous` so `yoal-update-self rollback` can return to it.
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
 * `yoal-update-self` runs the updater from the active release (falling back to the previous one,
 * e.g. after rolling back to a release that predates the updater), never from the release it is
 * about to install.
 */
function installUpdateCommand(): void {
	const path = '/usr/local/sbin/yoal-update-self';
	if (options.dryRun) {
		log(`would install ${path}`);
		return;
	}
	const script = updateCommandScript({ optDir: OPT_DIR, bunBin: BUN_BIN, updaterDir: '/usr/local/lib/yoal-updater' });
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, script, { mode: 0o755 });
	renameSync(`${path}.tmp`, path);
	log(`installed ${path}`);
}

/**
 * `yoal` (D33) runs the CLI bundled into the active release with the shared Bun, so the
 * CLI is upgraded and rolled back together with the platform. No Node.js needed on the host.
 */
function installCliCommands(): void {
	if (options.dryRun) {
		log(`would install ${CLI_COMMANDS.join(', ')}`);
		return;
	}
	ensureHostCommands({ optDir: OPT_DIR, bunBin: BUN_BIN }, { log });
}

const BACKUP_UNITS = [
	'yoal-litestream.service',
	'yoal-litestream-identity.service',
	'yoal-restore-drill.service',
	'yoal-restore-drill.timer',
	'yoal-alert@.service',
];
const LITESTREAM_CONFIG = join(ETC_DIR, 'litestream.yml');
const LITESTREAM_IDENTITY_CONFIG = join(ETC_DIR, 'litestream-identity.yml');

/**
 * Backups (DESIGN §10): Litestream → R2 plus the monthly restore drill, both alerting through
 * yoal-alert@.service on failure. Only with --object-store r2. The units are installed even when
 * the litestream binary is missing, so installing it later only needs `systemctl enable --now`.
 */
function installBackups(env: Map<string, string>): void {
	if (env.get('YOAL_OBJECT_STORE') !== 'r2') {
		log(color.yellow('backups: the object store is local, so Litestream → R2 and the restore drill are not installed'));
		return;
	}
	step('Backups (Litestream → R2, monthly restore drill)');
	if (options.dryRun) {
		log(`would install ${LITESTREAM_CONFIG} and ${BACKUP_UNITS.join(', ')}`);
		return;
	}
	if (!capture('sh', ['-c', 'command -v sqlite3']) && capture('sh', ['-c', 'command -v apt-get'])) {
		run('apt-get', ['install', '-y', '--no-install-recommends', 'sqlite3'], {
			allowFailure: true,
			env: { DEBIAN_FRONTEND: 'noninteractive' },
		});
	}
	const litestream = capture('sh', ['-c', 'command -v litestream']);
	copyFileSync(join(SOURCE, 'scripts', 'litestream.yml'), `${LITESTREAM_CONFIG}.tmp`);
	renameSync(`${LITESTREAM_CONFIG}.tmp`, LITESTREAM_CONFIG);
	run('chown', ['root:yoal', LITESTREAM_CONFIG], { allowFailure: true });
	run('chmod', ['0640', LITESTREAM_CONFIG], { allowFailure: true });
	copyFileSync(join(SOURCE, 'scripts', 'litestream-identity.yml'), `${LITESTREAM_IDENTITY_CONFIG}.tmp`);
	renameSync(`${LITESTREAM_IDENTITY_CONFIG}.tmp`, LITESTREAM_IDENTITY_CONFIG);
	run('chown', ['root:yoal', LITESTREAM_IDENTITY_CONFIG], { allowFailure: true });
	run('chmod', ['0640', LITESTREAM_IDENTITY_CONFIG], { allowFailure: true });
	for (const name of BACKUP_UNITS) {
		let body = readFileSync(join(SOURCE, 'scripts', 'systemd', name), 'utf8');
		if (litestream) body = body.replaceAll('/usr/local/bin/litestream', litestream);
		writeFileSync(join(SYSTEMD_DIR, name), body);
	}
	run('systemctl', ['daemon-reload']);
	ensureDir(join(VAR_DIR, 'drill'), '0755', 'root:root');
	if (!capture('sh', ['-c', 'command -v sqlite3']))
		log(color.yellow('warning: sqlite3 is not installed; yoal-restore and the restore drill need it'));
	if (!litestream) {
		log(
			color.yellow(
				'warning: litestream is not installed, so SQLite is NOT being backed up. Install it ' +
					'(https://litestream.io/install/) and run: systemctl enable --now yoal-litestream.service yoal-restore-drill.timer',
			),
		);
		return;
	}
	run('systemctl', ['enable', 'yoal-litestream.service', 'yoal-restore-drill.timer']);
	run('systemctl', ['restart', 'yoal-litestream.service'], { allowFailure: true });
	run('systemctl', ['start', 'yoal-restore-drill.timer'], { allowFailure: true });
	log(`Litestream replicating ${env.get('YOAL_DATA_DIR')}/yoal.db to ${env.get('R2_BUCKET')}/yoal/sqlite`);
}

/**
 * The optional telemetry store (D101, docs/OPS.md §3.6): a loopback-only ClickHouse, installed only
 * when asked for (prompt, --clickhouse) or already present (kept current on --upgrade). Started
 * before the control plane so its YOAL_CLICKHOUSE_* settings are in yoal.env when it boots. A
 * failed download or start is a warning, never an install failure.
 */
async function installClickHouse(): Promise<void> {
	const installed = clickhouseInstalled(SYSTEMD_DIR);
	const wanted = options.clickhouse ?? installed;
	if (!wanted) {
		log(
			color.dim(
				installed
					? 'telemetry store: left as is (--no-clickhouse); remove it from Settings → Telemetry'
					: 'telemetry store: skipped (optional). Install it later from Settings → Telemetry, or re-run with --upgrade --clickhouse',
			),
		);
		return;
	}
	step('Telemetry store (ClickHouse)');
	const result = await ensureClickHouse({
		envFile: ENV_FILE,
		systemdDir: SYSTEMD_DIR,
		installRoot: join(OPT_DIR, 'clickhouse'),
		dataDir: join(VAR_DIR, 'clickhouse'),
		configDir: join(ETC_DIR, 'clickhouse'),
		dryRun: options.dryRun,
		run: (cmd) => void run(cmd[0]!, cmd.slice(1)),
		capture: (cmd) => capture(cmd[0]!, cmd.slice(1)),
		log: (message) => log(message.startsWith('warning:') ? color.yellow(message) : message),
	});
	if (result.ok && !options.dryRun) log(`${CLICKHOUSE_UNIT} is serving on 127.0.0.1:18123`);
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
		log(`would enable and restart yoal-control-plane, yoal-agent, ${HELPER_UNIT}, ${BUILDER_UNIT}, ${STORAGE_PATH_UNIT}`);
		return;
	}
	run('systemctl', ['enable', HELPER_UNIT]);
	run('systemctl', ['restart', HELPER_UNIT]);
	run('systemctl', ['enable', 'yoal-control-plane.service', GUARD_UNIT]);
	run('systemctl', ['enable', '--now', TRIGGER_PATH_UNIT], { allowFailure: true });
	run('systemctl', ['restart', 'yoal-control-plane.service']);
	waitFor('control plane socket', () => existsSync(join(RUN_DIR, 'control.sock')), 90_000);
	waitFor(
		'control plane /readyz',
		() =>
			Bun.spawnSync({
				cmd: [
					'curl',
					'-fsS',
					'--max-time',
					'10',
					'--unix-socket',
					join(RUN_DIR, 'control.sock'),
					'-H',
					'Host: localhost',
					'-H',
					'X-Forwarded-Proto: https',
					'-H',
					'X-Forwarded-Host: localhost',
					'http://localhost/readyz'
				],
				stdout: 'pipe',
				stderr: 'pipe'
			}).exitCode === 0,
		60_000
	);
	patchCaddyfilePlatform();
	if (!options.noAgent && existsSync(AGENT_ENV_FILE)) {
		run('systemctl', ['enable', 'yoal-agent.service']);
		run('systemctl', ['restart', 'yoal-agent.service']);
		// A running studio moves to the new binary; a stopped one stays stopped.
		run('systemctl', ['try-restart', STUDIO_UNIT], { allowFailure: true });
		run('systemctl', ['try-restart', MAIL_UNIT], { allowFailure: true });
		waitFor('agent socket', () => existsSync(join(RUN_DIR, 'agent.sock')), 90_000);
	}
	if (!options.noAgent) {
		// Every node can build once an admin turns the Builder role on (D47); until then it idles.
		// On a first install agent.env does not exist yet, so bootstrapNode starts it after enrolment.
		ensureBuilder({
			systemdDir: SYSTEMD_DIR,
			optDir: OPT_DIR,
			agentEnvFile: AGENT_ENV_FILE,
			run: (cmd) => void run(cmd[0]!, cmd.slice(1), { allowFailure: true }),
			capture: (cmd) => capture(cmd[0]!, cmd.slice(1)),
			log,
		});
		// Storage locations can be changed from the dashboard after install (D48).
		ensureStorageUnits({
			systemdDir: SYSTEMD_DIR,
			optDir: OPT_DIR,
			agentEnvFile: AGENT_ENV_FILE,
			run: (cmd) => void run(cmd[0]!, cmd.slice(1), { allowFailure: true }),
			log,
		});
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
			'reverse_proxy unix//run/yoal/control.sock',
		);
	} else {
		log(color.yellow(`warning: ${path} has no ${options.platformHost} block; the agent will add it`));
	}

	if (updated === original) return;
	writeFileSync('/etc/caddy/Caddyfile.pre-yoal', original);
	writeFileSync(path, updated);
	run('systemctl', ['reload', 'caddy'], { allowFailure: true });
	log('Caddy platform upstream and admin socket permissions updated');
}

function bootstrapNode(env: Map<string, string>, release: string): void {
	if (options.noAgent) return;
	step('Enroll edge node');
	if (options.dryRun) {
		log('would create an edge node and write /etc/yoal/agent.env');
		return;
	}
	const platformOrigin = env.get('YOAL_PLATFORM_ORIGIN')!;
	const platformHost = new URL(platformOrigin).host;
	const proto = platformOrigin.startsWith('https:') ? 'https' : 'http';
	waitFor(
		'control plane HTTP',
		() => (capture('curl', ['-fsS', '--unix-socket', join(RUN_DIR, 'control.sock'), '-H', `Host: ${platformHost}`, '-H', `X-Forwarded-Proto: ${proto}`, '-H', `X-Forwarded-Host: ${platformHost}`, 'http://localhost/api/setup/status']) ?? '').includes('needsSetup'),
		60_000,
	);
	const script = join(release, 'repo', 'scripts', 'install', 'bootstrap-node.ts');
	const result = run(BUN_BIN, ['run', script], {
		cwd: join(release, 'repo'),
		env: {
			YOAL_DATA_DIR: env.get('YOAL_DATA_DIR')!,
			YOAL_PLATFORM_ORIGIN: platformOrigin,
			YOAL_CONTENT_DOMAIN: env.get('YOAL_CONTENT_DOMAIN')!,
			YOAL_SITE_COOKIE_SECRET: env.get('YOAL_SITE_COOKIE_SECRET')!,
			YOAL_OBJECT_STORE_SECRET: env.get('YOAL_OBJECT_STORE_SECRET')!,
			// The key itself: a sealed key has no plaintext file to read.
			YOAL_MASTER_KEY: masterKey?.key ?? '',
			YOAL_MASTER_KEY_FILE: MASTER_KEY_FILE,
			YOAL_AGENT_ENV_FILE: AGENT_ENV_FILE,
			YOAL_PLATFORM_HOST: platformHost,
			YOAL_PLATFORM_UPSTREAM: `unix/${join(RUN_DIR, 'control.sock')}`,
			// TLS follows the ACME email in bootstrap-node.ts; HTTP installs pass none.
			YOAL_ACME_EMAIL: options.tls ? options.acmeEmail : '',
			YOAL_CLOUDFLARE_API_TOKEN_FILE: options.tls ? cloudflareTokenFile() : '',
			// The edge agent reaches the control plane on its socket, not through Caddy (D105).
			YOAL_CONTROL_SOCKET: CONTROL_SOCKET,
			YOAL_CADDY_ADMIN_SOCKET: detectCaddyAdminSocket(),
		},
	});
	if (result.code !== 0) fail('Node enrollment failed.');
	// The agent unit is gated on agent.env; restart to pick it up.
	run('systemctl', ['restart', 'yoal-agent.service']);
	run('systemctl', ['restart', BUILDER_UNIT], { allowFailure: true });
	run('systemctl', ['restart', STORAGE_PATH_UNIT], { allowFailure: true });
}

function publicHealth(env: Map<string, string>): void {
	if (options.dryRun) return;
	const origin = env.get('YOAL_PLATFORM_ORIGIN')!;
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

/**
 * The last thing that can fail quietly: DNS is right, the agent is healthy, deploys succeed, and
 * every site still returns Cloudflare error 525 because Caddy has no certificate for its hostname.
 * Probe the origin with an unused label under the content domain, which only the wildcard covers.
 * Never fatal: the install itself succeeded, and rolling it back over a pending certificate would
 * be worse than telling the operator exactly what is wrong.
 */
async function verifySiteTls(): Promise<boolean> {
	if (options.dryRun || !options.tls || options.noAgent) return true;
	step('Site TLS');
	let listen = process.env.YOAL_CADDY_LISTEN;
	if (!listen) {
		try {
			listen = readEnvFile(AGENT_ENV_FILE).get('YOAL_CADDY_LISTEN');
		} catch {
			/* the default below is the packaged listen address */
		}
	}
	const port = tlsPortFromListen(listen);
	const servername = wildcardProbeHost(options.contentDomain);
	const deadline = Date.now() + 180_000;
	let announced = false;
	while (Date.now() < deadline) {
		const probe = await probeServedCertificate({ host: '127.0.0.1', port, servername });
		if (probe.covers) {
			log(`*.${options.contentDomain} certificate served (expires ${probe.notAfter ?? 'unknown'})`);
			return true;
		}
		if (!announced) {
			log(color.dim(`waiting for Caddy to serve *.${options.contentDomain} (DNS-01 through Cloudflare)`));
			announced = true;
		}
		await Bun.sleep(2_000);
	}
	log(color.red(`✗ Caddy is not serving a certificate for *.${options.contentDomain}`));
	log('  Every deployed site returns Cloudflare error 525 until it does. Usual causes:');
	log(`  • no DNS-01 token at ${options.cloudflareTokenFile} (Zone → DNS → Edit for the zone)`);
	log('  • the token was revoked, or does not allow DNS edits on that zone');
	log("  • Let's Encrypt rate limits: Caddy retries automatically, usually within minutes");
	log(color.dim('  Check the ACME order: journalctl -u caddy | grep tls.obtain'));
	log(color.dim('  Re-run the installer with --upgrade after fixing the token to re-check.'));
	return false;
}

/**
 * First-run setup (D102): while no owner exists, print the one-time setup link. The wizard at
 * `/setup` creates the owner, so this never depends on email or on scraping the journal.
 */
function printSetupLink(env: Map<string, string>): void {
	if (options.dryRun) return;
	const origin = env.get('YOAL_PLATFORM_ORIGIN')!;
	const status = capture('curl', [
		'-fsS',
		'--max-time',
		'10',
		'--unix-socket',
		join(RUN_DIR, 'control.sock'),
		'-H',
		`Host: ${new URL(origin).host}`,
		'http://localhost/api/setup/status',
	]);
	let needsSetup: boolean | undefined;
	try {
		needsSetup = (JSON.parse(status ?? '') as { needsSetup?: unknown }).needsSetup === true;
	} catch {
		needsSetup = undefined;
	}
	if (needsSetup === false) return; // an owner already exists: nothing to set up
	step('Finish setup');
	let token = '';
	try {
		token = readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();
	} catch {
		// Reported below.
	}
	if (!token) {
		log(color.yellow(`no setup token in ${SETUP_TOKEN_FILE}; find the link with: journalctl -u yoal-control-plane | grep setup`));
		return;
	}
	const url = new URL('/setup', origin);
	url.searchParams.set('token', token);
	if (options.adminEmail) url.searchParams.set('email', options.adminEmail);
	console.log(`\nOpen this link to create the owner account (works once, until an owner exists):`);
	console.log(color.bold(url.toString()));
	console.log(color.dim(`Lost it? sudo cat ${SETUP_TOKEN_FILE}, or journalctl -u yoal-control-plane | grep setup`));
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
	for (const service of ['yoal-agent', 'yoal-control-plane']) {
		Bun.spawnSync({ cmd: ['systemctl', 'stop', `${service}.service`], stdout: 'ignore', stderr: 'ignore' });
	}
	if (snapshot && existsSync(snapshot)) {
		const target = join(VAR_DIR, 'data', 'yoal.db');
		rmSync(`${target}-wal`, { force: true });
		rmSync(`${target}-shm`, { force: true });
		copyFileSync(snapshot, target);
		run('chown', ['yoal:yoal', target], { allowFailure: true });
		console.error(color.yellow(`restored database snapshot ${snapshot}`));
	}
	if (previous) {
		relink(join(OPT_DIR, 'current'), previous);
		// switchCurrent() moved `previous` to the outgoing release; put back the real fallback.
		relink(join(OPT_DIR, 'previous'), previousLink && previousLink !== previous ? previousLink : null);
		console.error(color.yellow(`restored ${previous}`));
	}
	// A master key this run sealed goes back to the plaintext file the old setup used.
	if (revertMasterKeyMigration(MASTER_KEY_FILE)) {
		ensureMasterKeyDropIns({ systemdDir: SYSTEMD_DIR, masterKeyFile: MASTER_KEY_FILE });
		Bun.spawnSync({ cmd: ['systemctl', 'daemon-reload'], stdout: 'ignore', stderr: 'ignore' });
		console.error(color.yellow(`restored the plaintext master key ${MASTER_KEY_FILE}`));
	}
	Bun.spawnSync({ cmd: ['systemctl', 'start', 'yoal-control-plane.service'], stdout: 'ignore', stderr: 'ignore' });
	if (!options.noAgent && existsSync(AGENT_ENV_FILE)) {
		// The restored release's agent may predate `yoal-agent studio`; it restarts the studio on demand.
		Bun.spawnSync({ cmd: ['systemctl', 'stop', STUDIO_UNIT], stdout: 'ignore', stderr: 'ignore' });
		Bun.spawnSync({ cmd: ['systemctl', 'start', 'yoal-agent.service'], stdout: 'ignore', stderr: 'ignore' });
	}
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
	resolveDomains();
	await preflight();
	if (!options.upgrade) await verifyDns();
	ensureUsersAndDirs();
	const env = writeSecrets();
	const previousRelease = existsSync(join(OPT_DIR, 'current'))
		? capture('readlink', ['-f', join(OPT_DIR, 'current')])
		: null;
	const previousLink = existsSync(join(OPT_DIR, 'previous'))
		? capture('readlink', ['-f', join(OPT_DIR, 'previous')])
		: null;
	let snapshot: string | null = null;
	let snapshotBundle: string | null = null;
	let release: string | null = null;
	/** False when Caddy is not yet serving the site wildcard certificate. */
	let siteTls = true;
	try {
		// Any re-run against an existing database (with or without --upgrade) may apply
		// migrations, so always take a sealed bundle the rollback/operator can restore.
		if (existsSync(join(VAR_DIR, 'data', 'yoal.db'))) {
			step('Upgrade snapshot');
			if (options.dryRun) {
				log(`would seal a pre-upgrade bundle in ${join(VAR_DIR, 'backups')}`);
			} else {
				const bundle = createUpgradeSnapshotBundle({
					backupsDir: join(VAR_DIR, 'backups'),
					dbPath: join(VAR_DIR, 'data', 'yoal.db'),
					dataDir: join(VAR_DIR, 'data'),
					envDir: ETC_DIR,
					fromVersion: releaseVersion(previousRelease),
					targetVersion: options.version,
					migrations: migrationIds(SOURCE),
					desiredStateVersion: readDesiredStateVersion(join(VAR_DIR, 'data', 'yoal.db')),
					pinned: true,
					retain: 3
				});
				snapshot = bundle.controlDb;
				snapshotBundle = bundle.dir;
				log(`${bundle.dir}${bundle.controlDb ? '' : ' (no control DB)'}`);
			}
		}
		release = buildRelease(env);
		switchCurrent(release);
		installUpdateCommand();
		// yoal plus the operator scripts (yoal-restore, yoal-alert, …).
		installCliCommands();
		writeUnits(release);
		await installClickHouse();
		startServices();
		// The control plane served with the sealed key: the plaintext a migration kept can go.
		if (!options.dryRun && masterKey?.key) {
			const removed = finishMasterKeyMigration(MASTER_KEY_FILE, masterKey.key);
			if (removed) log(`removed the plaintext master key backup ${removed}`);
		}
		installBackups(env);
		bootstrapNode(env, release);
		if (!options.noAgent) {
			// Wait for the agent to reconcile and Caddy to serve the platform route.
			publicHealth(env);
			// Then the wildcard certificate, which a healthy install can still be missing.
			siteTls = await verifySiteTls();
		}
		printSetupLink(env);
		if (!options.dryRun && snapshotBundle) {
			retireUpgradeSnapshotBundles(join(VAR_DIR, 'backups'), snapshotBundle);
			pruneUpgradeSnapshotBundles(join(VAR_DIR, 'backups'), { keep: 3, protect: [snapshotBundle] });
		}
		step('Installed');
		console.log(`${color.green('Yoal is installed.')} Platform: ${env.get('YOAL_PLATFORM_ORIGIN')}`);
		if (!siteTls) {
			console.log(
				color.yellow(
					'warning: site HTTPS is not working yet — deployed sites will return Cloudflare error 525 until the certificate issues (see Site TLS above).',
				),
			);
		}
		console.log(`Logs: ${color.dim('journalctl -u yoal-control-plane -u yoal-agent -f')}`);
		await offerRecoveryKit();
	} catch (error) {
		console.error(color.red(`\nError: ${(error as Error).message}`));
		if (!options.dryRun) rollback(previousRelease, snapshot, previousLink);
		process.exit(1);
	}
}

/**
 * Recovery kit (DESIGN §10): offered once, at the end of a fresh interactive install. The master
 * key encrypts every secret, so a restore without it cannot decrypt them. Never fails the install.
 */
async function offerRecoveryKit(): Promise<void> {
	const later = 'sudo yoal-recovery-kit export --include-env';
	if (options.dryRun || options.upgrade) return;
	if (!interactive) {
		log(`Export a recovery kit and store it offline: ${later}`);
		return;
	}
	step('Recovery kit');
	log('The master key encrypts every secret; without it a restore cannot decrypt them.');
	if (!(await askYesNo('Export a passphrase-encrypted recovery kit now?', true))) {
		log(`Skipped. Later: ${later}`);
		return;
	}
	// The kit reads its passphrase from the terminal itself.
	const result = withTerminal(() =>
		Bun.spawnSync({
			cmd: ['/usr/local/sbin/yoal-recovery-kit', 'export', '--include-env'],
			stdio: ['inherit', 'inherit', 'inherit'],
		}),
	);
	if (result.exitCode === 130) log(`Cancelled. Later: ${later}`);
	else if (result.exitCode !== 0) log(color.yellow(`Export failed; run: ${later}`));
}

function uninstall(): void {
	step('Uninstall');
	if (options.dryRun) {
		log('would stop/disable/remove yoal units and, with --purge, delete data');
		return;
	}
	for (const service of ['yoal-agent', 'yoal-control-plane', 'yoal-helper']) {
		run('systemctl', ['disable', '--now', `${service}.service`], { allowFailure: true });
		rmSync(join(SYSTEMD_DIR, `${service}.service`), { force: true });
	}
	for (const unit of [PRIMARY_UNIT, STANDBY_UNIT]) rmSync(join(SYSTEMD_DIR, `${unit}.d`, MASTER_KEY_DROP_IN), { force: true });
	// Its data (/var/lib/yoal/clickhouse) and binary (/opt/yoal/clickhouse) go only with --purge.
	removeClickHouseUnit({ systemdDir: SYSTEMD_DIR, run: (cmd) => void run(cmd[0]!, cmd.slice(1), { allowFailure: true }) });
	for (const unit of BACKUP_UNITS) {
		if (!unit.includes('@')) run('systemctl', ['disable', '--now', unit], { allowFailure: true });
		rmSync(join(SYSTEMD_DIR, unit), { force: true });
	}
	for (const unit of [CONFIG_PATH_UNIT, CONFIG_SERVICE_UNIT]) {
		run('systemctl', ['disable', '--now', unit], { allowFailure: true });
		rmSync(join(SYSTEMD_DIR, unit), { force: true });
	}
	rmSync(CONFIG_COMMAND, { force: true });
	run('systemctl', ['daemon-reload'], { allowFailure: true });
	for (const path of CLI_COMMANDS) rmSync(path, { force: true });
	for (const command of RELEASE_COMMANDS) rmSync(command.path, { force: true });
	if (options.purge) {
		run('rm', ['-rf', OPT_DIR, VAR_DIR, ETC_DIR]);
		log('removed data and configuration');
	} else {
		log(`kept ${VAR_DIR} and ${ETC_DIR}; re-run with --uninstall --purge to delete`);
	}
}

/**
 * `--join`: a worker of an existing control plane (docs/CLUSTERING.md §4.1, C1). Packages,
 * runtimes, agent + helper from this source, then the one-time token is exchanged for a node
 * identity on the managed overlay. No control plane, database, ClickHouse, backups or setup link.
 *
 * Its Caddy serves plain HTTP on the overlay address only: the ingress node terminates TLS and
 * proxies over WireGuard, and nothing on the public interface answers for a site.
 */
async function joinWorker(join_: NonNullable<Options['join']>): Promise<void> {
	step('Preflight (worker)');
	if (process.platform !== 'linux') fail('Yoal installs on Linux only.');
	if (process.getuid?.() !== 0) fail('Run the installer as root (curl … | sudo sh).');
	if (!existsSync('/run/systemd/system')) fail('systemd is required.');
	if (existsSync(join(SYSTEMD_DIR, 'yoal-control-plane.service')))
		fail('This machine runs a Yoal control plane. Uninstall it (--uninstall --purge) before joining it as a worker.');
	if (existsSync(AGENT_ENV_FILE) && !options.yes)
		fail(`${AGENT_ENV_FILE} exists: this machine already joined. Re-run with --yes to join again as a new node.`);
	let controlUrl: URL;
	try {
		controlUrl = new URL(join_.controlUrl);
	} catch {
		fail(`Invalid control URL ${join_.controlUrl}`);
	}
	if (controlUrl.protocol !== 'https:') fail('The control URL must be https.');
	const endpoint = join_.endpoint || serverAddress();
	if (!endpoint) fail('Could not detect this machine\'s public IPv4; pass --endpoint <address>.');
	log(`joining ${controlUrl.origin} as "${join_.name}", WireGuard endpoint ${endpoint}`);
	if (options.dryRun) {
		log('would install packages and runtimes, build the agent and helper, join and start the agent');
		return;
	}
	installPrerequisites();
	if (!hasCommand('wg')) fail('wg is missing; install wireguard-tools.');
	await installAgentRuntimes();
	ensureUsersAndDirs();

	step('Environment');
	const env = new Map<string, string>([
		['NODE_ENV', 'production'],
		['YOAL_DATA_DIR', join(VAR_DIR, 'agent')],
		['YOAL_AGENT_VERSION', options.version],
		['YOAL_UPDATE_CHANNEL', options.channel],
		// TLS ends on the ingress node; this Caddy is an overlay-only upstream.
		['YOAL_TLS', '0'],
		['YOAL_CERT_PROBE_ADDR', 'off'],
	]);
	writeEnvFile(ENV_FILE, env);
	run('chown', ['root:yoal', ENV_FILE], { allowFailure: true });
	run('chmod', ['0640', ENV_FILE], { allowFailure: true });

	const release = buildRelease(env, 'worker');
	installWorkerLayout(release);

	step('systemd units');
	// Nothing listens publicly until the overlay address is known.
	if (ensureBootstrapCaddyfile('http://127.0.0.1:8080', '127.0.0.1')) run('systemctl', ['restart', 'caddy'], { allowFailure: true });
	run('systemctl', ['enable', 'caddy'], { allowFailure: true });
	ensureCaddyAccess();
	writeFileSync(join(SYSTEMD_DIR, 'yoal-agent.service'), agentUnit({ optDir: OPT_DIR, etcDir: ETC_DIR, varDir: VAR_DIR, runDir: RUN_DIR }));
	writeFileSync(join(SYSTEMD_DIR, STUDIO_UNIT), studioUnit({ optDir: OPT_DIR, runDir: RUN_DIR, socketGroup: 'caddy' }));
	writeFileSync(join(SYSTEMD_DIR, MAIL_UNIT), mailUnit({ optDir: OPT_DIR, runDir: RUN_DIR, socketGroup: 'caddy' }));
	writeFileSync(join(SYSTEMD_DIR, IDENTITY_UNIT), identityUnit({ optDir: OPT_DIR, runDir: RUN_DIR, socketGroup: 'caddy' }));
	writeFileSync(join(SYSTEMD_DIR, IDENTITY_LITESTREAM_UNIT), identityLitestreamUnit());
	ensureHelper({
		systemdDir: SYSTEMD_DIR,
		optDir: OPT_DIR,
		etcDir: ETC_DIR,
		varDir: VAR_DIR,
		bunBin: BUN_BIN,
		release,
		run: (cmd) => void run(cmd[0]!, cmd.slice(1), { allowFailure: true }),
		log,
		start: false,
	});
	// The binaries now live in /opt/yoal/current/agent and /opt/yoal/helper; the source build
	// (about 1.4 GB with node_modules) is not needed on a worker.
	rmSync(release, { recursive: true, force: true });
	run('systemctl', ['daemon-reload']);
	run('systemctl', ['enable', HELPER_UNIT]);
	run('systemctl', ['restart', HELPER_UNIT]);
	waitFor('helper socket', () => existsSync('/run/yoal-helper/helper.sock'), 30_000);

	step('Join');
	const agentBin = join(OPT_DIR, 'current', 'agent', 'yoal-agent');
	const joined = Bun.spawnSync({
		cmd: [agentBin, 'join', controlUrl.origin, '--token', join_.token, '--name', join_.name, '--network-mode', 'yoal', '--public-address', endpoint],
		env: { ...process.env, YOAL_DATA_DIR: env.get('YOAL_DATA_DIR')! },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (joined.exitCode !== 0) fail(`Join failed: ${new TextDecoder().decode(joined.stderr).trim()}`);
	writeFileSync(AGENT_ENV_FILE, new TextDecoder().decode(joined.stdout), { mode: 0o640 });
	run('chown', ['root:yoal', AGENT_ENV_FILE], { allowFailure: true });
	const nodeFile = join(env.get('YOAL_DATA_DIR')!, 'node.json');
	run('chown', ['-R', 'yoal:yoal', env.get('YOAL_DATA_DIR')!], { allowFailure: true });
	const node = JSON.parse(readFileSync(nodeFile, 'utf8')) as { nodeId: string; wireguard?: { address?: string | null } };
	const address = node.wireguard?.address;
	if (!address) fail('The control plane returned no overlay address.');
	log(`node ${node.nodeId}, overlay address ${address}`);
	// The ingress node proxies to <overlay address>:8080; bind nowhere else.
	env.set('YOAL_CADDY_LISTEN', `${address}:8080`);
	writeEnvFile(ENV_FILE, env);

	step('Start services');
	ensureBuilder({
		systemdDir: SYSTEMD_DIR,
		optDir: OPT_DIR,
		agentEnvFile: AGENT_ENV_FILE,
		run: (cmd) => void run(cmd[0]!, cmd.slice(1), { allowFailure: true }),
		capture: (cmd) => capture(cmd[0]!, cmd.slice(1)),
		log,
	});
	ensureStorageUnits({
		systemdDir: SYSTEMD_DIR,
		optDir: OPT_DIR,
		agentEnvFile: AGENT_ENV_FILE,
		run: (cmd) => void run(cmd[0]!, cmd.slice(1), { allowFailure: true }),
		log,
	});
	run('systemctl', ['enable', 'yoal-agent.service']);
	run('systemctl', ['restart', 'yoal-agent.service']);
	waitFor('agent socket', () => existsSync(join(RUN_DIR, 'agent.sock')), 90_000);
	step('Joined');
	console.log(`${color.green(`Node "${join_.name}" joined.`)} It appears in Nodes after its first heartbeat.`);
	console.log(`The overlay comes up once the ingress node has this node's key. Logs: ${color.dim('journalctl -u yoal-agent -f')}`);
}

/**
 * A worker's `/opt/yoal/current` is a plain directory with the agent binary, never a symlink to a
 * release: signed node updates (D99) replace `current/agent/yoal-agent` and `helper/yoal-helper`
 * in place, and the helper refuses a symlinked control-plane layout.
 */
function installWorkerLayout(release: string): void {
	step('Activate (worker layout)');
	const current = join(OPT_DIR, 'current');
	const stat = existsSync(current) ? lstatSync(current) : null;
	if (stat?.isSymbolicLink()) rmSync(current, { force: true });
	ensureDir(join(current, 'agent'), '0755', 'root:root');
	const binary = join(current, 'agent', 'yoal-agent');
	cpSync(join(release, 'agent', 'yoal-agent'), `${binary}.new`);
	chmodSync(`${binary}.new`, 0o755);
	renameSync(`${binary}.new`, binary);
	linkAgentCommands(current);
	log(`${binary} ${options.version}`);
}

const main = async (): Promise<void> => {
	console.log(`${color.bold('Yoal installer')} ${options.version} ${color.dim(`(${options.channel} channel)`)}`);
	if (options.uninstall) return uninstall();
	if (options.join) return joinWorker(options.join);
	return install();
};

main()
	.catch((error: unknown) => {
		console.error(color.red(`\nInstaller error: ${(error as Error).message}`));
		process.exit(1);
	})
	.finally(() => rl?.close());
