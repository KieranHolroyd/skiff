import { loadHelperConfig } from './config.ts';
import { startHelperServer, type RunningHelper } from './server.ts';
import { spawnRunner, SystemdDriver } from './systemd.ts';
import { NodeUpdater } from './node-update.ts';
import { WireguardManager } from './wireguard.ts';
import { NetworkManager } from './network.ts';
import { ShareMounter } from './shares.ts';
import { ContainerConsole } from './container-console.ts';
import { DEFAULT_SUBID_FILES } from './userns.ts';
import { JobDriver } from './jobs.ts';
import { dirname, join } from 'node:path';

/**
 * `skiff-helper`: the only privileged Skiff process (D26). It listens on a root-owned,
 * group-restricted unix socket, validates every field itself and renders fixed units. The agent
 * never runs as root.
 */

function log(level: 'info' | 'warn' | 'error', message: string): void {
	const line = `[skiff-helper ${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
	if (level === 'error') console.error(line);
	else if (level === 'warn') console.warn(line);
	else console.log(line);
}

export async function runHelper(): Promise<void> {
	const config = loadHelperConfig();
	const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
	if (uid !== 0) {
		throw new Error(`skiff-helper must run as root (uid 0); running as uid ${uid}`);
	}

	const driver = new SystemdDriver({
		runner: spawnRunner(),
		unitDir: config.unitDir,
		quadletDir: config.quadletDir,
		runtimeDir: config.runtimeDir,
		stateDir: config.stateDir,
		replicationDir: config.replicationDir,
		releaseDirs: config.releaseDirs,
		workerdDir: config.workerdDir,
		bunPath: config.bunPath,
		nodePath: config.nodePath,
		systemctlPath: config.systemctlPath,
		journalctlPath: config.journalctlPath,
		podmanPath: config.podmanPath,
		opensslPath: config.opensslPath,
		apparmorProfile: config.apparmorProfile,
		containerSubids: DEFAULT_SUBID_FILES,
		socketMode: config.workloadSocketMode,
		socketGroup: config.workloadSocketGroup,
	});

	let helper: RunningHelper | null = null;
	let containers: ContainerConsole | null = null;
	let stopping = false;
	let resolveStop: (() => void) | null = null;
	const stopped = new Promise<void>((resolve) => {
		resolveStop = resolve;
	});
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		resolveStop?.();
		log('info', 'Shutting down');
		// Workloads stay running: the agent owns their lifecycle, the helper only renders them.
		await containers?.closeAll().catch(() => undefined);
		await helper?.stop().catch(() => undefined);
		helper = null;
	};

	const signals = process as unknown as {
		once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
	};
	signals.once('SIGTERM', () => void stop());
	signals.once('SIGINT', () => void stop());

	const nodeUpdate = new NodeUpdater({
		paths: config.nodeUpdate,
		currentVersion: config.version,
		log: (level, message) => log(level, `node update: ${message}`),
	});
	const wireguard = new WireguardManager({ firewall: new NetworkManager() });
	containers = new ContainerConsole({
		podmanPath: config.podmanPath,
		systemctlPath: config.systemctlPath,
		quadletDir: config.quadletDir,
		runner: spawnRunner(),
		log: (level, message) => log(level, `container console: ${message}`),
	});
	helper = await startHelperServer(config, driver, {
		nodeUpdate,
		wireguard,
		shares: new ShareMounter(),
		containers,
		appVolumes: driver.appVolumeData({ log: (level, message) => log(level, `app volumes: ${message}`) }),
		// Job runs (plan 09): systemd-run sits beside systemctl on every supported distribution.
		jobs: new JobDriver({
			runner: spawnRunner(),
			runtimeDir: config.runtimeDir,
			releaseDirs: config.releaseDirs,
			bunPath: config.bunPath,
			nodePath: config.nodePath,
			systemdRunPath: join(dirname(config.systemctlPath), 'systemd-run'),
			systemctlPath: config.systemctlPath,
			journalctlPath: config.journalctlPath,
			podmanPath: config.podmanPath,
			apparmorProfile: config.apparmorProfile,
			resolveAppVolumeMounts: (workload) => driver.resolveAppVolumeMounts(workload),
			resolveDataDir: (workload) => driver.resolveDataDir(workload),
		}),
	});
	if (stopping) await helper.stop();
	log('info', `Listening on unix/${config.socketPath} (units ${config.unitDir})`);

	// D96 retired the D60 studio console; clear any console sidecar a node kept from before the upgrade. Best
	// effort and off the request path: a failure is logged and retried on the next helper start.
	void driver
		.removeLegacyConsoles()
		.then((ids) => {
			if (ids.length > 0) log('info', `Removed leftover studio console sidecars (D60): ${ids.join(', ')}`);
		})
		.catch((error: unknown) =>
			log('warn', `Could not remove leftover studio console sidecars (D60): ${error instanceof Error ? error.message : String(error)}`),
		);

	// Keep the process alive until a signal resolves the stop promise.
	await stopped;
}

if (import.meta.main) {
	await runHelper().catch((error: unknown) => {
		console.error(
			`[skiff-helper] fatal: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
