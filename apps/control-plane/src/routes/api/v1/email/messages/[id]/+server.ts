import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One message with every recipient's latest status and SMTP response. */
export const GET: RequestHandler = (event) =>
	route(() => ({ message: core.email.getMessage(requirePrincipal(event), event.params.id) }));
