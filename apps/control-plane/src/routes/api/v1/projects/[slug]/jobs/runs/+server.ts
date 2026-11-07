import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Every run of the project, newest first; `?oneOff=1` keeps only one-off commands. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const params = event.url.searchParams;
		const oneOff = params.get('oneOff') === '1' || params.get('oneOff') === 'true';
		const limit = Number(params.get('limit') ?? 50) || 50;
		return { runs: core.jobs.runs(principal, project, { oneOff, limit }) };
	});

/** A one-off command: `{ command: [argv…], timeoutSeconds? }`, run once against the current release. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, z.unknown());
		const run = core.jobs.runOneOff(principal, project, input);
		return json({ run }, 202, { location: `/api/v1/projects/${encodeURIComponent(project.slug)}/jobs/runs/${run.id}` });
	});
