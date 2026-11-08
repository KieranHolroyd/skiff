import type { RequestHandler } from './$types';
import * as z from 'zod';
import {
	pipelineDispatchSchema,
	pipelineEnvironmentSetSchema,
	pipelineProjectLinkSchema,
	pipelineRepositoryCreateSchema,
	pipelineRepositoryUpdateSchema,
	pipelineRerunSchema,
	pipelineSecretSetSchema,
	pipelineVariableSetSchema,
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const approveSchema = z.object({ approve: z.boolean().default(true) });
const notAllowed = () => json({ error: 'method_not_allowed' }, 405);

function intParam(url: URL, name: string): number | undefined {
	const raw = url.searchParams.get(name);
	if (raw === null || raw === '') return undefined;
	const value = Number(raw);
	return Number.isInteger(value) ? value : undefined;
}

/**
 * Pipelines REST (docs/PIPELINES.md §8): `/api/v1/repositories[/:name/{runs,triggers,secrets,
 * variables,environments,projects}]`. Same service layer as the dashboard, CLI and MCP.
 */
const handler: RequestHandler = async (event) => {
	const { request, url } = event;
	const method = request.method;
	const segments = (event.params.path ?? '').split('/').filter(Boolean).map(decodeURIComponent);
	return route(async () => {
		const principal = requirePrincipal(event);
		const pipelines = core.pipelines;

		if (segments.length === 0) {
			if (method === 'GET') return { repositories: pipelines.listRepositories(principal) };
			if (method === 'POST')
				return json({ repository: pipelines.createRepository(principal, await readJson(request, pipelineRepositoryCreateSchema)) }, 201);
			return notAllowed();
		}

		const [name, section, id, sub, subId, subAction] = segments as [string, ...Array<string | undefined>];
		if (!section) {
			if (method === 'GET') return { repository: pipelines.getRepository(principal, name) };
			if (method === 'PATCH' || method === 'PUT')
				return { repository: pipelines.updateRepository(principal, name, await readJson(request, pipelineRepositoryUpdateSchema)) };
			if (method === 'DELETE') {
				await pipelines.deleteRepository(principal, name);
				return { ok: true };
			}
			return notAllowed();
		}

		switch (section) {
			case 'runs': {
				if (!id) {
					if (method === 'GET')
						return {
							runs: pipelines.listRuns(principal, name, {
								status: url.searchParams.get('status') ?? undefined,
								workflow: url.searchParams.get('workflow') ?? undefined,
								ref: url.searchParams.get('ref') ?? undefined,
								event: url.searchParams.get('event') ?? undefined,
								limit: intParam(url, 'limit'),
								before: intParam(url, 'before'),
							}),
						};
					// Dispatch: resolves asynchronously on a build node, so the answer is the trigger.
					if (method === 'POST')
						return json({ trigger: pipelines.dispatch(principal, name, await readJson(request, pipelineDispatchSchema)) }, 202);
					return notAllowed();
				}
				if (!sub) return method === 'GET' ? { run: await pipelines.getRun(principal, name, id) } : notAllowed();
				if (sub === 'cancel' && method === 'POST') return { run: await pipelines.cancelRun(principal, name, id) };
				if (sub === 'rerun' && method === 'POST') {
					const input = await readJson(request, pipelineRerunSchema);
					return { run: await pipelines.rerun(principal, name, id, input.failedOnly) };
				}
				if (sub === 'artifacts' && subId && method === 'GET') {
					const downloadUrl = await pipelines.artifactDownload(principal, name, id, subId);
					if (url.searchParams.get('redirect') === '1') return new Response(null, { status: 302, headers: { location: downloadUrl } });
					return { url: downloadUrl };
				}
				if (sub === 'jobs' && subId) {
					if (subAction === 'logs' && method === 'GET')
						return pipelines.jobLogs(principal, name, id, subId, {
							after: intParam(url, 'after'),
							limit: intParam(url, 'limit'),
							step: intParam(url, 'step'),
						});
					if (subAction === 'approve' && method === 'POST') {
						const input = await readJson(request, approveSchema);
						return { run: await pipelines.approveJob(principal, name, id, subId, input.approve) };
					}
				}
				return json({ error: 'not_found' }, 404);
			}
			case 'triggers':
				if (method !== 'GET') return notAllowed();
				if (id) return { trigger: pipelines.getTrigger(principal, name, id) };
				return { triggers: pipelines.listTriggers(principal, name, intParam(url, 'limit')) };
			case 'secrets':
				if (!id) return method === 'GET' ? { secrets: pipelines.listSecrets(principal, name) } : notAllowed();
				if (method === 'PUT' || method === 'POST')
					return { secret: pipelines.setSecret(principal, name, id, await readJson(request, pipelineSecretSetSchema)) };
				if (method === 'DELETE') {
					pipelines.deleteSecret(principal, name, id, url.searchParams.get('environment'));
					return { ok: true };
				}
				return notAllowed();
			case 'variables':
				if (!id) return method === 'GET' ? { variables: pipelines.listVariables(principal, name) } : notAllowed();
				if (method === 'PUT' || method === 'POST') {
					const input = await readJson(request, pipelineVariableSetSchema);
					return { variable: pipelines.setVariable(principal, name, id, input.value) };
				}
				if (method === 'DELETE') {
					pipelines.deleteVariable(principal, name, id);
					return { ok: true };
				}
				return notAllowed();
			case 'environments':
				if (!id) return method === 'GET' ? { environments: pipelines.listEnvironments(principal, name) } : notAllowed();
				if (method === 'PUT' || method === 'POST')
					return { environment: pipelines.setEnvironment(principal, name, id, await readJson(request, pipelineEnvironmentSetSchema)) };
				if (method === 'DELETE') {
					pipelines.deleteEnvironment(principal, name, id);
					return { ok: true };
				}
				return notAllowed();
			case 'projects':
				if (!id) return method === 'GET' ? { projects: pipelines.listProjectLinks(principal, name) } : notAllowed();
				if (method === 'PUT' || method === 'POST')
					return { link: pipelines.linkProject(principal, name, id, await readJson(request, pipelineProjectLinkSchema)) };
				if (method === 'DELETE') {
					pipelines.unlinkProject(principal, name, id);
					return { ok: true };
				}
				return notAllowed();
			default:
				return json({ error: 'not_found', section }, 404);
		}
	});
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
