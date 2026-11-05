#!/usr/bin/env bun
/**
 * skiff-update-self: pull the latest Skiff from GitHub, build it next to the running release,
 * prove it boots, then hot-swap the control plane with automatic rollback.
 *
 * Installed by the installer as /usr/local/sbin/skiff-update-self, which runs this file from the
 * *current* (known-good) release, so a broken updater in a new release can never block its own
 * rollback.
 */
import { randomBytes } from 'node:crypto';
import {
	appendFileSync,
	chmodSync,
	chownSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
	SELF_UPDATE_DEFAULTS,
	type SelfUpdateLogLevel,
	type SelfUpdateOutcome,
	type SelfUpdateStatus,
} from '../../packages/contracts/src/self-update.ts';
import { formatEnvFile, readEnvFile } from '../install/env-file.ts';
import { TRIGGER_PATH_UNIT, triggerUnits } from './units.ts';
import { ensurePlatformConfigUnits } from '../platform-config/units.ts';
import { ensureBuilder, linkAgentCommands } from '../systemd/builder.ts';
import { ensureStorageUnits } from '../systemd/storage.ts';
import { R2ObjectStore } from '../../packages/core/src/object-store.ts';
import { listUpgradeSnapshotBundles } from '../../packages/core/src/upgrade-plan.ts';
import {
	AGENT,
	CONTROL_PLANE,
	type Host,
	type CheckResult,
	type RollbackResult,
	type UpdateResult,
	RecoveryError,
	UpdateError,
	Updater,
	layoutFromEnv,
} from './updater.ts';

const USAGE = `skiff-update-self — update the Skiff control plane from GitHub, reversibly

Usage:
  skiff-update-self [update] [options]   install the latest version if VERSION on GitHub is newer (semver)
  skiff-update-self check [--json]       show the running and latest versions; change nothing
  skiff-update-self plan [--json]        preflight the upgrade (disk, backup target, migrations)
  skiff-update-self rollback [options]   switch back to the previous release (repeat to undo)
  skiff-update-self status [--json]      show current/previous releases and the last switch

update options:
  --ref <ref>          branch, tag or sha (default: the ref the current release was built from, else main)
  --repo <owner/name>  GitHub repository (default: from the current release, else KieranHolroyd/skiff)
  --force              install even if not newer (rebuild/downgrade), or retry a commit that failed
  --trigger <who>      cli (default) or dashboard; recorded in the status the dashboard shows
  --with-agent         also restart skiff-agent on the new release (and back on rollback)
  --no-canary          skip the isolated pre-swap boot against a copy of the database
  --require-public     the public URL must answer after the swap (default: only if it did before)
  --no-public-check    never gate on the public URL
  --allow-destructive  approve a reviewed destructive migration in the preflight
  --dry-run            resolve the commit and print the plan; change nothing

rollback options:
  --restore-db         also restore the database snapshot taken when the current release was activated
  --keep-db            run the previous code against the current (possibly newer) schema
  --with-agent         also restart skiff-agent
  --dry-run            print the plan; change nothing

Environment:
  SKIFF_GITHUB_TOKEN   token for a private repository (or put it in /etc/skiff/github.token, 0600)
  SKIFF_REPO, SKIFF_REF  defaults for --repo / --ref

Exit status: 0 updated / up to date / nothing to do, 1 nothing changed or rolled back to the old
release (it is serving), 2 the old release could not be brought back (act now), 64 usage error.
`;

const layout = layoutFromEnv();
const ETC_DIR = process.env.SKIFF_ETC_DIR ?? '/etc/skiff';
const RUN_DIR = process.env.SKIFF_RUN_DIR ?? '/run/skiff';
const ENV_FILE = join(ETC_DIR, 'skiff.env');
const AGENT_ENV_FILE = join(ETC_DIR, 'agent.env');
const MASTER_KEY_FILE = join(ETC_DIR, 'master.key');
const CONTROL_SOCKET = join(RUN_DIR, 'control.sock');
const STATUS_FILE = process.env.SKIFF_UPDATE_STATUS_FILE ?? SELF_UPDATE_DEFAULTS.statusFile;
const LOG_FILE = process.env.SKIFF_UPDATE_LOG_FILE ?? SELF_UPDATE_DEFAULTS.logFile;
const REQUEST_FILE = process.env.SKIFF_UPDATE_REQUEST_FILE ?? SELF_UPDATE_DEFAULTS.requestFile;
const SYSTEMD_DIR = process.env.SKIFF_SYSTEMD_DIR ?? '/etc/systemd/system';

const tty = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2);
const yellow = paint(33);
const red = paint(31);
const bold = paint(1);

// ------------------------------------------------------------------ CLI parsing

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('-') ? argv.shift()! : 'update';
const known = new Set([
	'--ref',
	'--repo',
	'--force',
	'--with-agent',
	'--no-canary',
	'--require-public',
	'--no-public-check',
	'--allow-destructive',
	'--dry-run',
	'--restore-db',
	'--keep-db',
	'--json',
	'--trigger',
	'--help',
	'-h',
]);
const withValue = new Set(['--ref', '--repo', '--trigger']);
for (let i = 0; i < argv.length; i++) {
	if (!known.has(argv[i]!)) usageError(`unknown option ${argv[i]}`);
	if (withValue.has(argv[i]!)) {
		if (!argv[i + 1] || argv[i + 1]!.startsWith('-')) usageError(`${argv[i]} needs a value`);
		i++;
	}
}
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};

function usageError(text: string): never {
	console.error(`skiff-update-self: ${text}\n\n${USAGE}`);
	process.exit(64);
}

// ------------------------------------------------------------------- real host

/**
 * Live update log for the dashboard (JSON Lines, root:skiff 0640). A fresh file per update run;
 * the control plane only reads it. Writing must never break an update, so every failure is silent
 * (after one console warning).
 */
let logEnabled = false;

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function appendLog(level: SelfUpdateLogLevel, text: string): void {
	if (!logEnabled) return;
	const at = new Date().toISOString();
	for (const raw of stripAnsi(text).split(/\r\n|\r|\n/)) {
		const line = raw.trimEnd();
		if (!line) continue;
		try {
			appendFileSync(LOG_FILE, `${JSON.stringify({ at, level, text: line.slice(0, 4000) })}\n`);
		} catch {
			// Progress reporting must never break an update.
		}
	}
}

function startUpdateLog(trigger: string): void {
	try {
		const dir = dirname(LOG_FILE);
		mkdirSync(dir, { recursive: true, mode: 0o750 });
		const gid = skiffGroupId();
		if (gid !== null) chownSync(dir, 0, gid);
		chmodSync(dir, 0o750);
		writeFileSync(LOG_FILE, '', { mode: 0o640 });
		if (gid !== null) chownSync(LOG_FILE, 0, gid);
		chmodSync(LOG_FILE, 0o640);
		logEnabled = true;
		appendLog('info', `Skiff self-update started from the ${trigger} at ${new Date().toISOString()}`);
	} catch (error) {
		logEnabled = false;
		console.error(dim(`  (could not write ${LOG_FILE}: ${(error as Error).message})`));
	}
}

function run(
	cmd: string[],
	opts: { cwd?: string; quiet?: boolean; allowFailure?: boolean; env?: Record<string, string> } = {},
): { code: number; stdout: string; stderr: string } {
	if (!opts.quiet) {
		console.log(dim(`  $ ${cmd.join(' ')}`));
		appendLog('command', `$ ${cmd.join(' ')}`);
	}
	const result = Bun.spawnSync({
		cmd,
		cwd: opts.cwd,
		env: { ...process.env, PATH: `${dirname(layout.bunBin)}:${process.env.PATH ?? ''}`, ...opts.env },
		stdout: opts.quiet ? 'pipe' : 'inherit',
		stderr: opts.quiet ? 'pipe' : 'inherit',
	});
	const out = {
		code: result.exitCode ?? 1,
		stdout: result.stdout ? new TextDecoder().decode(result.stdout).trim() : '',
		stderr: result.stderr ? new TextDecoder().decode(result.stderr).trim() : '',
	};
	if (out.code !== 0 && !opts.allowFailure) {
		if (out.stderr) appendLog('error', out.stderr);
		throw new Error(`${cmd.join(' ')} exited ${out.code}${out.stderr ? `: ${out.stderr}` : ''}`);
	}
	return out;
}

/**
 * Build steps can run for minutes, so their output is streamed line by line to the console and
 * the live log instead of being buffered until exit.
 */
async function runStreaming(cmd: string[], opts: { cwd?: string } = {}): Promise<void> {
	console.log(dim(`  $ ${cmd.join(' ')}`));
	appendLog('command', `$ ${cmd.join(' ')}`);
	const child = Bun.spawn({
		cmd,
		cwd: opts.cwd,
		env: { ...process.env, PATH: `${dirname(layout.bunBin)}:${process.env.PATH ?? ''}` },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const tail: string[] = [];
	const consume = async (stream: ReadableStream<Uint8Array>, level: 'output' | 'error') => {
		const decoder = new TextDecoder();
		let pending = '';
		const emit = (line: string) => {
			const text = line.replace(/\r$/, '');
			if (!text) return;
			process.stdout.write(`${text}\n`);
			appendLog(level, text);
			if (level === 'error') {
				tail.push(text);
				if (tail.length > 20) tail.shift();
			}
		};
		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });
			const parts = pending.split(/\r\n|\r|\n/);
			pending = parts.pop() ?? '';
			for (const part of parts) emit(part);
		}
		pending += decoder.decode();
		if (pending) emit(pending);
	};
	const readers: Promise<void>[] = [];
	if (child.stdout) readers.push(consume(child.stdout, 'output'));
	if (child.stderr) readers.push(consume(child.stderr, 'error'));
	await Promise.all(readers);
	const code = await child.exited;
	if (code !== 0)
		throw new Error(`${cmd.join(' ')} exited ${code}${tail.length ? `: ${tail.join(' ')}` : ''}`);
}

function githubToken(): string | undefined {
	if (process.env.SKIFF_GITHUB_TOKEN) return process.env.SKIFF_GITHUB_TOKEN;
	const file = join(ETC_DIR, 'github.token');
	return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined;
}

function githubHeaders(accept: string): Record<string, string> {
	const token = githubToken();
	return {
		Accept: accept,
		'User-Agent': 'skiff-update-self',
		'X-GitHub-Api-Version': '2022-11-28',
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

const platformOrigin = () => readEnvFile(ENV_FILE).get('SKIFF_PLATFORM_ORIGIN')?.replace(/\/$/, '');

/**
 * Healthy = `/api/setup/status` returns the setup JSON (proves the app booted and can query SQLite)
 * and `/login` renders without a server error (proves SSR works).
 */
async function socketHealthy(socket: string): Promise<boolean> {
	const origin = platformOrigin() ?? 'http://localhost';
	const host = new URL(origin).host;
	const headers = { Host: host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': host };
	try {
		const status = await fetch('http://localhost/api/setup/status', {
			unix: socket,
			headers,
			signal: AbortSignal.timeout(3_000),
		});
		if (status.status !== 200) return false;
		const body = (await status.json()) as { needsSetup?: unknown };
		if (typeof body.needsSetup !== 'boolean') return false;
		const login = await fetch('http://localhost/login', {
			unix: socket,
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(5_000),
		});
		await login.arrayBuffer();
		return login.status < 500;
	} catch {
		return false;
	}
}

/**
 * `/readyz` smoke test. A release from before the endpoint existed (a forced downgrade) falls
 * back to the older setup-status check so the updater stays backward compatible.
 */
async function readyzHealthy(socket: string, timeoutMs: number): Promise<boolean> {
	const origin = platformOrigin() ?? 'http://localhost';
	const host = new URL(origin).host;
	const headers = { Host: host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': host };
	return poll(async () => {
		try {
			const response = await fetch('http://localhost/readyz', {
				unix: socket,
				headers,
				signal: AbortSignal.timeout(5_000)
			});
			if (response.status === 404) return socketHealthy(socket);
			if (response.status !== 200) return false;
			const body = (await response.json()) as { ok?: unknown };
			return body.ok === true;
		} catch {
			return false;
		}
	}, timeoutMs);
}

async function poll(check: () => Promise<boolean>, timeoutMs: number, everyMs = 1_000): Promise<boolean> {	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() + everyMs > deadline) return false;
		await Bun.sleep(everyMs);
	}
}

const unitState = (unit: string) =>
	run(['systemctl', 'is-active', unit], { quiet: true, allowFailure: true }).stdout;

// ------------------------------------------------------------- dashboard status

let skiffGid: number | null | undefined;
function skiffGroupId(): number | null {
	if (skiffGid === undefined) {
		const entry = run(['getent', 'group', 'skiff'], { quiet: true, allowFailure: true }).stdout;
		const gid = Number(entry.split(':')[2]);
		skiffGid = Number.isInteger(gid) ? gid : null;
	}
	return skiffGid;
}

/** root:skiff 0750 directory, root:skiff 0640 file: the control plane can read it, never write it. */
function writeStatusFile(status: SelfUpdateStatus): void {
	try {
		const dir = dirname(STATUS_FILE);
		mkdirSync(dir, { recursive: true, mode: 0o750 });
		const gid = skiffGroupId();
		if (gid !== null) chownSync(dir, 0, gid);
		chmodSync(dir, 0o750);
		const tmp = `${STATUS_FILE}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o640 });
		if (gid !== null) chownSync(tmp, 0, gid);
		renameSync(tmp, STATUS_FILE);
	} catch (error) {
		// Progress reporting must never break an update.
		console.error(dim(`  (could not write ${STATUS_FILE}: ${(error as Error).message})`));
	}
}

let status: SelfUpdateStatus | null = null;
function reportStatus(patch: Partial<SelfUpdateStatus>): void {
	if (!status) return;
	status = { ...status, ...patch, updatedAt: new Date().toISOString() };
	writeStatusFile(status);
}

function outcomeMessage(result: UpdateResult): { outcome: SelfUpdateOutcome; message: string } {
	const from = result.fromVersion ?? 'the current release';
	const first = (text: string) => text.split('\n')[0] ?? text;
	switch (result.status) {
		case 'updated':
			return { outcome: 'updated', message: `Updated ${from} → ${result.version}.` };
		case 'up-to-date':
			return {
				outcome: 'up-to-date',
				message:
					result.fromVersion === result.version
						? `Already on the latest version (${result.version}).`
						: `The latest version (${result.version}) is not newer than ${from}.`,
			};
		case 'skipped':
			return { outcome: 'skipped', message: `Skipped: ${result.reason}` };
		case 'build-failed':
			return { outcome: 'build-failed', message: `Building ${result.version} failed; ${from} is still running. ${first(result.reason)}` };
		case 'canary-failed':
			return {
				outcome: 'canary-failed',
				message: `${result.version} failed its test boot; ${from} is still running. ${first(result.reason.replace(/^the new release did not become healthy in isolation\n?/, ''))}`.trim(),
			};
		case 'rolled-back':
			return result.recovered
				? { outcome: 'rolled-back', message: `${result.version} was unhealthy (${result.reason}); rolled back to ${from}.` }
				: { outcome: 'error', message: `${result.version} was unhealthy and the rollback did not recover (${result.reason}). Check journalctl -u ${CONTROL_PLANE}.` };
		case 'dry-run':
			return { outcome: 'up-to-date', message: 'Dry run.' };
	}
}

/**
 * Make sure the dashboard trigger exists (path + oneshot service). Idempotent; only reloads
 * systemd when a unit changed. Existing hosts get the dashboard button after one CLI run.
 */
function ensureTriggerUnits(): void {
	let changed = false;
	for (const [name, body] of Object.entries(triggerUnits({ requestFile: REQUEST_FILE, command: '/usr/local/sbin/skiff-update-self' }))) {
		const path = join(SYSTEMD_DIR, name);
		if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
		writeFileSync(path, body, { mode: 0o644 });
		changed = true;
	}
	// The control plane writes requests here; it must be the skiff user's, not root's.
	mkdirSync(dirname(REQUEST_FILE), { recursive: true, mode: 0o750 });
	run(['chown', 'skiff:skiff', dirname(REQUEST_FILE)], { quiet: true, allowFailure: true });
	if (changed) {
		run(['systemctl', 'daemon-reload'], { quiet: true });
		run(['systemctl', 'enable', '--now', TRIGGER_PATH_UNIT], { quiet: true, allowFailure: true });
		host.log(`dashboard updates enabled (${TRIGGER_PATH_UNIT})`);
	}
	// The same trick for Settings → Backups / Notifications (docs/OPS.md §4.3).
	ensurePlatformConfigUnits({
		systemdDir: SYSTEMD_DIR,
		optDir: layout.optDir,
		bunBin: layout.bunBin,
		run: (cmd) => void run(cmd, { quiet: true, allowFailure: true }),
		log: (message) => host.log(message),
	});
	// Hosts installed before D47 get the Builder unit; it idles until the node has the role. This
	// updater's own release was built from source with the builder subcommand, so mark it too (a
	// release assembled by an older updater lacks the link).
	if (existsSync(AGENT_ENV_FILE)) {
		linkAgentCommands(resolve(import.meta.dir, '../../..'));
		ensureBuilder({
			systemdDir: SYSTEMD_DIR,
			optDir: layout.optDir,
			agentEnvFile: AGENT_ENV_FILE,
			run: (cmd) => void run(cmd, { quiet: true, allowFailure: true }),
			capture: (cmd) => {
				const result = run(cmd, { quiet: true, allowFailure: true });
				return result.code === 0 ? result.stdout : null;
			},
			log: (message) => host.log(message),
		});
		ensureStorageUnits({
			systemdDir: SYSTEMD_DIR,
			optDir: layout.optDir,
			agentEnvFile: AGENT_ENV_FILE,
			run: (cmd) => void run(cmd, { quiet: true, allowFailure: true }),
			log: (message) => host.log(message),
		});
	}
}

const SHIELDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Root has no @types/node, so Bun's `process.on` typing only knows `memoryPressure`.
const signals = process as unknown as { on(e: string, l: () => void): void; off(e: string, l: () => void): void };
let shield: (() => void) | null = null;

const host: Host = {
	log: (text) => {
		console.log(`${dim('  •')} ${text}`);
		appendLog('info', text);
	},
	warn: (text) => {
		console.error(`${yellow('  !')} ${text}`);
		appendLog('warn', text);
	},
	now: () => new Date(),
	sleep: (ms) => Bun.sleep(ms),

	async resolveCommit(repo, ref) {
		const response = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
			headers: githubHeaders('application/vnd.github.sha'),
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok)
			throw new UpdateError(
				`GitHub ${response.status} resolving ${repo}@${ref}${response.status === 404 ? ' (private repo? set SKIFF_GITHUB_TOKEN)' : ''}`,
			);
		return (await response.text()).trim();
	},

	async readVersionFile(repo, commit) {
		const response = await fetch(`https://api.github.com/repos/${repo}/contents/VERSION?ref=${commit}`, {
			headers: githubHeaders('application/vnd.github.raw+json'),
			signal: AbortSignal.timeout(20_000),
		});
		if (response.status === 404) throw new UpdateError(`${repo}@${commit.slice(0, 12)} has no VERSION file at the repository root`);
		if (!response.ok) throw new UpdateError(`GitHub ${response.status} reading VERSION at ${repo}@${commit.slice(0, 12)}`);
		const text = await response.text();
		if (text.length > 1024) throw new UpdateError('VERSION file is unexpectedly large');
		return text;
	},

	phase(phase, detail, versions) {
		console.log(`${dim('  •')} ${detail}`);
		appendLog('phase', `[${phase}] ${detail}`);
		reportStatus({
			phase,
			message: detail,
			...(versions ? { fromVersion: versions.fromVersion ?? null, toVersion: versions.version ?? null } : {}),
		});
	},

	async fetchSource(repo, commit, dest) {
		const response = await fetch(`https://api.github.com/repos/${repo}/tarball/${commit}`, {
			headers: githubHeaders('application/vnd.github+json'),
			signal: AbortSignal.timeout(300_000),
		});
		if (!response.ok) throw new UpdateError(`GitHub ${response.status} downloading ${repo}@${commit}`);
		const archive = `${dest}.tar.gz`;
		await Bun.write(archive, response);
		try {
			run(['tar', '-xzf', archive, '-C', dest, '--strip-components=1', '--no-same-owner'], { quiet: true });
		} finally {
			rmSync(archive, { force: true });
		}
		if (!existsSync(join(dest, 'apps', 'control-plane', 'package.json')))
			throw new UpdateError(`${repo}@${commit} does not look like Skiff (no apps/control-plane)`);
	},

	async build(repoDir) {
		const bun = layout.bunBin;
		await runStreaming([bun, 'install', '--frozen-lockfile'], { cwd: repoDir });
		await runStreaming([bun, 'run', '--cwd', 'apps/control-plane', 'build'], { cwd: repoDir });
		await runStreaming([bun, 'run', '--cwd', 'apps/agent', 'build'], { cwd: repoDir });
		await runStreaming([bun, 'run', '--cwd', 'apps/cli', 'build'], { cwd: repoDir });
	},

	/**
	 * Transient unit with the production identity and sandbox, but its own socket and data dir.
	 * The environment is written to a file (not --setenv) so secrets stay off the command line, and
	 * every override is in that one file: with EnvironmentFile= and Environment= both set, systemd
	 * lets the file win, which could otherwise point the canary at the live database.
	 */
	async canary(release, scratch) {
		const unit = `skiff-update-canary-${randomBytes(4).toString('hex')}`;
		const socket = join(scratch, 'control.sock');
		mkdirSync(join(scratch, 'data', 'objects'), { recursive: true });
		const env = readEnvFile(ENV_FILE);
		// No outbound side effects from the copy: no email, alerts, R2 writes or backups.
		for (const key of [...env.keys()])
			if (/^(SKIFF_SMTP_|SKIFF_ALERT_|R2_|SKIFF_R2_)/.test(key)) env.delete(key);
		env.set('SKIFF_OBJECT_STORE', 'local');
		env.set('SKIFF_DAILY_BACKUPS', '0');
		env.set('SKIFF_DATA_DIR', join(scratch, 'data'));
		env.set('SKIFF_MASTER_KEY_FILE', `/run/credentials/${unit}.service/master-key`);
		env.set('SOCKET_PATH', socket);
		env.set('NODE_ENV', 'production');
		env.set('PROTOCOL_HEADER', 'x-forwarded-proto');
		env.set('HOST_HEADER', 'x-forwarded-host');
		// The sandbox makes $HOME read-only; do not let Bun try to write its transpiler cache there.
		env.set('BUN_RUNTIME_TRANSPILER_CACHE_PATH', '0');
		const envFile = join(dirname(scratch), `${unit}.env`);
		writeFileSync(envFile, formatEnvFile(env, false), { mode: 0o600 });

		const props = [
			'User=skiff',
			'Group=skiff',
			'UMask=0007',
			`EnvironmentFile=${envFile}`,
			`LoadCredential=master-key:${MASTER_KEY_FILE}`,
			`WorkingDirectory=${release}/repo/apps/control-plane`,
			'NoNewPrivileges=yes',
			'PrivateTmp=yes',
			'PrivateDevices=yes',
			'ProtectSystem=strict',
			'ProtectHome=yes',
			`ReadWritePaths=${scratch}`,
			'MemoryMax=512M',
			'RuntimeMaxSec=180',
		];
		let healthy = false;
		try {
			run(
				[
					'systemd-run',
					`--unit=${unit}`,
					'--quiet',
					'--collect',
					...props.map((p) => `--property=${p}`),
					'--',
					`${release}/runtime/bun`,
					`${release}/repo/apps/control-plane/build/index.js`,
				],
				{ quiet: true },
			);
			healthy = await poll(async () => {
				const state = unitState(unit);
				if (state !== 'active' && state !== 'activating') throw new Error(`canary exited (${state || 'gone'})`);
				return (await socketHealthy(socket)) && (await readyzHealthy(socket, 5_000));
			}, 90_000).catch(() => false);
			if (healthy) {
				await Bun.sleep(3_000);
				healthy = unitState(unit) === 'active' && (await socketHealthy(socket)) && (await readyzHealthy(socket, 5_000));
			}
		} finally {
			run(['systemctl', 'stop', unit], { quiet: true, allowFailure: true });
			rmSync(envFile, { force: true });
		}
		if (!healthy) {
			const logs = run(['journalctl', '-u', unit, '-n', '60', '--no-pager', '-o', 'cat'], {
				quiet: true,
				allowFailure: true,
			}).stdout;
			throw new UpdateError(`the new release did not become healthy in isolation\n${logs}`);
		}
	},

	async start(unit) {
		run(['systemctl', 'start', unit]);
	},
	async stop(unit) {
		run(['systemctl', 'stop', unit], { allowFailure: true });
	},
	async restart(unit) {
		run(['systemctl', 'restart', unit]);
	},
	async isActive(unit) {
		return unitState(unit) === 'active';
	},
	async restartCount(unit) {
		return Number(run(['systemctl', 'show', '-p', 'NRestarts', '--value', unit], { quiet: true, allowFailure: true }).stdout) || 0;
	},
	controlPlaneHealthy: (timeoutMs) => poll(() => socketHealthy(CONTROL_SOCKET), timeoutMs),
	publicHealthy(timeoutMs) {
		const origin = platformOrigin();
		if (!origin) return Promise.resolve(false);
		return poll(async () => {
			try {
				const response = await fetch(`${origin}/api/setup/status`, { signal: AbortSignal.timeout(10_000) });
				await response.arrayBuffer();
				return response.ok;
			} catch {
				return false;
			}
		}, timeoutMs, 2_000);
	},
	agentEnrolled: () => existsSync(AGENT_ENV_FILE),
	chownToSkiff(path) {
		run(['chown', '-R', 'skiff:skiff', path], { quiet: true });
	},
	freeBytes(path) {
		const line = run(['df', '-Pk', path], { quiet: true }).stdout.split('\n')[1] ?? '';
		return Number(line.trim().split(/\s+/)[3] ?? 0) * 1024;
	},
	async backupTarget() {
		try {
			const env = readEnvFile(ENV_FILE);
			if (env.get('SKIFF_OBJECT_STORE') !== 'r2') {
				const dir = join(env.get('SKIFF_DATA_DIR') ?? dirname(layout.dbPath), 'objects');
				mkdirSync(dir, { recursive: true });
				return { ok: true, kind: 'local' };
			}
			const accountId = env.get('R2_ACCOUNT_ID');
			const bucket = env.get('R2_BUCKET');
			const accessKeyId = env.get('R2_ACCESS_KEY_ID');
			const secretAccessKey = env.get('R2_SECRET_ACCESS_KEY');
			if (!accountId || !bucket || !accessKeyId || !secretAccessKey)
				return { ok: false, kind: 'r2', error: 'R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY is missing.' };
			const store = new R2ObjectStore({
				accountId,
				bucket,
				accessKeyId,
				secretAccessKey,
				...(env.get('R2_ENDPOINT') ? { endpoint: env.get('R2_ENDPOINT')! } : {})
			});
			const result = await Promise.race([
				store.testConnection(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('backup target probe timed out after 10s')), 10_000).unref?.()
				)
			]);
			return { ok: result.ok, kind: 'r2', ...(result.error ? { error: result.error } : {}) };
		} catch (error) {
			return { ok: false, kind: 'unknown', error: error instanceof Error ? error.message : String(error) };
		}
	},
	readyz: (timeoutMs) => readyzHealthy(CONTROL_SOCKET, timeoutMs),
	enterCritical() {
		if (shield) return;
		shield = () => host.warn('swap in progress; ignoring the signal so it can finish or roll back');
		for (const signal of SHIELDED) signals.on(signal, shield);
	},
	leaveCritical() {
		if (!shield) return;
		for (const signal of SHIELDED) signals.off(signal, shield);
		shield = null;
	},
};

// ------------------------------------------------------------------- commands

function preflight(): void {
	if (process.platform !== 'linux') throw new UpdateError('skiff-update-self runs on the Skiff host (Linux).');
	if (process.getuid?.() !== 0) throw new UpdateError('Run as root: sudo skiff-update-self');
	if (!existsSync('/run/systemd/system')) throw new UpdateError('systemd is required.');
	if (!existsSync(layout.bunBin)) throw new UpdateError(`Bun not found at ${layout.bunBin}.`);
}

function describe(path: string | undefined, meta: { commit?: string; builtAt?: string; ref?: string; status?: string }) {
	if (!path) return dim('none');
	const parts = [meta.commit ? meta.commit.slice(0, 12) : 'unknown commit', meta.ref, meta.builtAt && `built ${meta.builtAt}`];
	return `${path.split('/').pop()} ${dim(`(${parts.filter(Boolean).join(', ')})`)}`;
}

function exitCodeForUpdate(result: UpdateResult): number {
	switch (result.status) {
		case 'updated':
		case 'up-to-date':
		case 'skipped':
		case 'dry-run':
			return 0;
		case 'rolled-back':
			return result.recovered ? 1 : 2;
		default:
			return 1;
	}
}

function exitCodeForRollback(result: RollbackResult): number {
	if (result.status === 'reverted') return result.recovered ? 1 : 2;
	return 0;
}

async function main(): Promise<number> {
	if (flag('--help') || flag('-h') || command === 'help') {
		console.log(USAGE);
		return 0;
	}
	const updater = new Updater(layout, host);

	if (command === 'status') {
		const status = updater.status();
		if (flag('--json')) {
			console.log(JSON.stringify(status, null, 2));
			return 0;
		}
		console.log(`${bold('current ')} ${describe(status.current?.path, status.current?.meta ?? {})}`);
		console.log(`${bold('previous')} ${describe(status.previous?.path, status.previous?.meta ?? {})}`);
		const last = status.state.lastSwitch;
		if (last)
			console.log(`${bold('last    ')} ${last.kind} ${last.from.split('/').pop()} -> ${last.to.split('/').pop()} at ${last.at}${last.snapshot ? dim(` (db snapshot ${last.snapshot})`) : ''}`);
		if (status.state.inProgress) console.log(yellow(`interrupted ${status.state.inProgress.kind}; the next command will recover it`));
		for (const [commit, failure] of Object.entries(status.state.failedCommits))
			console.log(`${red('failed  ')} ${commit.slice(0, 12)} at ${failure.at}: ${failure.reason}`);
		const bundles = listUpgradeSnapshotBundles(layout.backupsDir);
		if (bundles.length > 0) {
			console.log(bold('snapshots'));
			for (const bundle of bundles)
				console.log(
					`  ${basename(bundle.dir)} ${bundle.manifest.pinned ? yellow('pinned') : ''} ${dim(`${bundle.manifest.createdAt} ${bundle.manifest.fromVersion ?? '?'} -> ${bundle.manifest.targetVersion ?? '?'}`)}`
				);
		}
		return 0;
	}

	preflight();
	try {
		ensureTriggerUnits();
	} catch (error) {
		host.warn(`could not install the dashboard trigger units: ${(error as Error).message}`);
	}

	if (command === 'check') {
		const result: CheckResult = await updater.check({
			repo: option('--repo') ?? process.env.SKIFF_REPO,
			ref: option('--ref') ?? process.env.SKIFF_REF,
		});
		if (flag('--json')) console.log(JSON.stringify(result, null, 2));
		else {
			console.log(`${bold('running')} ${result.fromVersion ?? dim('unknown')}`);
			console.log(`${bold('latest ')} ${result.version} ${dim(`(${result.repo}@${result.ref}, ${result.commit.slice(0, 12)})`)}`);
			console.log(
				result.failed
					? yellow(`${result.version} failed to install before (${result.failed}); \`update --force\` retries it`)
					: result.available
						? `update available — run ${bold('sudo skiff-update-self')}`
						: 'up to date',
			);
		}
		return 0;
	}

	if (command === 'plan') {
		const result = await updater.plan({
			repo: option('--repo') ?? process.env.SKIFF_REPO,
			ref: option('--ref') ?? process.env.SKIFF_REF
		});
		if (flag('--json')) {
			console.log(JSON.stringify(result, null, 2));
			return result.preflight.ok ? 0 : 1;
		}
		const { check, preflight } = result;
		console.log(`${bold('running')} ${check.fromVersion ?? dim('unknown')}`);
		console.log(`${bold('latest ')} ${check.version} ${dim(`(${check.repo}@${check.ref}, ${check.commit.slice(0, 12)})`)}`);
		console.log(
			`${bold('plan    ')} ${preflight.ok ? 'ready' : 'refused'} · ${preflight.migrations.pending.length} pending migration(s)${preflight.migrations.destructive ? ' · destructive' : ''}`
		);
		for (const check of preflight.checks) console.log(`  ${check.status === 'ok' ? dim('ok  ') : check.status === 'warn' ? yellow('warn') : red('fail')} ${check.id}: ${check.message}`);
		for (const warning of preflight.warnings) console.log(yellow(`warning: ${warning}`));
		for (const error of preflight.errors) console.error(red(`error: ${error}`));
		console.log(dim(`The update re-runs this against the exact staged release before the canary.`));
		return preflight.ok ? 0 : 1;
	}

	if (command === 'update') {
		console.log(bold('Skiff self-update'));
		const trigger = option('--trigger') === 'dashboard' ? 'dashboard' : 'cli';
		const dryRun = flag('--dry-run');
		if (!dryRun) {
			startUpdateLog(trigger);
			const now = new Date().toISOString();
			status = {
				running: true,
				trigger,
				phase: 'checking',
				message: 'Checking for a newer version',
				fromVersion: null,
				toVersion: null,
				startedAt: now,
				updatedAt: now,
			};
			writeStatusFile(status);
		}
		const finish = (outcome: SelfUpdateOutcome, message: string, versions: Partial<SelfUpdateStatus> = {}) => {
			appendLog(outcome === 'updated' || outcome === 'up-to-date' ? 'info' : 'warn', message);
			reportStatus({ running: false, phase: 'done', outcome, message, finishedAt: new Date().toISOString(), ...versions });
		};
		signals.on('exit', () => {
			if (status?.running) finish('error', `The updater exited unexpectedly. Check journalctl -u skiff-update-self.`);
		});
		const publicCheck = flag('--no-public-check') ? 'skip' : flag('--require-public') ? 'require' : 'auto';
		let result: UpdateResult;
		try {
			result = await updater.update({
			repo: option('--repo') ?? process.env.SKIFF_REPO,
			ref: option('--ref') ?? process.env.SKIFF_REF,
			force: flag('--force'),
			withAgent: flag('--with-agent'),
			canary: !flag('--no-canary'),
			dryRun,
			publicCheck,
			allowDestructiveMigrations: flag('--allow-destructive'),
		});
		} catch (error) {
			finish('error', (error as Error).message);
			throw error;
		}
		const done = outcomeMessage(result);
		finish(done.outcome, done.message, { fromVersion: result.fromVersion, toVersion: result.version });
		if (result.status === 'build-failed' || result.status === 'canary-failed') console.error(red(result.reason));
		if (result.status === 'rolled-back')
			console.error(
				result.recovered
					? yellow(`Rolled back: ${result.reason}. The previous release is serving; ${result.commit.slice(0, 12)} will be skipped until --force.`)
					: red(`Rollback did not recover the control plane (${result.reason}). Run: journalctl -u ${CONTROL_PLANE} -n 200`),
			);
		return exitCodeForUpdate(result);
	}

	if (command === 'rollback') {
		console.log(bold('Skiff rollback'));
		const result = await updater.rollback({
			restoreDb: flag('--restore-db'),
			keepDb: flag('--keep-db'),
			withAgent: flag('--with-agent'),
			dryRun: flag('--dry-run'),
		});
		if (result.status === 'reverted')
			console.error(
				result.recovered
					? yellow(`The previous release was unhealthy (${result.reason}); still on the current release.`)
					: red(`Neither release is healthy (${result.reason}). Run: journalctl -u ${CONTROL_PLANE} -u ${AGENT} -n 200`),
			);
		return exitCodeForRollback(result);
	}

	usageError(`unknown command ${command}`);
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		console.error(red(`skiff-update-self: ${error instanceof Error ? error.message : String(error)}`));
		process.exit(error instanceof RecoveryError ? 2 : 1);
	},
);
