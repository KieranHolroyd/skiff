import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { ControlClient } from './client.ts';
import { JobRunner } from './runner.ts';

/** Node-token Builder daemon (D3). Claims one git build at a time and converges it to a release. */

function log(message: string): void {
	console.log(`[builder] ${message}`);
}

async function main(): Promise<void> {
	const config = loadConfig();
	await mkdir(config.buildDir, { recursive: true });
	const client = new ControlClient(config.controlUrl, config.nodeToken);
	const runner = new JobRunner(config, client);

	let running = true;
	const stop = (signal: string) => {
		if (!running) return;
		running = false;
		log(`${signal} received; finishing the current job before exit`);
	};
	// Bun's process typings only augment `memoryPressure`; the Node signal overloads still work.
	const signals = process as unknown as {
		once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
	};
	signals.once('SIGINT', () => stop('SIGINT'));
	signals.once('SIGTERM', () => stop('SIGTERM'));

	log(
		`polling ${config.controlUrl} (${config.systemd ? 'systemd-run' : 'direct exec'}, ` +
			`memory ${config.memoryMax}, cpu ${config.cpuQuota}, timeout ${config.timeoutSeconds}s)`,
	);

	while (running) {
		try {
			const job = await client.next();
			if (!job) {
				await Bun.sleep(config.pollMs);
				continue;
			}
			log(`claimed ${job.buildId} (${job.ref})`);
			await runner.run(job);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[builder] poll failed: ${message}`);
			// A revoked token or an unreachable control plane should back off, not spin.
			await Bun.sleep(Math.min(config.pollMs * 6, 30_000));
		}
	}
	log('stopped');
}

await main();
