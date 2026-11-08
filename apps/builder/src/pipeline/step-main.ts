import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineJobClaim } from '@skiff/contracts';
import { JobApi } from './client.ts';
import { StepRunner } from './step-runner.ts';

/**
 * `skiff-agent pipeline-step <job.json>`: the in-job entry point. The host daemon starts it inside
 * the job container (or sandbox unit) with:
 *
 *   SKIFF_CONTROL_URL         where the job API lives (as reachable from inside the job)
 *   SKIFF_JOB_TOKEN           the job token; job.json carries none
 *   SKIFF_PIPELINE_WORKSPACE  default /workspace
 *   SKIFF_PIPELINE_TEMP       default /skiff/tmp
 *   HOME                      default /skiff/home
 *
 * Exit code 0 means `/complete` was delivered (whatever the conclusion); anything else tells the
 * host to complete the job itself.
 */

/** Variables only the step runner may see; removed from its environment before any step starts. */
const PRIVATE_VARIABLES = ['SKIFF_JOB_TOKEN', 'SKIFF_CONTROL_URL', 'SKIFF_PIPELINE_WORKSPACE', 'SKIFF_PIPELINE_TEMP'];

export async function runPipelineStep(jobPath: string | undefined): Promise<number> {
	if (!jobPath) {
		console.error('usage: pipeline-step <job.json>');
		return 2;
	}
	const claim = JSON.parse(await readFile(jobPath, 'utf8')) as PipelineJobClaim;
	const token = process.env.SKIFF_JOB_TOKEN?.trim() || claim.token;
	const controlUrl = process.env.SKIFF_CONTROL_URL?.trim();
	if (!token || !controlUrl) {
		console.error('[skiff-step] SKIFF_JOB_TOKEN and SKIFF_CONTROL_URL are required');
		return 2;
	}
	const workspace = process.env.SKIFF_PIPELINE_WORKSPACE?.trim() || '/workspace';
	const temp = process.env.SKIFF_PIPELINE_TEMP?.trim() || '/skiff/tmp';
	const home = process.env.HOME?.trim() || '/skiff/home';
	// Steps never inherit these: they build their environment from an allowlist, and deleting them
	// here also keeps them out of anything a built-in spawns.
	for (const name of PRIVATE_VARIABLES) delete process.env[name];

	const runner = new StepRunner({
		// job.json carries no token; built-ins that log in as the job (skiff/build-image, the registry
		// login `job.<jobId>`) read it from the claim, so put it back in memory only.
		claim: { ...claim, token },
		api: new JobApi(controlUrl, token),
		paths: { workspace, temp, home, toolCache: join(home, 'tool-cache') },
		runnerName: process.env.SKIFF_RUNNER_NAME?.trim() || undefined,
	});
	const signals = process as unknown as { on(event: 'SIGTERM' | 'SIGINT', listener: () => void): void };
	signals.on('SIGTERM', () => runner.cancel('cancelled'));
	signals.on('SIGINT', () => runner.cancel('cancelled'));
	const { complete, delivered } = await runner.run();
	console.log(`[skiff-step] job ${claim.jobId} ${complete.conclusion}${delivered ? '' : ' (completion not delivered)'}`);
	return delivered ? 0 : 1;
}
