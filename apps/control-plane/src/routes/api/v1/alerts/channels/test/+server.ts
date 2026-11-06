import type { RequestHandler } from './$types';
import * as z from 'zod';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const testSchema = z.object({ channel: z.string().min(1).max(64).optional() });

/** Send a test alert through one channel (or all); returns the per-channel outcome. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, testSchema);
		return { delivery: await core.alerts.testChannel(principal, input.channel) };
	});
