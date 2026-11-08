import * as z from 'zod';
import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Email → Mail server: choose (or clear) the mail node, its IPv4, the mail domain and the global pause. Platform admin session only. */
const settingsSchema = z.object({
	nodeId: z.string().min(1).nullable().optional(),
	ip: z.string().trim().max(15).nullable().optional(),
	paused: z.boolean().optional(),
	/** A custom domain or URL for the mail hostnames; null puts them back on the content domain. */
	mailDomain: z.string().trim().max(2048).nullable().optional()
});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, settingsSchema);
		return { settings: await core.email.configure(principal, input) };
	});
