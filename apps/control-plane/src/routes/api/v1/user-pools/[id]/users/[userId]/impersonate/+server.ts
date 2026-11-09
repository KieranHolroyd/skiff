import * as z from 'zod';
import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Support impersonation for a pool user (IAM.md I29). An admin with `userPool:impersonate-user`
 * mints a short-lived pool session (at most one hour); it is audited with the admin as `actingFor`
 * and carries `impersonated_by` so the hosted page and the app can show a banner.
 *
 * This is a *pool* session, not a platform session: it authenticates only against the pool's OAuth
 * and hosted pages. Skiff's admin API still requires a platform session, key or STS token, so an
 * impersonated session cannot call it. The remaining risk is an app that does not check
 * `impersonated_by`: to it, support looks exactly like the user, by design.
 */

const bodySchema = z.object({
	/** Seconds; the core caps it at one hour (3600). */
	ttlSeconds: z.number().int().positive().max(3600).optional(),
});

/** Start impersonation. The raw session token is returned once. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const raw = await event.request.json().catch(() => ({}));
		const input = bodySchema.parse(raw);
		const impersonation = core.userPools.impersonateUser(
			principal,
			event.params.id,
			event.params.userId,
			input.ttlSeconds ? { ttlSeconds: input.ttlSeconds } : {},
		);
		const expiresIn = Math.max(
			0,
			Math.round((impersonation.session.expiresAt - core.ctx.now()) / 1000),
		);
		return json(
			{
				token: impersonation.token,
				token_type: 'Bearer',
				expires_in: expiresIn,
				expires_at: impersonation.session.expiresAt,
				user: impersonation.user,
				session: impersonation.session,
				impersonated_by: impersonation.session.impersonatedBy,
			},
			201,
		);
	});

/** End every live impersonation session for the user; normal sessions are untouched. */
export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const result = core.userPools.endImpersonation(
			principal,
			event.params.id,
			event.params.userId,
		);
		return { ok: true, revoked: result.revoked };
	});
