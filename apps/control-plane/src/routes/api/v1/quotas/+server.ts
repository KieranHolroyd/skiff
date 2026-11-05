import type { RequestHandler } from './$types';
import { CoreError } from '@skiff/core';
import { projectQuotaOverrideSchema, quotaUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Platform admins set quotas; every surface (REST/CLI) reaches the same service-layer check. */
function requireQuotaAdmin(principal: ReturnType<typeof requirePrincipal>): void {
	if (principal.platformAdmin !== true && principal.kind !== 'system')
		throw new CoreError('forbidden', 'Platform admin required to change quotas.', 403);
}

/**
 * Org quotas, or one project's overrides with `?project=<slug>`. Reads require project access so
 * usage never crosses an org boundary; writes require a platform admin.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = event.url.searchParams.get('project') || undefined;
		return core.usage.quotas(principal, project ? { projectSlug: project } : {});
	});

const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		requireQuotaAdmin(principal);
		const project = event.url.searchParams.get('project') || undefined;
		if (project) {
			const scope = core.usage.quotas(principal, { projectSlug: project });
			const input = await readJson(event.request, projectQuotaOverrideSchema);
			core.ctx.quota.setProject(principal.orgId, scope.projectId!, input);
			core.ctx.audit.record({
				principal,
				action: 'quota.set',
				resource: 'project',
				resourceId: scope.projectId!,
				args: { project, ...input },
				result: 'ok',
			});
			return core.usage.quotas(principal, { projectSlug: project });
		}
		const input = await readJson(event.request, quotaUpdateSchema);
		core.ctx.quota.set(principal.orgId, input);
		core.ctx.audit.record({
			principal,
			action: 'quota.set',
			resource: 'org',
			resourceId: principal.orgId,
			args: input,
			result: 'ok',
		});
		return core.usage.quotas(principal);
	});

export const PATCH = PUT;

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		requireQuotaAdmin(principal);
		const project = event.url.searchParams.get('project');
		if (!project) return json({ error: 'validation', message: 'Project required.' }, 422);
		const scope = core.usage.quotas(principal, { projectSlug: project });
		core.ctx.quota.clearProject(principal.orgId, scope.projectId!);
		core.ctx.audit.record({
			principal,
			action: 'quota.clear',
			resource: 'project',
			resourceId: scope.projectId!,
			args: { project },
			result: 'ok',
		});
		return { ok: true };
	});
