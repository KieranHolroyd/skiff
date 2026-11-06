import type { RequestHandler } from './$types';
import { systemAlertsUpdateSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Built-in alerts: on/off, channels and thresholds per kind (platform admins read, owner writes). */
export const GET: RequestHandler = (event) =>
	route(() => core.alerts.systemAlerts(requirePrincipal(event)));

export const PUT: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, systemAlertsUpdateSchema);
		return core.alerts.updateSystemAlerts(principal, input);
	});
