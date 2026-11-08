import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const member = z.object({ userId: z.string().min(1) });

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, member);
		core.iam.addGroupMember(principal, event.params.id!, input.userId);
		return json({ added: true }, 201);
	});

export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, member);
		core.iam.removeGroupMember(principal, event.params.id!, input.userId);
		return { removed: true };
	});
