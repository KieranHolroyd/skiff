import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const patchSchema = z.object({ disabled: z.boolean() });

/** Disable (or re-enable) one pool user. Disabling revokes their sessions immediately. */
export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, patchSchema);
		return {
			user: core.userPools.disableUser(
				principal,
				event.params.id,
				event.params.userId,
				input.disabled
			)
		};
	});

/** GDPR delete: the user, their sessions, codes and verification tokens. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.userPools.deleteUser(principal, event.params.id, event.params.userId);
		return { ok: true };
	});
