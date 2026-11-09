import { domainCreateSchema } from '@yoal/contracts';
import { json, readJson, route } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import { requirePrincipal } from '#lib/server/principal.js';
import type { RequestHandler } from './$types';

/** Custom domains (DESIGN §5, D31). Authentication, verification and record sync live in core. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const slug = event.url.searchParams.get('project');
		const project = slug ? core.projects.requireRow(principal, slug) : undefined;
		return { domains: core.domains.list(principal, project) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, domainCreateSchema);
		return json(await core.domains.create(principal, input), 201);
	});
