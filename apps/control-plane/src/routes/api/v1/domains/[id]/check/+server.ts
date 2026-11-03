import { route } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import { requirePrincipal } from '#lib/server/principal.js';
import type { RequestHandler } from './$types';

/** Re-read TXT and CNAME/A records; `detail`/`records` tell the operator what is still missing. */
export const POST: RequestHandler = (event) =>
	route(() => core.domains.check(requirePrincipal(event), event.params.id));
