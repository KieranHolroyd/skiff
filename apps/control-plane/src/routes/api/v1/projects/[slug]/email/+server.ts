import * as z from 'zod';
import type { RequestHandler } from './$types';
import { requirePermission } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Email attached to a project (EMAIL.md §5.4): a project-scoped credential the app receives as
 * `<PREFIX>_HOST/_PORT/_SECURE/_USER/_PASSWORD/_URL` at activation. `PREFIX` defaults to SMTP.
 */

const attachSchema = z.object({ envPrefix: z.string().optional() });

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		requirePermission(principal, 'email:read');
		return { attachments: core.email.attachments(project.id) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		const input = await readJson(event.request, attachSchema);
		return json(core.email.attach(principal, project, input), 201);
	});

/** `?envPrefix=` picks which attachment to drop (default SMTP); the app restarts without it. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		core.email.detach(principal, project, event.url.searchParams.get('envPrefix') ?? undefined);
		return new Response(null, { status: 204 });
	});
