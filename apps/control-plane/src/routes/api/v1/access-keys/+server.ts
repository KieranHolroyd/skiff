import * as z from 'zod';
import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Access keys (IAM.md I14, §12). A key is bound to the caller's org and principal. `POST` returns
 * the raw `skif_…` key exactly once; every later read returns only the row view and its `start`.
 */

const createSchema = z.object({
	name: z.string().trim().min(1).max(100),
	principalType: z.enum(['user', 'serviceAccount']).optional(),
	principalId: z.string().trim().min(1).max(100).optional(),
	permissions: z.array(z.string().min(1).max(100)).max(500).optional(),
	resources: z.array(z.string().min(1).max(200)).max(256).optional(),
	expiresInSeconds: z.number().int().positive().optional(),
	allowedCidrs: z.array(z.string().min(1).max(64)).max(32).optional(),
});

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const principalId = event.url.searchParams.get('principalId')?.trim() || undefined;
		return { accessKeys: core.ctx.accessKeys.list(principal, { principalId }) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createSchema);
		const created = core.ctx.accessKeys.create(principal, input);
		return json(created, 201);
	});
