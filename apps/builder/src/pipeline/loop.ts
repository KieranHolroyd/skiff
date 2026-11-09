import type { BuilderConfig, IsolationChoice } from '../config.ts';
import { chooseIsolation, hostProbe, pipelineNodeLabels } from '../config.ts';
import { JobApi, PipelineApiError, PipelineNodeClient } from './client.ts';
import { PipelineExecutor } from './executor.ts';
import { PipelineHelperClient, type PipelineHelper } from './helper-client.ts';
import { runResolve } from './resolve.ts';

/**
 * The pipeline half of the Builder daemon: claim resolves and jobs by label, run up to
 * `pipelineMaxJobs` at once, and on stop finish what is running before returning. A 403 means this
 * node is not a builder (same as git builds), so it idles quietly at the slow poll interval.
 */

function log(message: string): void {
	console.log(`[pipeline] ${message}`);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

/** How often `auto` asks yoal-helper again while it chose `sandbox` (the helper may start later). */
const ISOLATION_REPROBE_MS = 5 * 60_000;

/** Ask yoal-helper what it can do and pick the effective isolation (`chooseIsolation`). */
export async function probeIsolation(config: BuilderConfig, helper: PipelineHelper): Promise<IsolationChoice> {
	if (config.pipelineIsolationMode === 'sandbox' || config.pipelineContainerDriver === 'podman')
		return chooseIsolation({ mode: config.pipelineIsolationMode, driver: config.pipelineContainerDriver, buildDir: config.buildDir, caps: null, probe: hostProbe });
	let capsError: string | null = null;
	const caps = await helper.capabilities().catch((error: unknown) => {
		capsError = errorText(error);
		return null;
	});
	return chooseIsolation({ mode: config.pipelineIsolationMode, driver: 'helper', buildDir: config.buildDir, caps, capsError, probe: hostProbe });
}

export async function runPipelineLoop(config: BuilderConfig, signal: AbortSignal): Promise<void> {
	if (!config.pipelinesEnabled) {
		log('disabled (YOAL_PIPELINES=false)');
		return;
	}
	const client = new PipelineNodeClient(config.controlUrl, config.nodeToken);
	const helper = new PipelineHelperClient(config.helperSocket);
	let choice = await probeIsolation(config, helper);
	let probedAt = Date.now();
	const effective = () => ({ ...config, pipelineIsolation: choice.isolation });
	let executor = new PipelineExecutor(effective(), undefined, { helper });
	let labels = pipelineNodeLabels(effective());
	log(`isolation ${choice.isolation}: ${choice.reason}`);
	const running = new Set<Promise<void>>();
	const track = (work: Promise<void>) => {
		const tracked = work.catch((error: unknown) => console.error(`[pipeline] job crashed: ${errorText(error)}`)).finally(() => running.delete(tracked));
		running.add(tracked);
	};

	await executor.reapOrphans().catch((error: unknown) => console.error(`[pipeline] reaping orphans failed: ${errorText(error)}`));
	log(`polling for jobs (${choice.isolation} isolation, runtimes ${choice.runtimes.join(',') || 'none'}, up to ${config.pipelineMaxJobs} at once, labels ${labels.join(',')})`);

	let builder: boolean | null = null;
	while (!signal.aborted) {
		const capacity = config.pipelineMaxJobs - running.size;
		if (capacity <= 0) {
			await Promise.race([...running, sleep(config.pipelinePollMs, signal)]);
			continue;
		}
		if (config.pipelineIsolationMode === 'auto' && choice.isolation === 'sandbox' && Date.now() - probedAt > ISOLATION_REPROBE_MS) {
			probedAt = Date.now();
			const next = await probeIsolation(config, helper);
			if (next.isolation !== choice.isolation) {
				choice = next;
				executor = new PipelineExecutor(effective(), undefined, { helper });
				labels = pipelineNodeLabels(effective());
				log(`isolation is now ${choice.isolation}: ${choice.reason}`);
				await executor.reapOrphans().catch((error: unknown) => console.error(`[pipeline] reaping orphans failed: ${errorText(error)}`));
			}
		}
		try {
			const claim = await client.claim({ labels, capacity, isolation: choice.isolation, runtimes: choice.runtimes });
			if (builder !== true) log('this node has the Builder role; claiming pipeline jobs');
			builder = true;
			if (!claim) {
				await sleep(config.pipelinePollMs, signal);
				continue;
			}
			if (claim.kind === 'resolve') {
				log(`resolving ${claim.repository.name}@${claim.ref}`);
				track(runResolve({ claim, api: new JobApi(config.controlUrl, claim.token), credentials: config }));
			} else {
				log(`claimed job ${claim.jobId} (${claim.job.name}, run ${claim.runNumber})`);
				track(executor.run(claim));
			}
		} catch (error) {
			if (error instanceof PipelineApiError && error.status === 403) {
				if (builder !== false) log('this node does not have the Builder role; idle until it is enabled');
				builder = false;
				await sleep(config.idlePollMs, signal);
				continue;
			}
			console.error(`[pipeline] claim failed: ${errorText(error)}`);
			await sleep(Math.min(config.pipelinePollMs * 6, 30_000), signal);
		}
	}
	if (running.size) log(`stopping; waiting for ${running.size} running job(s) to finish`);
	await Promise.all(running);
	log('stopped');
}
