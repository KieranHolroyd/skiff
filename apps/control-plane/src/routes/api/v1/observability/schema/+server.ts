import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Datasets, tables (SQL users) and id → name maps for the dashboard builder (D101). */
export const GET: RequestHandler = (event) =>
	route(() => core.observability.schema(requirePrincipal(event)));
