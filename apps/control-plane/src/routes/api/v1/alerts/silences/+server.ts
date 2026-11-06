import type { RequestHandler } from './$types';
import { alertSilenceCreateSchema, type AlertSilenceCreateInput } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Active and upcoming silences; `?expired=1` adds those that ended in the last 30 days. */
export const GET: RequestHandler = (event) =>
	route(() => ({
		silences: core.alerts.listSilences(requirePrincipal(event), {
			includeExpired: event.url.searchParams.get('expired') === '1'
		})
	}));

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = (await readJson(event.request, alertSilenceCreateSchema)) as AlertSilenceCreateInput;
		return json({ silence: core.alerts.createSilence(principal, input) }, 201);
	});
