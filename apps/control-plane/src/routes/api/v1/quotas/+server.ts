import type { RequestHandler } from './$types';
import { projectQuotaOverrideSchema, quotaUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Org quotas, or one project's overrides with `?project=<slug>`. Reads require project access so
 * usage never crosses an org boundary; writes require a platform admin (checked in core).
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
		const project = event.url.searchParams.get('project') || undefined;
		if (project) {
			const input = await readJson(event.request, projectQuotaOverrideSchema);
			return core.usage.setQuotas(principal, input, { projectSlug: project });
		}
		const input = await readJson(event.request, quotaUpdateSchema);
		return core.usage.setQuotas(principal, input);
	});

export const PATCH = PUT;

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = event.url.searchParams.get('project');
		if (!project) return json({ error: 'validation', message: 'Project required.' }, 422);
		return core.usage.clearProjectQuotas(principal, project);
	});
