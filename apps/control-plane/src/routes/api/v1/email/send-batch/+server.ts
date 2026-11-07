import * as z from 'zod';
import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Up to 100 messages in one call. Each is accepted or refused on its own (207-style): `results[i]`
 * is the `EmailSendResult` for `messages[i]` or `{ error: { code, message } }`. Core validates the body.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const body = await readJson(event.request, z.unknown());
		return { results: await core.email.sendBatch(principal, body) };
	});
