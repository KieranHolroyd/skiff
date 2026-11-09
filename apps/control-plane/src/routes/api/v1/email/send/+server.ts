import type { RequestHandler } from './$types';
import { emailSendSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Accept one message for delivery (EMAIL.md §5, D117). 202: it is in the outbox, not delivered;
 * follow `GET /email/messages/:id`. Policy refusals are 403 (paused), 422 or 429 (rate/quota).
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, emailSendSchema);
		return json(await core.email.send(principal, input), 202);
	});
