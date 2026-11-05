#!/usr/bin/env bun
/**
 * skiff-update-self: pull the latest Skiff from GitHub, build it next to the running release,
 * prove it boots, then hot-swap the control plane with automatic rollback.
 *
 * Installed by the installer as /usr/local/sbin/skiff-update-self, which runs this file from the
 * *current* (known-good) release, so a broken updater in a new release can never block its own
 * rollback.
 */
import {
	appendFileSync,
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
	SELF_UPDATE_DEFAULTS,
	selfUpdateModeFile,
	updateSourceForMethod,
	type SelfUpdateLogLevel,
	type SelfUpdateMethod,
	type SelfUpdateOutcome,
	type SelfUpdateStatus,
} from '../../packages/contracts/src/self-update.ts';
import { readEnvFile } from '../install/env-file.ts';
import { TRIGGER_PATH_UNIT, triggerUnits, updateCommandScript } from './units.ts';
import { runCanary, type HookVerdict } from '../release/canary.ts';
import { RESULT_PREFIX } from '../release/hooks.ts';
import { fullyHealthy, pollProbe, readyzOnce, socketHealthy, type Probe } from '../release/health.ts';
import {
	DEFAULT_CONTROL_PLANE_PATHS,
	ensureControlPlaneUnits,
	socketPaths,
} from '../systemd/control-plane.ts';
import { hostPlatform, loadTrustedKeys, sha256File } from './signing.ts';
import { UPDATER_IDENTITY } from './version.ts';
import { consumeRequestedMethod } from './request.ts';
import { ensurePlatformConfigUnits } from '../platform-config/units.ts';
import { ensureBuilder, linkAgentCommands } from '../systemd/builder.ts';
import { ensureHelper } from '../systemd/helper.ts';
import { ensureCaddy } from '../systemd/caddy.ts';
import { ensureStorageUnits } from '../systemd/storage.ts';
import { R2ObjectStore } from '../../packages/core/src/object-store.ts';
import { listUpgradeSnapshotBundles } from '../../packages/core/src/upgrade-plan.ts';
import {
	AGENT,
	CONTROL_PLANE,
	type Host,
	type HookOutcome,
	type PublishedRelease,
	type SocketTarget,
	type CheckResult,
	type RollbackResult,
	type UpdateResult,
	RecoveryError,
	UpdateError,
	Updater,
	layoutFromEnv,
	readLink,
} from './updater.ts';

const USAGE = `skiff-update-self — update the Skiff control plane from GitHub, reversibly

Usage:
  skiff-update-self [update] [options]   install the newest signed release if it is newer (semver)
  skiff-update-self check [--json]       show the running and latest versions; change nothing
  skiff-update-self plan [--json]        preflight the upgrade (disk, backup target, migrations)
  skiff-update-self rollback [options]   switch back to the previous release (repeat to undo)
  skiff-update-self status [--json]      show current/previous releases, verdicts and the last switch
  skiff-update-self recover [--boot]     resolve an interrupted update (--boot: filesystem only, at boot)
  skiff-update-self self-test [--json]   qualify this updater binary (used before activating a new one)
  skiff-update-self version              print this updater's identity

update options:
  --source <mode>      auto (default): newest signed GitHub release, else build from source;
                       download: install the signed release (never build on the host);
                       build: compile --ref from source (never run a prebuilt binary).
                       artifact/source are accepted as aliases of download/build.
  --ref <ref>          build this branch, tag or sha from source (implies --source build)
  --repo <owner/name>  GitHub repository (default: from the current release, else KieranHolroyd/skiff)
  --force              install even if not newer (rebuild/downgrade), or retry a release that failed
  --trigger <who>      cli (default) or dashboard; recorded in the status the dashboard shows
  --no-agent           leave skiff-agent running its old binary (by default it restarts on the new
                       release, and back on rollback, so agent fixes take effect)
  --no-canary          skip the isolated pre-swap boot against a copy of the database
  --no-zero-downtime   stop the old release before starting the new one (no standby cutover)
  --bake <seconds>     how long the new release must serve traffic before commit (default 60)
  --require-public     the public URL must answer after the swap (default: only if it did before)
  --no-public-check    never gate on the public URL
  --allow-destructive  approve a reviewed destructive migration in the preflight
  --dry-run            resolve the release and print the plan; change nothing

rollback options:
  --restore-db         also restore the database snapshot taken when the current release was activated
  --keep-db            run the previous code against the current (possibly newer) schema
  --no-agent           do not restart skiff-agent on the previous release
  --dry-run            print the plan; change nothing

Environment:
  SKIFF_GITHUB_TOKEN   token for a private repository (or put it in /etc/skiff/github.token, 0600)
  SKIFF_REPO, SKIFF_REF  defaults for --repo / --ref
  SKIFF_UPDATE_SOURCE  default for --source (auto, download or build)
  SKIFF_UPDATER=source run the TypeScript updater from the current release instead of stage-0

Exit status: 0 updated / up to date / nothing to do, 1 nothing changed or rolled back to the old
release (it is serving), 2 the old release could not be brought back (act now), 64 usage error.
`;

const layout = layoutFromEnv();
const ETC_DIR = process.env.SKIFF_ETC_DIR ?? '/etc/skiff';
const RUN_DIR = process.env.SKIFF_RUN_DIR ?? '/run/skiff';
const ENV_FILE = join(ETC_DIR, 'skiff.env');
const AGENT_ENV_FILE = join(ETC_DIR, 'agent.env');
const MASTER_KEY_FILE = join(ETC_DIR, 'master.key');
const SOCKETS = socketPaths(RUN_DIR);
const UPDATE_COMMAND = '/usr/local/sbin/skiff-update-self';
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
	'--no-agent',
	'--no-canary',
	'--require-public',
	'--no-public-check',
	'--allow-destructive',
	'--dry-run',
	'--restore-db',
	'--keep-db',
	'--json',
	'--trigger',
	'--source',
	'--no-zero-downtime',
	'--bake',
	'--boot',
	'--version',
	'--help',
	'-h',
]);
const withValue = new Set(['--ref', '--repo', '--trigger', '--source', '--bake']);
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

const probeOptions = () => ({ origin: platformOrigin() ?? null });

/** Poll a boolean check (public URL probes). */
async function poll(check: () => Promise<boolean>, timeoutMs: number, everyMs = 1_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() + everyMs > deadline) return false;
		await Bun.sleep(everyMs);
	}
}

const socketFor = (target: SocketTarget) => (target === 'public' ? SOCKETS.public : target === 'primary' ? SOCKETS.primary : SOCKETS.standby);

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
	ensureUpdateCommand();
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
		// The active release, not this file's location: stage-0 runs as a compiled binary.
		const active = readLink(layout.currentLink);
		if (active) linkAgentCommands(active);
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

/** Keep /usr/local/sbin/skiff-update-self pointing at stage-0 with the source fallback. */
function ensureUpdateCommand(): void {
	const body = updateCommandScript({ optDir: layout.optDir, bunBin: layout.bunBin, updaterDir: layout.updaterDir });
	if (existsSync(UPDATE_COMMAND) && readFileSync(UPDATE_COMMAND, 'utf8') === body) return;
	mkdirSync(dirname(UPDATE_COMMAND), { recursive: true });
	writeFileSync(`${UPDATE_COMMAND}.tmp`, body, { mode: 0o755 });
	renameSync(`${UPDATE_COMMAND}.tmp`, UPDATE_COMMAND);
	host.log(`${UPDATE_COMMAND} now prefers the stage-0 updater`);
}

const SOURCE_ALIASES: Record<string, 'auto' | 'artifact' | 'source'> = {
	auto: 'auto',
	download: 'artifact',
	artifact: 'artifact',
	build: 'source',
	source: 'source'
};

function sourceOption(): 'auto' | 'artifact' | 'source' | undefined {
	const value = option('--source') ?? process.env.SKIFF_UPDATE_SOURCE;
	if (!value) return undefined;
	const mode = SOURCE_ALIASES[value];
	if (mode) return mode;
	usageError(`--source must be auto, download or build (got ${value})`);
}

/** `--source`/the environment wins over the dashboard's request, then the auto default. */
function resolveMethod(
	source: 'auto' | 'artifact' | 'source' | undefined,
	requested: SelfUpdateMethod | null
): SelfUpdateMethod {
	if (source === 'artifact') return 'download';
	if (source === 'source') return 'build';
	if (source === 'auto') return 'auto';
	return requested ?? 'auto';
}

/**
 * Qualification for a candidate stage-0 (run by the current stage-0 before it activates this
 * binary). Read-only: it must be able to read the machine's state, trust release keys, reach
 * the active release's hooks, and parse its own units. Exit 0 + `{"ok":true}` qualifies.
 */
async function selfTest(updater: Updater): Promise<number> {
	const failures: string[] = [];
	const checks: Record<string, string> = {};
	const attempt = async (name: string, fn: () => unknown | Promise<unknown>) => {
		try {
			const value = await fn();
			checks[name] = typeof value === 'string' ? value : 'ok';
		} catch (error) {
			failures.push(`${name}: ${(error as Error).message}`);
		}
	};
	await attempt('identity', () => UPDATER_IDENTITY);
	await attempt('state', () => {
		const status = updater.status();
		if (!status.current) throw new Error(`no active release at ${layout.currentLink}`);
		return status.current.meta.version ?? 'unversioned';
	});
	await attempt('keys', () => {
		const keys = loadTrustedKeys(join(ETC_DIR, 'updater', 'keys'));
		if (keys.size === 0) throw new Error('no release-signing keys');
		return `${keys.size} key(s)`;
	});
	await attempt('units', () => {
		const units = triggerUnits({ requestFile: REQUEST_FILE, command: UPDATE_COMMAND });
		if (Object.keys(units).length < 2) throw new Error('trigger units did not render');
	});
	await attempt('hooks', async () => {
		const current = readLink(layout.currentLink);
		if (!current) throw new Error('no active release');
		const outcome = await host.releaseHook!(current, 'protocol', [], 60_000);
		if (outcome.kind === 'error') throw new Error(outcome.reason);
		return outcome.kind === 'absent' ? 'release predates hooks' : `protocol ${outcome.verdict.protocol}`;
	});
	const report = { ok: failures.length === 0, identity: UPDATER_IDENTITY, checks, failures };
	if (flag('--json')) console.log(JSON.stringify(report));
	else {
		for (const [name, value] of Object.entries(checks)) console.log(`${dim('  •')} ${name}: ${value}`);
		for (const failure of failures) console.error(`${red('  !')} ${failure}`);
	}
	return report.ok ? 0 : 1;
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
		await runStreaming([bun, 'run', '--cwd', 'apps/helper', 'build'], { cwd: repoDir });
		// Stage-0 for this release (qualified and activated only after the release commits).
		await runStreaming(
			[bun, 'build', '--compile', 'scripts/update-self/main.ts', '--define', 'SKIFF_UPDATER_BUILD="host-build"', '--outfile', 'scripts/update-self/dist/skiff-updated'],
			{ cwd: repoDir },
		);
	},

	/**
	 * Fallback for releases that ship no canary hook: stage-0's bundled copy of the release canary
	 * (same code as `scripts/release/canary.ts`), run against that release.
	 */
	async canary(release, scratch) {
		const verdict = await runCanary({
			release,
			scratch,
			dbPath: layout.dbPath,
			envFile: ENV_FILE,
			masterKeyFile: MASTER_KEY_FILE,
			origin: platformOrigin() ?? null,
		});
		if (!verdict.ok) throw new UpdateError(`${verdict.reason ?? 'unhealthy'}${verdict.detail ? `\n${verdict.detail}` : ''}`);
	},

	/**
	 * Run a release-owned hook with the release's own Bun and a hard timeout. Output is streamed
	 * to the live log; the verdict is the last `SKIFF_HOOK_RESULT` line.
	 */
	async releaseHook(release, hook, args, timeoutMs): Promise<HookOutcome> {
		const script = join(release, 'repo', 'scripts', 'release', 'hooks.ts');
		if (!existsSync(script)) return { kind: 'absent' };
		const bun = existsSync(join(release, 'runtime', 'bun')) ? join(release, 'runtime', 'bun') : layout.bunBin;
		const origin = platformOrigin();
		const cmd = [bun, script, hook, ...args, ...(origin ? ['--origin', origin] : [])];
		appendLog('command', `$ ${cmd.join(' ')}`);
		const child = Bun.spawn({
			cmd,
			cwd: join(release, 'repo'),
			env: { ...process.env, SKIFF_ETC_DIR: ETC_DIR, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		let verdictLine: string | null = null;
		const consume = async (stream: ReadableStream<Uint8Array>, level: 'output' | 'error') => {
			const decoder = new TextDecoder();
			let pending = '';
			const emit = (line: string) => {
				if (line.startsWith(RESULT_PREFIX)) verdictLine = line.slice(RESULT_PREFIX.length);
				else if (line.trim()) appendLog(level, line);
			};
			for await (const chunk of stream) {
				pending += decoder.decode(chunk, { stream: true });
				const parts = pending.split(/\r?\n/);
				pending = parts.pop() ?? '';
				for (const part of parts) emit(part);
			}
			if (pending) emit(pending);
		};
		await Promise.all([consume(child.stdout, 'output'), consume(child.stderr, 'error')]);
		const code = await child.exited;
		clearTimeout(timer);
		if (child.signalCode === 'SIGKILL') return { kind: 'error', reason: `${hook} hook timed out after ${Math.round(timeoutMs / 1000)}s` };
		if (!verdictLine) return { kind: 'error', reason: `${hook} hook exited ${code} without a verdict` };
		try {
			const verdict = JSON.parse(verdictLine) as HookVerdict;
			if (typeof verdict.ok !== 'boolean' || typeof verdict.protocol !== 'number')
				return { kind: 'error', reason: `${hook} hook returned a malformed verdict` };
			return { kind: 'verdict', verdict };
		} catch {
			return { kind: 'error', reason: `${hook} hook returned an unparseable verdict` };
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
	ensureHelper(release) {
		ensureHelper({
			systemdDir: SYSTEMD_DIR,
			release,
			run: (cmd) => void run(cmd, { quiet: true, allowFailure: true }),
			log: (message) => appendLog('info', message),
			start: false,
		});
	},
	ensureCaddy(release) {
		return ensureCaddy({
			release,
			optDir: layout.optDir,
			run: (cmd, options) =>
				run(cmd, { quiet: true, allowFailure: options?.allowFailure }),
			log: (message) => appendLog('info', message),
		});
	},
	async isActive(unit) {
		return unitState(unit) === 'active';
	},
	async restartCount(unit) {
		return Number(run(['systemctl', 'show', '-p', 'NRestarts', '--value', unit], { quiet: true, allowFailure: true }).stdout) || 0;
	},
	controlPlaneHealthy: async (timeoutMs) => (await pollProbe(() => socketHealthy(SOCKETS.public, probeOptions()), timeoutMs)).ok,
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
	readyz: async (timeoutMs) => (await pollProbe(() => readyzOnce(SOCKETS.public, probeOptions()), timeoutMs)).ok,

	// ------------------------------------------------ signed releases (CI-built artifacts)
	async listReleases(repo): Promise<PublishedRelease[]> {
		const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
			headers: githubHeaders('application/vnd.github+json'),
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new UpdateError(`GitHub ${response.status} listing releases of ${repo}`);
		const body = (await response.json()) as {
			tag_name: string;
			draft: boolean;
			prerelease: boolean;
			assets: { name: string; browser_download_url: string; size: number }[];
		}[];
		return body.map((release) => ({
			tag: release.tag_name,
			draft: release.draft,
			prerelease: release.prerelease,
			assets: release.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size })),
		}));
	},
	async fetchBytes(url) {
		const response = await fetch(url, { headers: { 'User-Agent': 'skiff-update-self' }, signal: AbortSignal.timeout(30_000) });
		if (!response.ok) throw new UpdateError(`GET ${url} answered ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > 1024 * 1024) throw new UpdateError(`${url} is unexpectedly large`);
		return bytes;
	},
	async download(url, path) {
		const response = await fetch(url, { headers: { 'User-Agent': 'skiff-update-self' }, signal: AbortSignal.timeout(900_000) });
		if (!response.ok) throw new UpdateError(`GET ${url} answered ${response.status}`);
		await Bun.write(path, response);
	},
	async extract(archive, dest) {
		run(['tar', '-xzf', archive, '-C', dest, '--no-same-owner'], { quiet: true });
	},
	sha256: (path) => sha256File(path),
	trustedKeys: () => loadTrustedKeys(join(ETC_DIR, 'updater', 'keys')),
	platform: () => hostPlatform(),

	// --------------------------------------------------- zero-downtime cutover
	async probe(target, timeoutMs): Promise<Probe> {
		return pollProbe(() => fullyHealthy(socketFor(target), probeOptions()), timeoutMs);
	},
	pointControlSocket(target) {
		const tmp = `${SOCKETS.public}.tmp-${process.pid}`;
		rmSync(tmp, { force: true });
		symlinkSync(basename(target === 'primary' ? SOCKETS.primary : SOCKETS.standby), tmp);
		renameSync(tmp, SOCKETS.public);
		appendLog('info', `control.sock -> ${target}`);
	},
	controlSocketTarget() {
		try {
			const stat = lstatSync(SOCKETS.public);
			if (!stat.isSymbolicLink()) return 'legacy';
			const target = readlinkSync(SOCKETS.public);
			return target.endsWith('control-standby.sock') ? 'standby' : 'primary';
		} catch {
			return null;
		}
	},
	ensureControlPlaneUnits() {
		ensureControlPlaneUnits({
			systemdDir: SYSTEMD_DIR,
			paths: { ...DEFAULT_CONTROL_PLANE_PATHS, optDir: layout.optDir, runDir: RUN_DIR, envFile: ENV_FILE, masterKeyFile: MASTER_KEY_FILE },
			run: (cmd) => void run(cmd, { quiet: true, allowFailure: true }),
			log: (message) => host.log(message),
		});
	},

	// ------------------------------------------------------ stage-0 self-update
	async updaterIdentity(binary) {
		const result = Bun.spawnSync({ cmd: [binary, '--version'], stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
		if (result.exitCode !== 0) return null;
		const line = new TextDecoder().decode(result.stdout).trim().split('\n')[0] ?? '';
		return /^\d+\.\d+\.\d+\+\S+$/.test(line) ? line : null;
	},
	async qualifyUpdater(binary) {
		const result = Bun.spawnSync({ cmd: [binary, 'self-test', '--json'], stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
		const text = new TextDecoder().decode(result.stdout).trim();
		try {
			const report = JSON.parse(text.split('\n').pop() ?? '') as { ok?: boolean; failures?: string[] };
			if (result.exitCode === 0 && report.ok === true) return { ok: true };
			return { ok: false, reason: (report.failures ?? []).join('; ') || `exit ${result.exitCode}` };
		} catch {
			return { ok: false, reason: `self-test exited ${result.exitCode} without a report` };
		}
	},
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
	if (command === 'version' || flag('--version')) {
		console.log(UPDATER_IDENTITY);
		return 0;
	}
	const updater = new Updater(layout, host);

	if (command === 'self-test') return selfTest(updater);

	if (command === 'recover') {
		preflight();
		if (flag('--boot')) {
			// Boot guard: filesystem only, never touches units (it runs before the control plane).
			const outcome = await updater.bootRecover();
			console.log(`skiff-update-guard: ${outcome}`);
			return 0;
		}
		if (!updater.status().state.inProgress) {
			console.log('nothing to recover');
			return 0;
		}
		await updater.recover();
		console.log('recovered');
		return 0;
	}

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
			source: sourceOption(),
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
			ref: option('--ref') ?? process.env.SKIFF_REF,
			source: sourceOption()
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
		const method = resolveMethod(
			sourceOption(),
			consumeRequestedMethod(selfUpdateModeFile(REQUEST_FILE), trigger),
		);
		const source = updateSourceForMethod(method);
		if (!dryRun) {
			startUpdateLog(trigger);
			const now = new Date().toISOString();
			status = {
				running: true,
				trigger,
				method,
				phase: 'checking',
				message: 'Checking for a newer version',
				fromVersion: null,
				toVersion: null,
				startedAt: now,
				updatedAt: now,
			};
			writeStatusFile(status);
		}
		host.log(
			method === 'download'
				? 'Install method: download the signed release'
				: method === 'build'
					? `Install method: build ${option('--ref') ?? process.env.SKIFF_REF ?? 'the configured ref'} from source`
					: 'Install method: automatic (signed release when published, otherwise source)',
		);
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
			withAgent: !flag('--no-agent'),
			canary: !flag('--no-canary'),
			dryRun,
			publicCheck,
			allowDestructiveMigrations: flag('--allow-destructive'),
			source,
			zeroDowntime: !flag('--no-zero-downtime'),
			...(option('--bake') ? { bakeMs: Math.max(0, Number(option('--bake'))) * 1000 } : {}),
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
			withAgent: !flag('--no-agent'),
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
