import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const inviteSchema = z.object({ email: z.string().trim().min(3).max(320) });

/** Pending invitations for an invite-only pool. The raw token is returned only on create. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { invites: core.userPools.listInvites(principal, event.params.id) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, inviteSchema);
		return json(core.userPools.inviteUser(principal, event.params.id, input.email), 201);
	});
