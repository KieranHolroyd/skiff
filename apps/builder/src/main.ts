import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { ControlClient, ControlError } from './client.ts';
import { JobRunner } from './runner.ts';

/**
 * Node-token Builder daemon (D3, D47). Claims one git build at a time and converges it to a
 * release. It runs on every node (`skiff-agent builder`) and idles while the node does not have
 * the Builder role, so turning the role on in the dashboard is all it takes to start building.
 */

function log(message: string): void {
	console.log(`[builder] ${message}`);
}

export async function runBuilder(): Promise<void> {
	const config = loadConfig();
	await mkdir(config.buildDir, { recursive: true, mode: 0o711 });
	const client = new ControlClient(config.controlUrl, config.nodeToken);
	const runner = new JobRunner(config, client);

	let running = true;
	let wake: (() => void) | null = null;
	const sleep = (ms: number) =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				wake = null;
				resolve();
			}
			wake = done;
		});
	const stop = (signal: string) => {
		if (!running) return;
		running = false;
		log(`${signal} received; finishing the current job before exit`);
		wake?.();
	};
	// Bun's process typings only augment `memoryPressure`; the Node signal overloads still work.
	const signals = process as unknown as {
		once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
	};
	signals.once('SIGINT', () => stop('SIGINT'));
	signals.once('SIGTERM', () => stop('SIGTERM'));

	log(
		`polling ${config.controlUrl} (${config.systemd ? 'systemd-run' : 'direct exec'}` +
			`${config.buildUser ? ` as ${config.buildUser}` : ''}, memory ${config.memoryMax}, ` +
			`cpu ${config.cpuQuota}, timeout ${config.timeoutSeconds}s)`,
	);

	let builder: boolean | null = null;
	while (running) {
		try {
			const job = await client.next();
			if (builder !== true) log('this node has the Builder role; claiming builds');
			builder = true;
			if (!job) {
				await sleep(config.pollMs);
				continue;
			}
			log(`claimed ${job.buildId} (${job.ref})`);
			await runner.run(job);
		} catch (error) {
			if (error instanceof ControlError && error.status === 403) {
				// Not a Builder (yet): the normal state for most nodes, so stay quiet and poll slowly.
				if (builder !== false) log('this node does not have the Builder role; idle until it is enabled');
				builder = false;
				await sleep(config.idlePollMs);
				continue;
			}
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[builder] poll failed: ${message}`);
			// A revoked token or an unreachable control plane should back off, not spin.
			await sleep(Math.min(config.pollMs * 6, 30_000));
		}
	}
	log('stopped');
}

if (import.meta.main) await runBuilder();
