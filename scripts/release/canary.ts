/**
 * Release-owned canary: boot *this* release in isolation against a copy of the live database.
 *
 * This file ships inside every release and is run by the stage-0 updater through `hooks.ts`
 * with the release's own Bun. Everything that encodes Skiff's data layout (which directories the
 * control plane needs, who must own them, which environment overrides make a copy harmless)
 * lives here, so a bug in it can only fail the release that contains it. The next release
 * ships its own fixed copy. Stage-0 only provides an empty scratch directory and reads the verdict.
 */
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formatEnvFile, readEnvFile } from '../install/env-file.ts';
import { fullyHealthy, pollProbe, type Probe } from './health.ts';

export const HOOK_PROTOCOL = 1;

/** What a hook reports. `ok:false` with a well-formed verdict is the *release's* fault. */
export interface HookVerdict {
	protocol: number;
	ok: boolean;
	/** Which step decided the verdict (prepare, boot, health, stability). */
	step: string;
	/** One line for the dashboard. */
	reason?: string;
	/** Longer diagnostics (journal tail). */
	detail?: string;
	/** `protocol` only: the hooks this release implements (absent: just `canary`). */
	hooks?: string[];
	/** `prepare`/`converge` only: steps that changed the host, and steps that failed. */
	changed?: string[];
	warnings?: string[];
}

export interface CanaryInput {
	release: string;
	/** Empty directory owned by root; the canary may create anything inside it. */
	scratch: string;
	/** Live control database to copy (never opened for writing). */
	dbPath: string;
	envFile: string;
	masterKeyFile: string;
	origin?: string | null;
	bootTimeoutMs?: number;
}

/** The directories the control plane writes to below SKIFF_DATA_DIR. Keep in step with /readyz. */
export const DATA_SUBDIRS = ['objects'] as const;

type Run = (cmd: string[]) => { code: number; stdout: string; stderr: string };

const defaultRun: Run = (cmd) => {
	const result = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
	return {
		code: result.exitCode ?? 1,
		stdout: new TextDecoder().decode(result.stdout).trim(),
		stderr: new TextDecoder().decode(result.stderr).trim(),
	};
};

/**
 * Lay out the scratch data dir. All directories exist *before* ownership is handed to skiff:
 * the canary runs as skiff, so anything created afterwards by root is unwritable to it.
 */
export function prepareScratch(input: Pick<CanaryInput, 'scratch' | 'dbPath'>, run: Run = defaultRun): void {
	const data = join(input.scratch, 'data');
	for (const sub of DATA_SUBDIRS) mkdirSync(join(data, sub), { recursive: true });
	if (existsSync(input.dbPath)) {
		const db = new Database(input.dbPath, { readonly: true });
		try {
			db.run('PRAGMA busy_timeout = 10000');
			db.run('VACUUM INTO ?', [join(data, 'skiff.db')]);
		} finally {
			db.close();
		}
	}
	const chown = run(['chown', '-R', 'skiff:skiff', input.scratch]);
	if (chown.code !== 0) throw new Error(`chown ${input.scratch}: ${chown.stderr || `exit ${chown.code}`}`);
}

/** Environment for the copy: same config, but no outbound side effects and its own paths. */
export function canaryEnvironment(base: Map<string, string>, input: { scratch: string; unit: string }): Map<string, string> {
	const env = new Map(base);
	for (const key of [...env.keys()]) if (/^(SKIFF_SMTP_|SKIFF_ALERT_|SKIFF_TWILIO_|R2_|SKIFF_R2_)/.test(key)) env.delete(key);
	env.set('SKIFF_OBJECT_STORE', 'local');
	env.set('SKIFF_DAILY_BACKUPS', '0');
	env.set('SKIFF_DATA_DIR', join(input.scratch, 'data'));
	env.set('SKIFF_MASTER_KEY_FILE', `/run/credentials/${input.unit}.service/master-key`);
	env.set('SOCKET_PATH', join(input.scratch, 'control.sock'));
	env.set('NODE_ENV', 'production');
	env.set('PROTOCOL_HEADER', 'x-forwarded-proto');
	env.set('HOST_HEADER', 'x-forwarded-host');
	// A canary must never run singleton background work against the copy's view of the world.
	env.set('SKIFF_STANDBY', '1');
	// The sandbox makes $HOME read-only; do not let Bun try to write its transpiler cache there.
	env.set('BUN_RUNTIME_TRANSPILER_CACHE_PATH', '0');
	return env;
}

/**
 * Transient unit with the production identity and sandbox, but its own socket and data dir.
 * The environment goes in a file (not --setenv) so secrets stay off the command line, and every
 * override is in that one file: with EnvironmentFile= and Environment= both set, the file wins.
 */
export async function runCanary(input: CanaryInput, run: Run = defaultRun): Promise<HookVerdict> {
	const verdict = (ok: boolean, step: string, reason?: string, detail?: string): HookVerdict => ({
		protocol: HOOK_PROTOCOL,
		ok,
		step,
		...(reason ? { reason } : {}),
		...(detail ? { detail } : {}),
	});
	try {
		prepareScratch(input, run);
	} catch (error) {
		return verdict(false, 'prepare', `could not prepare the canary data dir: ${(error as Error).message}`);
	}

	const unit = `skiff-update-canary-${randomBytes(4).toString('hex')}`;
	const socket = join(input.scratch, 'control.sock');
	const env = canaryEnvironment(readEnvFile(input.envFile), { scratch: input.scratch, unit });
	const envFile = join(dirname(input.scratch), `${unit}.env`);
	writeFileSync(envFile, formatEnvFile(env, false), { mode: 0o600 });
	const props = [
		'User=skiff',
		'Group=skiff',
		'UMask=0007',
		`EnvironmentFile=${envFile}`,
		`LoadCredential=master-key:${input.masterKeyFile}`,
		`WorkingDirectory=${input.release}/repo/apps/control-plane`,
		'NoNewPrivileges=yes',
		'PrivateTmp=yes',
		'PrivateDevices=yes',
		'ProtectSystem=strict',
		'ProtectHome=yes',
		`ReadWritePaths=${input.scratch}`,
		'MemoryMax=768M',
		'RuntimeMaxSec=180',
	];
	const unitState = () => run(['systemctl', 'is-active', unit]).stdout;
	let probe: Probe = { ok: false, reason: 'not started' };
	let step = 'boot';
	try {
		const started = run([
			'systemd-run',
			`--unit=${unit}`,
			'--quiet',
			'--collect',
			...props.map((p) => `--property=${p}`),
			'--',
			`${input.release}/runtime/bun`,
			`${input.release}/repo/apps/control-plane/build/index.js`,
		]);
		if (started.code !== 0) return verdict(false, 'boot', `systemd-run failed: ${started.stderr || started.code}`);
		step = 'health';
		probe = await pollProbe(async () => {
			const state = unitState();
			if (state !== 'active' && state !== 'activating')
				return { ok: false, fatal: true, reason: `the canary process exited (${state || 'gone'})` };
			return fullyHealthy(socket, { origin: input.origin });
		}, input.bootTimeoutMs ?? 90_000);
		if (probe.ok) {
			step = 'stability';
			await Bun.sleep(3_000);
			probe =
				unitState() === 'active'
					? await fullyHealthy(socket, { origin: input.origin })
					: { ok: false, reason: 'the canary crashed after becoming healthy' };
		}
	} finally {
		run(['systemctl', 'stop', unit]);
		rmSync(envFile, { force: true });
	}
	if (probe.ok) return verdict(true, step);
	const logs = run(['journalctl', '-u', unit, '-n', '60', '--no-pager', '-o', 'cat']).stdout;
	const cause = firstErrorLine(logs);
	return verdict(false, step, `${probe.reason ?? 'unhealthy'}${cause ? `: ${cause}` : ''}`, logs);
}

/** The line in a crash log that names the problem (e.g. "ENOENT: no such file ..."). */
export function firstErrorLine(logs: string): string | null {
	for (const raw of logs.split('\n')) {
		const line = raw.trim();
		if (/^(error|[A-Z][A-Za-z]*Error|E[A-Z]{3,}):/.test(line) || /^Error\b/.test(line)) return line.slice(0, 300);
	}
	return null;
}
