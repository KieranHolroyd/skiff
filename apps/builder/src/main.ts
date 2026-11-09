import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.ts';
import { ControlClient, ControlError } from './client.ts';
import { runPipelineLoop } from './pipeline/loop.ts';
import { JobRunner } from './runner.ts';

export { runPipelineStep } from './pipeline/step-main.ts';

/**
 * Node-token Builder daemon (D3, D47). Claims one git build at a time and converges it to a
 * release, and alongside it claims Pipelines jobs (docs/PIPELINES.md) by label. It runs on every
 * node (`yoal-agent builder`) and idles while the node does not have the Builder role, so
 * turning the role on in the dashboard is all it takes to start building.
 */

function log(message: string): void {
	console.log(`[builder] ${message}`);
}

/** Sleep that an abort ends early. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
		signal.addEventListener('abort', done, { once: true });
	});
}

async function runBuildLoop(config: ReturnType<typeof loadConfig>, signal: AbortSignal): Promise<void> {
	const client = new ControlClient(config.controlUrl, config.nodeToken);
	const runner = new JobRunner(config, client);
	log(
		`polling ${config.controlUrl} (${config.systemd ? 'systemd-run' : 'direct exec'}` +
			`${config.buildUser ? ` as ${config.buildUser}` : ''}, memory ${config.memoryMax}, ` +
			`cpu ${config.cpuQuota}, timeout ${config.timeoutSeconds}s)`,
	);

	let builder: boolean | null = null;
	while (!signal.aborted) {
		try {
			const job = await client.next();
			if (builder !== true) log('this node has the Builder role; claiming builds');
			builder = true;
			if (!job) {
				await sleep(config.pollMs, signal);
				continue;
			}
			log(`claimed ${job.buildId} (${job.ref})`);
			await runner.run(job);
		} catch (error) {
			if (error instanceof ControlError && error.status === 403) {
				// Not a Builder (yet): the normal state for most nodes, so stay quiet and poll slowly.
				if (builder !== false) log('this node does not have the Builder role; idle until it is enabled');
				builder = false;
				await sleep(config.idlePollMs, signal);
				continue;
			}
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[builder] poll failed: ${message}`);
			// A revoked token or an unreachable control plane should back off, not spin.
			await sleep(Math.min(config.pollMs * 6, 30_000), signal);
		}
	}
}

export async function runBuilder(): Promise<void> {
	const config = loadConfig();
	await mkdir(config.buildDir, { recursive: true, mode: 0o711 });

	const controller = new AbortController();
	const stop = (signal: string) => {
		if (controller.signal.aborted) return;
		log(`${signal} received; finishing running jobs before exit`);
		controller.abort();
	};
	// Bun's process typings only augment `memoryPressure`; the Node signal overloads still work.
	const signals = process as unknown as {
		once(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
	};
	signals.once('SIGINT', () => stop('SIGINT'));
	signals.once('SIGTERM', () => stop('SIGTERM'));

	await Promise.all([runBuildLoop(config, controller.signal), runPipelineLoop(config, controller.signal)]);
	log('stopped');
}

if (import.meta.main) {
	// A compiled `yoal-builder` is also its own step runner (`yoal-builder pipeline-step <job.json>`).
	const index = process.argv.indexOf('pipeline-step');
	if (index > 0 && index <= 2) {
		const { runPipelineStep } = await import('./pipeline/step-main.ts');
		// Exit explicitly: a background process a step left behind must not keep the runner alive.
		process.exit(await runPipelineStep(process.argv[index + 1]));
	} else await runBuilder();
}
