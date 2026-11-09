import type { RequestHandler } from './$types';
import { logDrainUpdateSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One log drain. Header values are write-only; `rotateSigningSecret` returns the new secret once. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { drain: core.logDrains.get(principal, event.params.id) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, logDrainUpdateSchema);
		return core.logDrains.update(principal, event.params.id, input);
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.logDrains.delete(principal, event.params.id);
		return { ok: true };
	});
