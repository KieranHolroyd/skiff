import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** A project's jobs (plan 09, docs/SCHEDULER.md §Jobs): cron and manual commands on its app. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { jobs: core.jobs.list(principal, project) };
	});

/** `{ name, command: [argv…], schedule?, timeoutSeconds?, concurrency?, maxRetries?, enabled? }` */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, z.unknown());
		return json({ job: core.jobs.create(principal, project, input) }, 201);
	});
