import { loadHelperConfig } from './config.ts';
import { startHelperServer, type RunningHelper } from './server.ts';
import { spawnRunner, SystemdDriver } from './systemd.ts';

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
		releaseDirs: config.releaseDirs,
		bunPath: config.bunPath,
		systemctlPath: config.systemctlPath,
		journalctlPath: config.journalctlPath,
		socketMode: config.workloadSocketMode,
		socketGroup: config.workloadSocketGroup,
	});

	let helper: RunningHelper | null = null;
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
		await helper?.stop().catch(() => undefined);
		helper = null;
	};

	const signals = process as unknown as {
		once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
	};
	signals.once('SIGTERM', () => void stop());
	signals.once('SIGINT', () => void stop());

	helper = await startHelperServer(config, driver);
	if (stopping) await helper.stop();
	log('info', `Listening on unix/${config.socketPath} (units ${config.unitDir})`);

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
