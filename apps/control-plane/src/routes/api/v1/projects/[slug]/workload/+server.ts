import type { RequestHandler } from './$types';
import { workloadSpecSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Tier 2/3 runtime spec for a project (DESIGN §3.4); secrets stay references only. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { workload: core.workloads.get(principal, project) };
	});

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, workloadSpecSchema);
		return { workload: core.workloads.setSpec(principal, project, input) };
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		core.workloads.remove(principal, project);
		return { ok: true };
	});
