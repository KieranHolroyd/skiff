import type { RequestHandler } from './$types';
import { storageKeyCreateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Named storage keys (plan 04b): scoped to buckets, independent of project attachments. No secrets. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { keys: core.storage.listKeys(principal, event.params.name) };
	});

/** Create a key. The secret is not returned here; reveal it with `POST …/keys/:id/reveal`. */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, storageKeyCreateSchema);
		return json({ key: core.storage.createKey(principal, event.params.name, input) }, 201);
	});
