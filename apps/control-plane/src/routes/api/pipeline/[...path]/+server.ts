import type { RequestHandler } from './$types';
import {
	pipelineArtifactCreateSchema,
	pipelineCacheLookupSchema,
	pipelineCacheReserveSchema,
	pipelineDeploySchema,
	pipelineHeartbeatSchema,
	pipelineJobCompleteSchema,
	pipelineLogBatchSchema,
	pipelineOidcTokenSchema,
	pipelineResolveReportSchema,
	pipelineStepReportSchema,
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';

function bearer(request: Request): string {
	const header = request.headers.get('authorization') ?? '';
	if (!header.startsWith('Bearer ')) throw new Response('Unauthorized', { status: 401 });
	return header.slice(7).trim();
}

const notAllowed = () => json({ error: 'method_not_allowed' }, 405);

/**
 * The job-token API (docs/PIPELINES.md W9, W13): a claimed job reports steps, logs and outputs,
 * reads its secrets, and stores artifacts and caches. Resolve tokens (`ptk_`) may only `resolve`
 * and `heartbeat`. Never cookie-authenticated, so CSRF-exempt.
 */
const handler: RequestHandler = async (event) => {
	const { request } = event;
	const method = request.method;
	const segments = (event.params.path ?? '').split('/').filter(Boolean);
	const engine = core.pipelines.engine;
	// The OIDC issuer's discovery document and keys are public (W9): clouds fetch them unauthenticated.
	if (segments[0] === 'oidc' && method === 'GET') {
		const rest = segments.slice(1).join('/');
		if (rest === '.well-known/openid-configuration') return json(engine.oidc.discovery(), 200, { 'cache-control': 'public, max-age=300' });
		if (rest === 'jwks') return json(engine.oidc.jwks(), 200, { 'cache-control': 'public, max-age=300' });
		return json({ error: 'not_found' }, 404);
	}
	const token = bearer(request);
	return route(async () => {
		const [action, id, sub] = segments;

		if (token.startsWith('ptk_')) {
			const trigger = engine.authenticateTrigger(token);
			if (action === 'resolve' && method === 'POST') {
				const runIds = engine.resolveTrigger(trigger, await readJson(request, pipelineResolveReportSchema));
				return { ok: true, runIds };
			}
			if (action === 'heartbeat' && method === 'POST') return engine.heartbeatTrigger(trigger);
			return json({ error: 'not_found' }, 404);
		}

		// `complete` is idempotent: the runner's call may have landed with its response lost, and
		// the host daemon then completes the job itself. The first call wins.
		if (action === 'complete') {
			if (method !== 'POST') return notAllowed();
			const job = engine.authenticateJob(token, { allowCompleted: true });
			const input = await readJson(request, pipelineJobCompleteSchema);
			if (job.status === 'completed') return { ok: true, alreadyCompleted: true, conclusion: job.conclusion };
			engine.complete(job, input);
			return { ok: true };
		}

		// Logs may arrive just after `complete` (the final flush), so they accept a finished job.
		if (action === 'logs') {
			if (method !== 'POST') return notAllowed();
			const job = engine.authenticateJob(token, { allowCompleted: true });
			return { ok: true, accepted: engine.appendLogs(job, await readJson(request, pipelineLogBatchSchema)) };
		}

		const job = engine.authenticateJob(token);
		switch (action) {
			case 'heartbeat':
				if (method !== 'POST') return notAllowed();
				await readJson(request, pipelineHeartbeatSchema).catch(() => ({}));
				return engine.heartbeat(job);
			case 'oidc-token': {
				if (method !== 'POST') return notAllowed();
				const input = await readJson(request, pipelineOidcTokenSchema);
				return engine.mintOidcToken(job, input.audience);
			}
			case 'secrets':
				if (method !== 'GET') return notAllowed();
				return { secrets: engine.secrets(job) };
			case 'steps': {
				if (method !== 'POST') return notAllowed();
				const index = Number(id);
				if (!Number.isInteger(index) || index < 0 || index > 1000) return json({ error: 'bad_step' }, 400);
				engine.reportStep(job, index, await readJson(request, pipelineStepReportSchema));
				return { ok: true };
			}
			case 'artifacts':
				if (!id) {
					if (method === 'GET')
						return {
							artifacts: await engine.listArtifacts(job.runId, {
								name: event.url.searchParams.get('name') ?? undefined,
								withUrls: true,
							}),
						};
					if (method === 'POST') return engine.createArtifact(job, await readJson(request, pipelineArtifactCreateSchema));
					return notAllowed();
				}
				if (sub === 'finalize' && method === 'POST') return engine.finalizeArtifact(job, id);
				return json({ error: 'not_found' }, 404);
			case 'cache':
				if (method !== 'POST') return notAllowed();
				if (id === 'lookup') return { hit: await engine.lookupCache(job, await readJson(request, pipelineCacheLookupSchema)) };
				if (id === 'reserve') return engine.reserveCache(job, await readJson(request, pipelineCacheReserveSchema));
				if (id && sub === 'commit') {
					await engine.commitCache(job, id);
					return { ok: true };
				}
				return json({ error: 'not_found' }, 404);
			case 'deploy':
				if (method !== 'POST') return notAllowed();
				if (!id) return engine.startDeploy(job, await readJson(request, pipelineDeploySchema));
				if (sub === 'finalize') return engine.finalizeDeploy(job, id);
				return json({ error: 'not_found' }, 404);
			default:
				return json({ error: 'not_found', action }, 404);
		}
	});
};

export const GET = handler;
export const POST = handler;
