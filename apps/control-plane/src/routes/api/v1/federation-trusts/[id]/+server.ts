import * as z from 'zod';
import type { RequestHandler } from './$types';
import type { FederationRestriction } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** One federation trust. Deleting it stops new exchanges; tokens already minted keep their TTL. */

const restriction = z.object({
	permissions: z.array(z.string().trim().min(1).max(100)).max(500).optional(),
	resources: z.array(z.string().trim().min(1).max(200)).max(256).optional(),
});

const updateSchema = z.object({
	serviceAccountId: z.string().trim().min(1).max(100).optional(),
	issuer: z.string().trim().min(1).max(2048).optional(),
	audiences: z.array(z.string().trim().min(1).max(512)).min(1).max(32).optional(),
	subjectPattern: z.string().trim().min(1).max(512).optional(),
	claimConditions: z.record(z.string(), z.unknown()).optional(),
	maxTtlSeconds: z.number().int().positive().max(3600).optional(),
	restriction: restriction.optional(),
});

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { federationTrust: core.federation.get(principal, event.params.id) };
	});

export const PATCH: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, updateSchema);
		return {
			federationTrust: core.federation.update(principal, event.params.id, {
				...input,
				restriction: input.restriction as FederationRestriction | undefined
			})
		};
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.federation.delete(principal, event.params.id);
		return { ok: true };
	});
