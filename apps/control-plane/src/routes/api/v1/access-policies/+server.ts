import type { RequestHandler } from './$types';
import { accessPolicyCreateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Skiff Access policies (IAM.md I25, §11.1). The service checks `accessPolicy:*` at the scope. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const projectId = event.url.searchParams.get('projectId') ?? undefined;
		return json(core.accessPolicies.list(principal, projectId ? { projectId } : {}));
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, accessPolicyCreateSchema);
		return json(core.accessPolicies.create(principal, input), 201);
	});
