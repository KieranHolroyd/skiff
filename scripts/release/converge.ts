/**
 * Host convergence: make everything *outside* a release (systemd units, the helper binary, host
 * commands, workerd, the telemetry store, env defaults) match the release that is about to serve.
 *
 * Why a release hook and not the updater: the updater that drives an update is the one installed
 * from the *previous* release (stage-0). If it rendered the units, every unit change, new binary
 * pin or new env default would land one release late, and only after a second update. Shipping
 * this code in the release and running it with the release's own Bun (`hooks.ts prepare|converge`)
 * means the release that changes a template is the release that installs it. Rolling back runs
 * the older release's copy, which puts its own units back.
 *
 * Every step is idempotent and isolated: a failing step is a warning in the report, never an
 * exception, so convergence can never block an update or a rollback.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SELF_UPDATE_DEFAULTS } from '../../packages/contracts/src/self-update.ts';
import { ensureVapidKeys } from '../../packages/contracts/src/vapid.ts';
import { ensureHostCommands } from '../install/commands.ts';
import { readEnvFile, writeEnvFile } from '../install/env-file.ts';
import { ensurePlatformConfigUnits } from '../platform-config/units.ts';
import { ensureAgentUnit } from '../systemd/agent.ts';
import { ensureBuilder, linkAgentCommands } from '../systemd/builder.ts';
import { clickhouseInstalled, ensureClickHouse } from '../systemd/clickhouse.ts';
import { DEFAULT_CONTROL_PLANE_PATHS, ensureControlPlaneUnits } from '../systemd/control-plane.ts';
import { ensureHelper } from '../systemd/helper.ts';
import { ensureStorageUnits } from '../systemd/storage.ts';
import { ensureStudioUnit } from '../systemd/studio.ts';
import { ensureMailUnit } from '../systemd/mail.ts';
import { ensureIdentityUnits } from '../systemd/identity.ts';
import { TRIGGER_PATH_UNIT, triggerUnits, updateCommandScript } from '../update-self/units.ts';

export interface HostPaths {
	optDir: string;
	etcDir: string;
	varDir: string;
	runDir: string;
	systemdDir: string;
	/** The host's shared Bun (`/opt/yoal/runtime/bin/bun`), which host commands run on. */
	bunBin: string;
	updaterDir: string;
	updateRequestFile: string;
}

export function hostPathsFromEnv(env: Record<string, string | undefined> = process.env): HostPaths {
	const optDir = env.YOAL_OPT_DIR ?? '/opt/yoal';
	return {
		optDir,
		etcDir: env.YOAL_ETC_DIR ?? '/etc/yoal',
		varDir: env.YOAL_VAR_DIR ?? '/var/lib/yoal',
		runDir: env.YOAL_RUN_DIR ?? '/run/yoal',
		systemdDir: env.YOAL_SYSTEMD_DIR ?? '/etc/systemd/system',
		bunBin: env.YOAL_BUN_BIN ?? join(optDir, 'runtime', 'bin', 'bun'),
		updaterDir: env.YOAL_UPDATER_DIR ?? '/usr/local/lib/yoal-updater',
		updateRequestFile: env.YOAL_UPDATE_REQUEST_FILE ?? SELF_UPDATE_DEFAULTS.requestFile,
	};
}

export interface CommandRunner {
	/** Run a command; throws on a non-zero exit. */
	run(cmd: string[]): void;
	/** Run a command and return stdout, or null on a non-zero exit. */
	capture(cmd: string[]): string | null;
}

export function systemRunner(): CommandRunner {
	const spawn = (cmd: string[]) => {
		const result = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
		return {
			code: result.exitCode ?? 1,
			stdout: new TextDecoder().decode(result.stdout).trim(),
			stderr: new TextDecoder().decode(result.stderr).trim(),
		};
	};
	return {
		run(cmd) {
			const result = spawn(cmd);
			if (result.code !== 0) throw new Error(`${cmd.join(' ')} exited ${result.code}${result.stderr ? `: ${result.stderr}` : ''}`);
		},
		capture(cmd) {
			const result = spawn(cmd);
			return result.code === 0 ? result.stdout : null;
		},
	};
}

export interface ConvergeReport {
	/** Steps that changed something on the host. */
	changed: string[];
	/** Steps that failed; the rest still ran. */
	warnings: string[];
}

export interface ConvergeInput {
	/** The release the host should match (`/opt/yoal/releases/<name>`). */
	release: string;
	paths?: HostPaths;
	/**
	 * `update` (default) also moves forward-only, version-pinned installs (the ClickHouse
	 * server). `rollback` leaves them alone: an older pin must never downgrade a data store.
	 */
	mode?: 'update' | 'rollback';
	runner?: CommandRunner;
	log?: (message: string) => void;
}

/** The backup units the installer adds on R2 hosts; refreshed only where already installed. */
export const BACKUP_UNITS = ['yoal-litestream.service', 'yoal-restore-drill.service', 'yoal-restore-drill.timer', 'yoal-alert@.service'];

async function step(report: ConvergeReport, name: string, fn: () => boolean | void | Promise<boolean | void>): Promise<void> {
	try {
		if (await fn()) report.changed.push(name);
	} catch (error) {
		report.warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Before the release boots anywhere (canary, standby): additive settings it needs in yoal.env.
 * Only things the running release tolerates belong here, since it keeps serving with them.
 */
export async function prepareHost(input: Omit<ConvergeInput, 'mode'>): Promise<ConvergeReport> {
	const paths = input.paths ?? hostPathsFromEnv();
	const runner = input.runner ?? systemRunner();
	const report: ConvergeReport = { changed: [], warnings: [] };
	const envFile = join(paths.etcDir, 'yoal.env');
	// Web Push alerts (D108). Never replaces a valid pair: that would orphan every subscription.
	await step(report, 'vapid-keys', () => {
		if (!existsSync(envFile)) return false;
		const env = readEnvFile(envFile);
		if (!ensureVapidKeys(env)) return false;
		writeEnvFile(envFile, env);
		runner.run(['chown', 'root:yoal', envFile]);
		runner.run(['chmod', '0640', envFile]);
		input.log?.('generated the Web Push (VAPID) key pair');
		return true;
	});
	return report;
}

/**
 * After `current` points at the release (and before its services restart): every unit, binary
 * and command outside the release. The caller restarts the control plane, helper and agent.
 */
export async function convergeHost(input: ConvergeInput): Promise<ConvergeReport> {
	const paths = input.paths ?? hostPathsFromEnv();
	const runner = input.runner ?? systemRunner();
	const log = input.log ?? (() => undefined);
	const { release } = input;
	const mode = input.mode ?? 'update';
	const report: ConvergeReport = { changed: [], warnings: [] };
	const envFile = join(paths.etcDir, 'yoal.env');
	const agentEnvFile = join(paths.etcDir, 'agent.env');
	const tolerant = (cmd: string[]) => {
		try {
			runner.run(cmd);
		} catch (error) {
			log(`warning: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const controlPlaneHost = existsSync(envFile);
	const agentHost = existsSync(agentEnvFile);

	if (controlPlaneHost) {
		await step(report, 'control-plane-units', () =>
			ensureControlPlaneUnits({
				systemdDir: paths.systemdDir,
				paths: {
					...DEFAULT_CONTROL_PLANE_PATHS,
					optDir: paths.optDir,
					runDir: paths.runDir,
					varDir: paths.varDir,
					envFile,
					masterKeyFile: join(paths.etcDir, 'master.key'),
				},
				run: tolerant,
				log,
			}),
		);
	}

	// Dashboard updates: the path unit, its oneshot service and /usr/local/sbin/yoal-update-self.
	await step(report, 'update-trigger', () => {
		let changed = false;
		const command = '/usr/local/sbin/yoal-update-self';
		const script = updateCommandScript({ optDir: paths.optDir, bunBin: paths.bunBin, updaterDir: paths.updaterDir });
		if (!existsSync(command) || readFileSync(command, 'utf8') !== script) {
			mkdirSync(dirname(command), { recursive: true });
			writeFileSync(`${command}.tmp`, script, { mode: 0o755 });
			renameSync(`${command}.tmp`, command);
			changed = true;
		}
		for (const [name, body] of Object.entries(triggerUnits({ requestFile: paths.updateRequestFile, command }))) {
			const path = join(paths.systemdDir, name);
			if (existsSync(path) && readFileSync(path, 'utf8') === body) continue;
			writeFileSync(path, body, { mode: 0o644 });
			changed = true;
		}
		mkdirSync(dirname(paths.updateRequestFile), { recursive: true, mode: 0o750 });
		tolerant(['chown', 'yoal:yoal', dirname(paths.updateRequestFile)]);
		if (changed) {
			runner.run(['systemctl', 'daemon-reload']);
			tolerant(['systemctl', 'enable', '--now', TRIGGER_PATH_UNIT]);
		}
		return changed;
	});

	await step(report, 'platform-config', () =>
		ensurePlatformConfigUnits({ systemdDir: paths.systemdDir, optDir: paths.optDir, bunBin: paths.bunBin, run: tolerant, log }),
	);

	await step(report, 'studio-unit', () =>
		ensureStudioUnit({ systemdDir: paths.systemdDir, optDir: paths.optDir, runDir: paths.runDir, socketGroup: 'caddy', run: tolerant, log }),
	);

	// Email's MTA (docs/EMAIL.md): static like the studio; only the mail node's agent starts it.
	await step(report, 'mail-unit', () =>
		ensureMailUnit({ systemdDir: paths.systemdDir, optDir: paths.optDir, runDir: paths.runDir, socketGroup: 'caddy', run: tolerant, log }),
	);

	// The separate user-pool identity process (docs/IAM.md §11.2): static; only the identity node's
	// agent starts it, and the Litestream companion follows it.
	await step(report, 'identity-unit', () =>
		ensureIdentityUnits({ systemdDir: paths.systemdDir, optDir: paths.optDir, runDir: paths.runDir, socketGroup: 'caddy', run: tolerant, log }),
	);

	// Binary and unit; the caller restarts it (the running helper keeps its old inode until then).
	await step(report, 'helper', () =>
		ensureHelper({
			systemdDir: paths.systemdDir,
			optDir: paths.optDir,
			etcDir: paths.etcDir,
			varDir: paths.varDir,
			bunBin: paths.bunBin,
			release,
			run: tolerant,
			log,
			start: false,
		}),
	);

	if (agentHost) {
		await step(report, 'agent-unit', () =>
			ensureAgentUnit({
				systemdDir: paths.systemdDir,
				optDir: paths.optDir,
				etcDir: paths.etcDir,
				varDir: paths.varDir,
				runDir: paths.runDir,
				run: tolerant,
				log,
			}),
		);
		await step(report, 'agent-commands', () => void linkAgentCommands(release));
		// The managed overlay (docs/CLUSTERING.md §4.1, C1): the helper drives kernel WireGuard with
		// `wg`, so every agent host needs wireguard-tools before a node can be put on the overlay.
		// Debian/Ubuntu only, and never on a host whose operator skipped package installs.
		await step(report, 'wireguard-tools', () => {
			if (runner.capture(['sh', '-c', 'command -v wg'])) return false;
			if (!runner.capture(['sh', '-c', 'command -v apt-get'])) throw new Error('wg is missing; install wireguard-tools');
			const helperEnv = join(paths.etcDir, 'helper.env');
			if (existsSync(helperEnv) && /^YOAL_HELPER_STORAGE_TOOLS=0$/m.test(readFileSync(helperEnv, 'utf8')))
				throw new Error('wg is missing and package installs are off (--skip-deps); install wireguard-tools');
			const install = ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-q', '--no-install-recommends', 'wireguard-tools'];
			if (runner.capture(install) === null) {
				// Stale package lists are the usual cause; refresh once and retry.
				runner.run(['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update', '-q']);
				runner.run(install);
			}
			log('installed wireguard-tools');
			return true;
		});
		// PartOf=yoal-agent.service: it restarts with the agent, so never start it here.
		await step(report, 'builder', () =>
			ensureBuilder({
				systemdDir: paths.systemdDir,
				optDir: paths.optDir,
				agentEnvFile,
				run: tolerant,
				capture: runner.capture,
				log,
				start: false,
			}),
		);
		await step(report, 'storage-units', () =>
			ensureStorageUnits({ systemdDir: paths.systemdDir, optDir: paths.optDir, agentEnvFile, run: tolerant, log }),
		);
		// Functions run on a pinned workerd (docs/FUNCTIONS.md FN1); a pin bump must be on disk
		// before the new agent and helper start. Versions live side by side, so rollback is safe.
		const workerdModule = join(release, 'repo', 'scripts', 'install', 'workerd.ts');
		if (existsSync(workerdModule)) {
			await step(report, 'workerd', async () => {
				const { ensureWorkerd, pinnedWorkerdVersion, workerdArch } = await import(workerdModule);
				const arch = workerdArch(process.arch);
				if (!arch) throw new Error(`no workerd build for ${process.arch}`);
				const version = pinnedWorkerdVersion(join(release, 'repo'));
				const result = await ensureWorkerd({ version, arch, log });
				if (result === 'installed') log(`installed workerd ${version}`);
				return result === 'installed';
			});
		}
		// Python functions need the Pyodide cache for *this* workerd pin (D121). Only a node that
		// had it for some pin follows a bump, so `--no-python` installs stay without it.
		const pyodideModule = join(release, 'repo', 'scripts', 'install', 'pyodide.ts');
		if (existsSync(pyodideModule) && existsSync(workerdModule)) {
			await step(report, 'pyodide', async () => {
				const { pinnedWorkerdVersion, WORKERD_DEST } = await import(workerdModule);
				const { pyodideBundles, pythonBundleEras, warmPyodideCache } = await import(pyodideModule);
				const root: string = WORKERD_DEST;
				const hadCache = (runner.capture(['ls', root]) ?? '')
					.split('\n')
					.some((version: string) => version !== '' && pyodideBundles(join(root, version, 'pyodide')).length > 0);
				if (!hadCache) return false;
				const version = pinnedWorkerdVersion(join(release, 'repo'));
				const result = await warmPyodideCache({
					workerdPath: join(root, version, 'workerd'),
					cacheDir: join(root, version, 'pyodide'),
					eras: await pythonBundleEras(join(release, 'repo')),
					log,
				});
				return result === 'warmed';
			});
		}
		// Node.js process apps run on a pinned LTS (D125). It is on by default, so every agent host
		// gets it (an older node on its first upgrade too) unless it was declined with --no-node or
		// the operator's own /usr/local/bin/node is there; a pin bump follows on the rest.
		const nodeModule = join(release, 'repo', 'scripts', 'install', 'node.ts');
		if (existsSync(nodeModule)) {
			await step(report, 'node', async () => {
				const { ensureNode, nodeArch, hasYoalNode, NODE_BIN_DIR, NODE_OPT_OUT_MARKER, NODE_PINNED_VERSION } =
					await import(nodeModule);
				if (existsSync(NODE_OPT_OUT_MARKER)) return false;
				if (!hasYoalNode() && existsSync(join(NODE_BIN_DIR, 'node'))) return false;
				const arch = nodeArch(process.arch);
				if (!arch) throw new Error(`no Node.js build for ${process.arch}`);
				const result = await ensureNode({ arch, log });
				if (result === 'installed') log(`installed Node.js ${NODE_PINNED_VERSION}`);
				return result === 'installed';
			});
		}
		// PHP process apps run on a pinned FrankenPHP (D121). It is opt-in, so only a node that
		// already has Yoal's install (the PATH link into /usr/lib/yoal/frankenphp) follows a pin
		// bump; nothing is downloaded on a node that never asked for PHP.
		const frankenphpModule = join(release, 'repo', 'scripts', 'install', 'frankenphp.ts');
		if (existsSync(frankenphpModule)) {
			await step(report, 'frankenphp', async () => {
				const { ensureFrankenphp, frankenphpArch, FRANKENPHP_DEST, FRANKENPHP_LINK, FRANKENPHP_PINNED_VERSION } =
					await import(frankenphpModule);
				const current = runner.capture(['readlink', FRANKENPHP_LINK]);
				if (!current?.startsWith(`${FRANKENPHP_DEST}/`)) return false;
				const arch = frankenphpArch(process.arch);
				if (!arch) throw new Error(`no FrankenPHP build for ${process.arch}`);
				const result = await ensureFrankenphp({ arch, log });
				if (result === 'installed') log(`installed FrankenPHP ${FRANKENPHP_PINNED_VERSION}`);
				return result === 'installed';
			});
		}
	}

	if (controlPlaneHost) {
		await step(report, 'host-commands', () => ensureHostCommands({ optDir: paths.optDir, bunBin: paths.bunBin }, { log }).length > 0);

		// R2 hosts only: refresh the units the installer put there, never add them.
		await step(report, 'backup-units', () => {
			const litestream = runner.capture(['sh', '-c', 'command -v litestream']);
			const changed: string[] = [];
			for (const name of BACKUP_UNITS) {
				const path = join(paths.systemdDir, name);
				const source = join(release, 'repo', 'scripts', 'systemd', name);
				if (!existsSync(path) || !existsSync(source)) continue;
				let body = readFileSync(source, 'utf8');
				if (litestream) body = body.replaceAll('/usr/local/bin/litestream', litestream);
				if (readFileSync(path, 'utf8') === body) continue;
				writeFileSync(path, body, { mode: 0o644 });
				changed.push(name);
			}
			if (!changed.length) return false;
			runner.run(['systemctl', 'daemon-reload']);
			if (changed.includes('yoal-litestream.service')) tolerant(['systemctl', 'try-restart', 'yoal-litestream.service']);
			log(`refreshed ${changed.join(', ')}`);
			return true;
		});

		// The optional telemetry store (D101): kept current where installed, never added.
		if (mode === 'update' && clickhouseInstalled(paths.systemdDir)) {
			await step(report, 'clickhouse', async () => {
				const result = await ensureClickHouse({
					envFile,
					systemdDir: paths.systemdDir,
					installRoot: join(paths.optDir, 'clickhouse'),
					run: runner.run,
					capture: runner.capture,
					log: (message) => (message.startsWith('warning:') ? undefined : log(message)),
				});
				if (result.warning) throw new Error(result.warning);
				return result.changed;
			});
		}
	}

	return report;
}
