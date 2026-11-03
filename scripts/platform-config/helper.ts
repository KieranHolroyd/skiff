/**
 * The root side of dashboard platform settings (docs/OPS.md §4.3). Everything that touches the
 * host goes through `Host`, so the flow is testable without root or systemd.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
	LITESTREAM_VERSION,
	PLATFORM_CONFIG_REQUIRED,
	applyPlatformConfig,
	parsePlatformConfigRequest,
	type PlatformConfigOutcome,
	type PlatformConfigRequest,
	type PlatformConfigStatus,
} from '../../packages/contracts/src/platform-config.ts';
import { readEnvFile, writeEnvFile } from '../install/env-file.ts';

export const CONTROL_PLANE = 'skiff-control-plane.service';
export const LITESTREAM_UNIT = 'skiff-litestream.service';
export const DRILL_SERVICE = 'skiff-restore-drill.service';
export const DRILL_TIMER = 'skiff-restore-drill.timer';
/** Same set the installer writes (scripts/install/main.ts BACKUP_UNITS). */
export const BACKUP_UNITS = [LITESTREAM_UNIT, DRILL_SERVICE, DRILL_TIMER, 'skiff-alert@.service'];
/** Same wrappers the installer writes (scripts/install/main.ts RELEASE_COMMANDS). */
export const RELEASE_COMMANDS: Array<{ name: string; script: string; runner: 'sh' | 'bun' }> = [
	{ name: 'skiff-restore', script: 'repo/scripts/restore.sh', runner: 'sh' },
	{ name: 'skiff-restore-drill', script: 'repo/scripts/skiff-restore-drill.sh', runner: 'sh' },
	{ name: 'skiff-alert', script: 'repo/scripts/skiff-alert.ts', runner: 'bun' },
];

/** sha256 of the upstream release tarballs, pinned so a compromised download cannot run as root. */
export const LITESTREAM_SHA256: Record<string, string> = {
	amd64: 'eb75a3de5cab03875cdae9f5f539e6aedadd66607003d9b1e7a9077948818ba0',
	arm64: '9585f5a508516bd66af2b2376bab4de256a5ef8e2b73ec760559e679628f2d59',
};

export function litestreamAsset(machine: string): { arch: string; url: string; sha256: string } | null {
	const arch = machine === 'x86_64' || machine === 'amd64' ? 'amd64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : null;
	if (!arch) return null;
	return {
		arch,
		url: `https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${arch}.tar.gz`,
		sha256: LITESTREAM_SHA256[arch]!,
	};
}

export interface Layout {
	envFile: string;
	systemdDir: string;
	sbinDir: string;
	optDir: string;
	/** The repo of the release this helper runs from (has scripts/litestream.yml, scripts/systemd/). */
	sourceDir: string;
	bunBin: string;
	litestreamBin: string;
	litestreamConfig: string;
	drillDir: string;
	requestFile: string;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface Host {
	run(cmd: string[], options?: { allowFailure?: boolean }): RunResult;
	log(message: string): void;
	sleep(ms: number): Promise<void>;
	download(url: string): Promise<Uint8Array>;
	/** The control plane answers on its unix socket. */
	controlPlaneHealthy(): Promise<boolean>;
	writeStatus(status: PlatformConfigStatus): void;
	/** Files the helper writes into /etc/skiff are root:skiff 0640. */
	chownRootSkiff(path: string): void;
}

export class RequestError extends Error {}

const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * Read and delete the request. The directory is writable by the (untrusted) control plane, so:
 * never follow a symlink, never block on a FIFO, only accept a small regular file that root does
 * not own, read through the opened descriptor, and never echo the content in an error.
 */
export function claimRequest(path: string): unknown | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === 'ENOENT') return null;
		try {
			unlinkSync(path);
		} catch {
			/* already gone */
		}
		throw new RequestError(code === 'ELOOP' ? 'the request is a symlink' : `cannot open the request (${code})`);
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) throw new RequestError('the request is not a regular file');
		if (info.uid === 0 && process.getuid?.() === 0) throw new RequestError('the request must be written by the control plane');
		if (info.size > MAX_REQUEST_BYTES) throw new RequestError('the request is too large');
		const buffer = Buffer.alloc(info.size);
		let read = 0;
		while (read < info.size) {
			const n = readSync(fd, buffer, read, info.size - read, read);
			if (n === 0) break;
			read += n;
		}
		try {
			return JSON.parse(buffer.subarray(0, read).toString('utf8'));
		} catch {
			throw new RequestError('the request is not valid JSON');
		}
	} finally {
		closeSync(fd);
		try {
			unlinkSync(path);
		} catch {
			/* already gone */
		}
	}
}

export class PlatformConfigHelper {
	private status: PlatformConfigStatus | null = null;

	constructor(
		private readonly layout: Layout,
		private readonly host: Host,
	) {}

	// ---------------------------------------------------------------- status

	private begin(request: PlatformConfigRequest): void {
		const now = new Date().toISOString();
		this.status = {
			requestId: request.id,
			action: request.action,
			section: request.action === 'configure' ? request.section : undefined,
			running: true,
			phase: 'applying',
			message: 'Applying settings',
			startedAt: now,
			updatedAt: now,
		};
		this.host.writeStatus(this.status);
	}

	private progress(patch: Partial<PlatformConfigStatus>): void {
		if (!this.status) return;
		this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
		this.host.writeStatus(this.status);
	}

	private finish(outcome: PlatformConfigOutcome, message: string, changed?: string[]): PlatformConfigStatus {
		this.progress({ running: false, phase: 'done', outcome, message, changed, finishedAt: new Date().toISOString() });
		return this.status!;
	}

	/** Entry point for the path-unit service. */
	async applyRequestFile(): Promise<PlatformConfigStatus | null> {
		let raw: unknown;
		try {
			raw = claimRequest(this.layout.requestFile);
		} catch (error) {
			return this.reject(null, (error as Error).message);
		}
		if (raw === null) return null;
		const parsed = parsePlatformConfigRequest(raw);
		if (!parsed.ok) {
			const id = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? (raw as { id: string }).id : null;
			return this.reject(id && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null, parsed.error);
		}
		return this.apply(parsed.request);
	}

	private reject(requestId: string | null, reason: string): PlatformConfigStatus {
		const now = new Date().toISOString();
		this.status = {
			requestId,
			action: 'configure',
			running: false,
			phase: 'done',
			outcome: 'rejected',
			message: `Request rejected: ${reason}.`,
			startedAt: now,
			updatedAt: now,
			finishedAt: now,
		};
		this.host.writeStatus(this.status);
		this.host.log(`rejected request: ${reason}`);
		return this.status;
	}

	async apply(request: PlatformConfigRequest): Promise<PlatformConfigStatus> {
		this.begin(request);
		try {
			switch (request.action) {
				case 'configure':
					return await this.configure(request);
				case 'backups':
					return request.enabled ? await this.enableBackupsFlow() : this.disableBackupsFlow();
				case 'restore-drill':
					return this.startDrill();
			}
		} catch (error) {
			return this.finish('error', (error as Error).message);
		}
	}

	// -------------------------------------------------------------- configure

	private async configure(request: Extract<PlatformConfigRequest, { action: 'configure' }>): Promise<PlatformConfigStatus> {
		const { envFile } = this.layout;
		const before = readEnvFile(envFile);
		const env = new Map(before);
		let changed: string[];
		try {
			changed = applyPlatformConfig(env, request);
		} catch (error) {
			return this.finish('rejected', `${capitalise((error as Error).message)}.`);
		}
		const r2Required = PLATFORM_CONFIG_REQUIRED.backups;
		const r2Complete = r2Required.every((key) => env.get(key));
		if (request.section === 'backups' && env.get('SKIFF_OBJECT_STORE') === 'r2' && !r2Complete)
			return this.finish('rejected', 'Release artifacts are stored in R2 (SKIFF_OBJECT_STORE=r2), so the R2 credentials cannot be removed.');
		if (changed.length === 0) return this.finish('unchanged', 'Nothing changed; the settings already match.', []);

		const previous = `${envFile}.previous`;
		copyFileSync(envFile, previous);
		this.host.chownRootSkiff(previous);
		writeEnvFile(envFile, env);
		this.host.chownRootSkiff(envFile);
		this.host.log(`updated ${changed.join(', ')} in ${envFile}`);

		let backupsNote = '';
		if (request.section === 'backups') {
			if (r2Complete) {
				// Saving credentials is how you turn backups on; it also picks up rotated keys.
				this.progress({ phase: 'installing', message: 'Setting up Litestream and the restore drill' });
				backupsNote = ` ${await this.enableBackups()}`;
			} else {
				this.disableBackups();
				backupsNote = ' Backups are off.';
			}
		}

		this.progress({ phase: 'restarting', message: 'Restarting the control plane with the new settings', changed });
		if (await this.restartControlPlane()) return this.finish('applied', `Saved.${backupsNote}`.trim(), changed);

		// The new settings broke the control plane: put the old file back and prove it recovers.
		this.host.log('control plane unhealthy with the new settings; reverting');
		renameSync(previous, envFile);
		if (request.section === 'backups') {
			if (r2Required.every((key) => before.get(key))) await this.enableBackups().catch(() => undefined);
			else this.disableBackups();
		}
		const recovered = await this.restartControlPlane();
		return this.finish(
			recovered ? 'reverted' : 'error',
			recovered
				? 'The control plane did not start with the new settings, so the previous settings were restored.'
				: `The control plane did not start with either the new or the previous settings. Check journalctl -u ${CONTROL_PLANE}.`,
			changed,
		);
	}

	private async restartControlPlane(): Promise<boolean> {
		this.host.run(['systemctl', 'restart', CONTROL_PLANE], { allowFailure: true });
		for (let waited = 0; waited < 60_000; waited += 1_000) {
			await this.host.sleep(1_000);
			if (await this.host.controlPlaneHealthy()) {
				// Stays up (no crash loop right after the first answer).
				await this.host.sleep(3_000);
				return this.host.controlPlaneHealthy();
			}
		}
		return false;
	}

	// ---------------------------------------------------------------- backups

	private async enableBackupsFlow(): Promise<PlatformConfigStatus> {
		const env = readEnvFile(this.layout.envFile);
		const missing = PLATFORM_CONFIG_REQUIRED.backups.filter((key) => !env.get(key));
		if (missing.length) return this.finish('rejected', `Save the R2 credentials first (missing ${missing.join(', ')}).`);
		this.progress({ phase: 'installing', message: 'Setting up Litestream and the restore drill' });
		return this.finish('applied', await this.enableBackups());
	}

	private disableBackupsFlow(): PlatformConfigStatus {
		this.disableBackups();
		return this.finish('applied', 'Backups are off. Litestream is stopped and the monthly restore drill is disabled; the R2 credentials are kept.');
	}

	disableBackups(): void {
		if (existsSync(join(this.layout.systemdDir, LITESTREAM_UNIT)))
			this.host.run(['systemctl', 'disable', '--now', LITESTREAM_UNIT, DRILL_TIMER], { allowFailure: true });
	}

	/** Install Litestream (pinned) if needed, the config, units and wrappers; enable and verify. */
	async enableBackups(): Promise<string> {
		const { layout, host } = this;
		const litestream = await this.ensureLitestream();
		this.ensureSqlite3();
		this.ensureLitestreamConfig();
		for (const name of BACKUP_UNITS) {
			let body = readFileSync(join(layout.sourceDir, 'scripts', 'systemd', name), 'utf8');
			if (litestream !== '/usr/local/bin/litestream') body = body.replaceAll('/usr/local/bin/litestream', litestream);
			writeFileSync(join(layout.systemdDir, name), body, { mode: 0o644 });
		}
		this.installReleaseCommands();
		mkdirSync(layout.drillDir, { recursive: true, mode: 0o755 });
		host.run(['systemctl', 'daemon-reload']);
		host.run(['systemctl', 'enable', LITESTREAM_UNIT, DRILL_TIMER]);
		host.run(['systemctl', 'restart', LITESTREAM_UNIT], { allowFailure: true });
		host.run(['systemctl', 'start', DRILL_TIMER], { allowFailure: true });
		// Litestream exits quickly on bad credentials or an unreachable bucket.
		await host.sleep(5_000);
		const active = host.run(['systemctl', 'is-active', LITESTREAM_UNIT], { allowFailure: true }).stdout.trim();
		if (active !== 'active')
			throw new Error(`Litestream did not stay running (${active || 'unknown'}). Check the R2 credentials and bucket, then journalctl -u ${LITESTREAM_UNIT}.`);
		return 'Backups are on: Litestream is replicating to R2 and the monthly restore drill is scheduled.';
	}

	private async ensureLitestream(): Promise<string> {
		const { layout, host } = this;
		if (existsSync(layout.litestreamBin)) return layout.litestreamBin;
		const found = host.run(['sh', '-c', 'command -v litestream'], { allowFailure: true }).stdout.trim();
		if (found) return found;
		const machine = host.run(['uname', '-m']).stdout.trim();
		const asset = litestreamAsset(machine);
		if (!asset) throw new Error(`No pinned Litestream build for ${machine}. Install Litestream ${LITESTREAM_VERSION} at ${layout.litestreamBin} and try again.`);
		host.log(`downloading Litestream ${LITESTREAM_VERSION} (${asset.arch})`);
		const archive = await host.download(asset.url);
		const digest = createHash('sha256').update(archive).digest('hex');
		if (digest !== asset.sha256) throw new Error(`The Litestream download did not match its pinned checksum (got ${digest.slice(0, 16)}…); nothing was installed.`);
		const work = join(dirname(layout.litestreamBin), `.litestream-${process.pid}`);
		mkdirSync(work, { recursive: true, mode: 0o700 });
		try {
			writeFileSync(join(work, 'litestream.tar.gz'), archive, { mode: 0o600 });
			host.run(['tar', '-xzf', join(work, 'litestream.tar.gz'), '-C', work, '--no-same-owner', 'litestream']);
			host.run(['install', '-m', '0755', '-o', 'root', '-g', 'root', join(work, 'litestream'), layout.litestreamBin]);
		} finally {
			host.run(['rm', '-rf', work], { allowFailure: true });
		}
		host.log(`installed ${layout.litestreamBin}`);
		return layout.litestreamBin;
	}

	private ensureSqlite3(): void {
		const { host } = this;
		if (host.run(['sh', '-c', 'command -v sqlite3'], { allowFailure: true }).stdout.trim()) return;
		if (!host.run(['sh', '-c', 'command -v apt-get'], { allowFailure: true }).stdout.trim()) {
			host.log('warning: sqlite3 is not installed; skiff-restore and the restore drill need it');
			return;
		}
		host.run(['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--no-install-recommends', 'sqlite3'], { allowFailure: true });
	}

	/** Write litestream.yml when missing or still on the pre-R2_* variable names; keep operator edits otherwise. */
	private ensureLitestreamConfig(): void {
		const target = this.layout.litestreamConfig;
		const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
		if (current !== null && current.includes('${R2_BUCKET}')) return;
		if (current !== null) copyFileSync(target, `${target}.bak`);
		copyFileSync(join(this.layout.sourceDir, 'scripts', 'litestream.yml'), `${target}.tmp`);
		this.host.chownRootSkiff(`${target}.tmp`);
		renameSync(`${target}.tmp`, target);
	}

	private installReleaseCommands(): void {
		const { optDir, sbinDir, bunBin } = this.layout;
		for (const command of RELEASE_COMMANDS) {
			const path = join(sbinDir, command.name);
			const exec = command.runner === 'sh' ? `/bin/sh "$release/${command.script}"` : `${bunBin} "$release/${command.script}"`;
			const script = `#!/bin/sh
# Installed by Skiff: runs ${command.script} from the active Skiff release.
for release in ${optDir}/current ${optDir}/previous; do
	if [ -f "$release/${command.script}" ]; then
		exec ${exec} "$@"
	fi
done
echo "${basename(path)}: no release under ${optDir} ships ${command.script}; re-run the installer" >&2
exit 1
`;
			mkdirSync(sbinDir, { recursive: true });
			writeFileSync(`${path}.tmp`, script, { mode: 0o755 });
			renameSync(`${path}.tmp`, path);
		}
	}

	// ------------------------------------------------------------------ drill

	private startDrill(): PlatformConfigStatus {
		if (!existsSync(join(this.layout.systemdDir, DRILL_SERVICE)))
			return this.finish('rejected', 'Backups are not set up on this host yet, so there is nothing to drill.');
		const active = this.host.run(['systemctl', 'is-active', DRILL_SERVICE], { allowFailure: true }).stdout.trim();
		if (active === 'activating' || active === 'active') return this.finish('unchanged', 'A restore drill is already running.');
		this.host.run(['systemctl', 'start', '--no-block', DRILL_SERVICE]);
		return this.finish(
			'applied',
			'Restore drill started. The control plane pauses for a few seconds while the database is compared; the result appears here when it finishes.',
		);
	}
}

function capitalise(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
