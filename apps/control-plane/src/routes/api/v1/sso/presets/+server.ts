import type { RequestHandler } from './$types';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { describeSsoPresets } from '#lib/sso-presets.js';

/**
 * The ready-made identity provider set-ups (IAM.md §8.3, D180): which values each needs and the
 * steps at the IdP. Pass `{ preset: { id, values } }` to `POST /api/v1/sso/providers` instead of
 * an issuer.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		requirePrincipal(event);
		return { presets: describeSsoPresets() };
	});
