/**
 * The root side of dashboard platform settings (docs/OPS.md §4.3). Everything that touches the
 * host goes through `Host`, so the flow is testable without root or systemd.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
	LITESTREAM_VERSION,
	PLATFORM_CONFIG_REQUIRED,
	TELEMETRY_MEMORY_ENV,
	TELEMETRY_MEMORY_MB,
	applyPlatformConfig,
	parsePlatformConfigRequest,
	type PlatformConfigOutcome,
	type PlatformConfigRequest,
	type PlatformConfigStatus,
} from '../../packages/contracts/src/platform-config.ts';
import {
	CLOUDFLARE_TOKEN_FILE,
	applyEnvChanges,
	controlPlaneEnvChanges,
	edgeAgentEnvChanges,
	platformOriginFor,
	validateDomainSettings,
} from '../../packages/contracts/src/platform-domains.ts';
import { VAPID_PRIVATE_KEY_ENV, VAPID_PUBLIC_KEY_ENV, ensureVapidKeys } from '../../packages/contracts/src/vapid.ts';
import { readEnvFile, writeEnvFile } from '../install/env-file.ts';
import { CLICKHOUSE_PATHS, clickhouseInstalled, ensureClickHouse, restartClickHouse, uninstallClickHouse } from '../systemd/clickhouse.ts';

export const CONTROL_PLANE = 'yoal-control-plane.service';
export const AGENT = 'yoal-agent.service';
export const LITESTREAM_UNIT = 'yoal-litestream.service';
export const DRILL_SERVICE = 'yoal-restore-drill.service';
export const DRILL_TIMER = 'yoal-restore-drill.timer';
/** Same set the installer writes (scripts/install/main.ts BACKUP_UNITS). */
export const BACKUP_UNITS = [LITESTREAM_UNIT, DRILL_SERVICE, DRILL_TIMER, 'yoal-alert@.service'];
/** Same wrappers the installer writes (scripts/install/main.ts RELEASE_COMMANDS). */
export const RELEASE_COMMANDS: Array<{ name: string; script: string; runner: 'sh' | 'bun' }> = [
	{ name: 'yoal-restore', script: 'repo/scripts/restore.sh', runner: 'sh' },
	{ name: 'yoal-restore-drill', script: 'repo/scripts/yoal-restore-drill.sh', runner: 'sh' },
	{ name: 'yoal-alert', script: 'repo/scripts/yoal-alert.ts', runner: 'bun' },
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
	/** The optional telemetry store (D101); defaults to CLICKHOUSE_PATHS.dataDir. */
	clickhouseDataDir?: string;
	/** The edge agent's env (D105 domain changes rewrite it); absent on control-plane-only installs. */
	agentEnvFile?: string;
	/** Where a Cloudflare DNS-01 token from the dashboard is written (root:yoal 0640). */
	cloudflareTokenFile?: string;
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
	/**
	 * The platform answers at `origin` through Caddy on this host (resolved to loopback, so it
	 * does not depend on public DNS; with HTTPS the certificate must be valid).
	 */
	platformAnswers(origin: string): Promise<boolean>;
	writeStatus(status: PlatformConfigStatus): void;
	/** Files the helper writes into /etc/yoal are root:yoal 0640. */
	chownRootYoal(path: string): void;
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
				case 'telemetry':
					return request.enabled ? await this.installTelemetryFlow() : await this.removeTelemetryFlow(request.purgeData);
				case 'telemetry-memory':
					return await this.telemetryMemoryFlow(request.memoryMb);
				case 'telemetry-restart':
					return await this.restartTelemetryFlow();
				case 'domains':
					return await this.domains(request);
				case 'push-keys':
					return await this.pushKeys();
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
		if (request.section === 'backups' && env.get('YOAL_OBJECT_STORE') === 'r2' && !r2Complete)
			return this.finish('rejected', 'Release artifacts are stored in R2 (YOAL_OBJECT_STORE=r2), so the R2 credentials cannot be removed.');
		if (changed.length === 0) return this.finish('unchanged', 'Nothing changed; the settings already match.', []);

		const previous = `${envFile}.previous`;
		copyFileSync(envFile, previous);
		this.host.chownRootYoal(previous);
		writeEnvFile(envFile, env);
		this.host.chownRootYoal(envFile);
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

	// ---------------------------------------------------------------- domains

	/**
	 * Change the dashboard host, the content domain and HTTPS (D105). Both env files are rewritten
	 * together, both services restart, and the new address must answer through Caddy on this host
	 * (with a valid certificate when HTTPS is on) or everything is put back.
	 */
	private async domains(request: Extract<PlatformConfigRequest, { action: 'domains' }>): Promise<PlatformConfigStatus> {
		const { envFile } = this.layout;
		const agentEnvFile = this.layout.agentEnvFile && existsSync(this.layout.agentEnvFile) ? this.layout.agentEnvFile : null;
		const controlBefore = readEnvFile(envFile);
		const tokenFile =
			[controlBefore.get('YOAL_CLOUDFLARE_TOKEN_FILE'), this.layout.cloudflareTokenFile ?? CLOUDFLARE_TOKEN_FILE].find(
				(path): path is string => Boolean(path),
			)!;
		const tokenExists = existsSync(tokenFile);
		const settings = validateDomainSettings(request, Boolean(request.cloudflareToken) || tokenExists);
		if (!settings.ok) return this.finish('rejected', settings.message);
		const next = settings.value;
		const keepToken = request.cloudflareToken || tokenExists ? tokenFile : null;

		const control = new Map(controlBefore);
		const changed = applyEnvChanges(control, controlPlaneEnvChanges(next, keepToken));
		const agentBefore = agentEnvFile ? readEnvFile(agentEnvFile) : null;
		const agent = agentBefore ? new Map(agentBefore) : null;
		if (agent) changed.push(...applyEnvChanges(agent, edgeAgentEnvChanges(next, keepToken)).map((key) => `agent:${key}`));
		const tokenBefore = tokenExists ? readFileSync(tokenFile, 'utf8').trim() : null;
		const tokenChanged = Boolean(request.cloudflareToken) && request.cloudflareToken !== tokenBefore;
		if (tokenChanged) changed.push('cloudflare-token');
		if (changed.length === 0) return this.finish('unchanged', 'Nothing changed; the domains already match.', []);

		const oldOrigin = controlBefore.get('YOAL_PLATFORM_ORIGIN') ?? '';
		const newOrigin = platformOriginFor(next);
		const backups: Array<[string, string]> = [[envFile, `${envFile}.previous`]];
		if (agentEnvFile) backups.push([agentEnvFile, `${agentEnvFile}.previous`]);
		if (tokenChanged && tokenBefore !== null) backups.push([tokenFile, `${tokenFile}.previous`]);
		for (const [file, copy] of backups) copyFileSync(file, copy);
		this.host.chownRootYoal(`${envFile}.previous`);

		if (tokenChanged) {
			mkdirSync(dirname(tokenFile), { recursive: true });
			writeFileSync(`${tokenFile}.tmp`, `${request.cloudflareToken}
`, { mode: 0o640 });
			renameSync(`${tokenFile}.tmp`, tokenFile);
			// The agent (user yoal) reads it and hands it to Caddy.
			this.host.chownRootYoal(tokenFile);
		}
		writeEnvFile(envFile, control);
		this.host.chownRootYoal(envFile);
		if (agentEnvFile && agent) writeEnvFile(agentEnvFile, agent);
		this.host.log(`domains: ${oldOrigin || '(none)'} → ${newOrigin}, content ${next.contentDomain}`);

		this.progress({ phase: 'restarting', message: `Moving the platform to ${newOrigin}`, changed });
		const verified = (await this.restartControlPlane()) && (await this.restartAgentAndVerify(newOrigin, next.tls, Boolean(agentEnvFile)));
		if (verified)
			return this.finish(
				'applied',
				`Yoal is now at ${newOrigin} and sites at *.${next.contentDomain}. Sign in again at the new address.`,
				changed,
			);

		this.host.log(`domains: ${newOrigin} did not answer; reverting`);
		this.progress({ phase: 'restarting', message: `${newOrigin} did not answer; restoring the previous domains` });
		for (const [file, copy] of backups) renameSync(copy, file);
		if (tokenChanged && tokenBefore === null) rmSync(tokenFile, { force: true });
		const recovered = (await this.restartControlPlane()) && (await this.restartAgentAndVerify(oldOrigin, oldOrigin.startsWith('https:'), Boolean(agentEnvFile)));
		const why = next.tls
			? `${newOrigin} did not answer with a valid certificate. Check that the DNS records point at this server and that the Cloudflare token can edit DNS for ${next.contentDomain}.`
			: `${newOrigin} did not answer. Check that the name points at this server.`;
		return this.finish(
			recovered ? 'reverted' : 'error',
			recovered
				? `${why} The previous domains were restored.`
				: `${why} The previous domains were restored, but ${oldOrigin} is not answering either. Check journalctl -u ${CONTROL_PLANE} -u ${AGENT}.`,
			changed,
		);
	}

	/** Restart the edge agent (it reconfigures Caddy) and wait for `origin` to answer through Caddy. */
	private async restartAgentAndVerify(origin: string, tls: boolean, hasAgent: boolean): Promise<boolean> {
		if (!hasAgent) return true; // control-plane-only install: no Caddy on this host to check
		this.host.run(['systemctl', 'restart', AGENT], { allowFailure: true });
		// Certificates can take a couple of minutes to issue over DNS-01.
		const deadline = tls ? 240_000 : 90_000;
		for (let waited = 0; waited < deadline; waited += 3_000) {
			await this.host.sleep(3_000);
			if (await this.host.platformAnswers(origin)) return true;
		}
		return false;
	}

	// ------------------------------------------------------------- push keys

	/**
	 * Web Push VAPID keys (D108) for a host updated by an updater that predates them. Adds a pair
	 * only when there is no valid one, then restarts the control plane so it picks them up (the
	 * dashboard only asks when its own process has none). Reverts if it does not come back.
	 */
	private async pushKeys(): Promise<PlatformConfigStatus> {
		const { envFile } = this.layout;
		const env = readEnvFile(envFile);
		const added = ensureVapidKeys(env);
		const previous = `${envFile}.previous`;
		if (added) {
			copyFileSync(envFile, previous);
			this.host.chownRootYoal(previous);
			writeEnvFile(envFile, env);
			this.host.chownRootYoal(envFile);
			this.host.log(`added ${VAPID_PUBLIC_KEY_ENV} and ${VAPID_PRIVATE_KEY_ENV} to ${envFile}`);
		}
		const changed = added ? [VAPID_PUBLIC_KEY_ENV, VAPID_PRIVATE_KEY_ENV] : [];
		this.progress({ phase: 'restarting', message: 'Restarting the control plane with the push keys', changed });
		if (await this.restartControlPlane())
			return this.finish('applied', added ? 'Push notifications are set up.' : 'The push keys were already there; the control plane now uses them.', changed);
		if (!added) return this.finish('error', `The control plane did not come back after a restart. Check journalctl -u ${CONTROL_PLANE}.`, changed);
		renameSync(previous, envFile);
		const recovered = await this.restartControlPlane();
		return this.finish(
			recovered ? 'reverted' : 'error',
			recovered
				? 'The control plane did not start with the push keys, so they were removed again.'
				: `The control plane did not start with or without the push keys. Check journalctl -u ${CONTROL_PLANE}.`,
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

	// -------------------------------------------------------------- telemetry

	private clickhousePaths() {
		const { layout } = this;
		return {
			envFile: layout.envFile,
			systemdDir: layout.systemdDir,
			installRoot: join(layout.optDir, 'clickhouse'),
			configDir: join(dirname(layout.envFile), 'clickhouse'),
			dataDir: layout.clickhouseDataDir ?? CLICKHOUSE_PATHS.dataDir,
		};
	}

	private ensureClickHouse() {
		const { host } = this;
		return ensureClickHouse({
			...this.clickhousePaths(),
			run: (cmd) => void host.run(cmd),
			capture: (cmd) => {
				const out = host.run(cmd, { allowFailure: true });
				return out.code === 0 ? out.stdout : null;
			},
			sleep: (ms) => host.sleep(ms),
			log: (message) => host.log(message),
		});
	}

	/** Download, configure and start ClickHouse, then restart the control plane to pick it up. */
	private async installTelemetryFlow(): Promise<PlatformConfigStatus> {
		this.progress({ phase: 'installing', message: 'Downloading and starting ClickHouse (about 240 MB; this can take a few minutes)' });
		const result = await this.ensureClickHouse();
		if (!result.ok) return this.finish('error', `ClickHouse could not be installed: ${result.warning ?? 'it did not start'}. See journalctl -u yoal-clickhouse.`);
		this.progress({ phase: 'restarting', message: 'Restarting the control plane to connect to ClickHouse' });
		if (await this.restartControlPlane())
			return this.finish('applied', 'The telemetry store is installed. Traffic charts and dashboards fill in as agents report (about a minute).', result.envAdded);
		return this.finish('error', 'ClickHouse is running, but the control plane did not come back after the restart. Check journalctl -u yoal-control-plane.', result.envAdded);
	}

	/**
	 * Write the memory ceiling to yoal.env, regenerate config.xml, users.xml and the unit, and
	 * restart ClickHouse. If it does not answer, the previous env file is put back and applied again.
	 * The control plane does not read this setting, so it is not restarted.
	 */
	private async telemetryMemoryFlow(memoryMb: number | null): Promise<PlatformConfigStatus> {
		const paths = this.clickhousePaths();
		if (!clickhouseInstalled(paths.systemdDir)) return this.finish('rejected', 'The telemetry store is not installed. Install it first.');
		const { envFile } = paths;
		const before = readEnvFile(envFile);
		const current = before.get(TELEMETRY_MEMORY_ENV) ?? null;
		const next = memoryMb === null ? null : String(memoryMb);
		const label = `${memoryMb ?? TELEMETRY_MEMORY_MB.default} MiB${memoryMb === null ? ' (the default)' : ''}`;
		const env = new Map(before);
		if (next === null) env.delete(TELEMETRY_MEMORY_ENV);
		else env.set(TELEMETRY_MEMORY_ENV, next);

		const changed = current === next ? [] : [TELEMETRY_MEMORY_ENV];
		const previous = `${envFile}.previous`;
		if (changed.length) {
			copyFileSync(envFile, previous);
			this.host.chownRootYoal(previous);
			writeEnvFile(envFile, env);
			this.host.chownRootYoal(envFile);
			this.host.log(`set ${TELEMETRY_MEMORY_ENV}=${next ?? '(default)'} in ${envFile}`);
		}
		this.progress({ phase: 'restarting', message: `Restarting ClickHouse with a ${label} memory ceiling`, changed });
		// Applies whatever the env file says; restarts only when the generated files changed.
		const result = await this.ensureClickHouse();
		if (result.ok) {
			const note = result.changed ? '' : ' Its configuration already matched, so it was not restarted.';
			return this.finish(changed.length || result.changed ? 'applied' : 'unchanged', `ClickHouse now runs with a ${label} memory ceiling.${note}`, changed);
		}
		if (!changed.length) return this.finish('error', `ClickHouse did not come back: ${result.warning ?? 'it did not start'}.`, changed);

		this.host.log(`ClickHouse did not come up with ${TELEMETRY_MEMORY_ENV}=${next ?? '(default)'}; reverting`);
		this.progress({ phase: 'restarting', message: 'ClickHouse did not come back; restoring the previous memory ceiling' });
		renameSync(previous, envFile);
		const recovered = (await this.ensureClickHouse()).ok;
		return this.finish(
			recovered ? 'reverted' : 'error',
			recovered
				? `ClickHouse did not start with a ${label} ceiling (${result.warning ?? 'no answer'}), so the previous setting was restored.`
				: `ClickHouse did not start with the new or the previous memory ceiling. Check journalctl -u yoal-clickhouse.`,
			changed,
		);
	}

	/** Restart ClickHouse as configured (e.g. after it ran out of memory or exhausted its restarts). */
	private async restartTelemetryFlow(): Promise<PlatformConfigStatus> {
		const paths = this.clickhousePaths();
		if (!clickhouseInstalled(paths.systemdDir)) return this.finish('rejected', 'The telemetry store is not installed.');
		this.progress({ phase: 'restarting', message: 'Restarting ClickHouse' });
		const result = await restartClickHouse({
			envFile: paths.envFile,
			systemdDir: paths.systemdDir,
			run: (cmd) => void this.host.run(cmd),
			capture: (cmd) => {
				const out = this.host.run(cmd, { allowFailure: true });
				return out.code === 0 ? out.stdout : null;
			},
			sleep: (ms) => this.host.sleep(ms),
			log: (message) => this.host.log(message),
		});
		if (result.ok) return this.finish('applied', 'ClickHouse restarted and is answering.', []);
		return this.finish('error', `ClickHouse did not come back: ${result.warning}.`, []);
	}

	/** Stop and remove ClickHouse (data only when asked), then restart the control plane without it. */
	private async removeTelemetryFlow(purgeData: boolean): Promise<PlatformConfigStatus> {
		const paths = this.clickhousePaths();
		const envHas = [...readEnvFile(paths.envFile).keys()].some((key) => key.startsWith('YOAL_CLICKHOUSE_'));
		if (!clickhouseInstalled(paths.systemdDir) && !envHas && !purgeData)
			return this.finish('unchanged', 'The telemetry store is not installed.');
		this.progress({ phase: 'applying', message: purgeData ? 'Removing ClickHouse and its data' : 'Removing ClickHouse' });
		const removed = uninstallClickHouse({
			...paths,
			purgeData,
			run: (cmd) => void this.host.run(cmd, { allowFailure: true }),
			log: (message) => this.host.log(message),
		});
		this.progress({ phase: 'restarting', message: 'Restarting the control plane' });
		const kept = purgeData ? '' : ` Stored telemetry is kept in ${paths.dataDir} for a reinstall.`;
		if (await this.restartControlPlane()) return this.finish('applied', `The telemetry store is removed.${kept}`, removed);
		return this.finish('error', 'ClickHouse is removed, but the control plane did not come back after the restart. Check journalctl -u yoal-control-plane.', removed);
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
			host.log('warning: sqlite3 is not installed; yoal-restore and the restore drill need it');
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
		this.host.chownRootYoal(`${target}.tmp`);
		renameSync(`${target}.tmp`, target);
	}

	private installReleaseCommands(): void {
		const { optDir, sbinDir, bunBin } = this.layout;
		for (const command of RELEASE_COMMANDS) {
			const path = join(sbinDir, command.name);
			const exec = command.runner === 'sh' ? `/bin/sh "$release/${command.script}"` : `${bunBin} "$release/${command.script}"`;
			const script = `#!/bin/sh
# Installed by Yoal: runs ${command.script} from the active Yoal release.
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
