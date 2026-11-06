import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Alerts overview (docs/ALERTS.md): active series, counts, channels and the caller's abilities. */
export const GET: RequestHandler = (event) => route(() => core.alerts.overview(requirePrincipal(event)));
