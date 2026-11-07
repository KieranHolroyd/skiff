import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { job: core.jobs.get(principal, project, event.params.name) };
	});

/** Change the command, schedule (`null` removes it), timeout, concurrency, retries or `enabled`. */
export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, z.unknown());
		return { job: core.jobs.update(principal, project, event.params.name, input) };
	});

/** Delete the job and its run history; a run in progress is stopped. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return core.jobs.remove(principal, project, event.params.name);
	});
