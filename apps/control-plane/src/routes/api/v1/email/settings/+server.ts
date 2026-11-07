import * as z from 'zod';
import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Settings → Email: choose (or clear) the mail node and the global pause. Platform admin session only. */
const settingsSchema = z.object({
	nodeId: z.string().min(1).nullable().optional(),
	paused: z.boolean().optional()
});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, settingsSchema);
		return { settings: await core.email.configure(principal, input) };
	});
