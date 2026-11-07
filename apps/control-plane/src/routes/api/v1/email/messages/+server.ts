import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The message log, newest first: `?limit (≤200)&before=<ISO time>&recipient=<address>&status=<event kind>`. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const params = event.url.searchParams;
		const limit = Number(params.get('limit') ?? 50);
		return {
			messages: core.email.listMessages(principal, {
				...(Number.isFinite(limit) ? { limit } : {}),
				...(params.get('before') ? { before: params.get('before')! } : {}),
				...(params.get('recipient') ? { recipient: params.get('recipient')! } : {}),
				...(params.get('status') ? { status: params.get('status')! } : {})
			})
		};
	});
