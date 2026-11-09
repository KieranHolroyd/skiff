import * as z from 'zod';
import type { RequestHandler } from './$types';
import type { FederationRestriction } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Federation trusts (IAM.md I17, §7.3, §12). A trust maps an OIDC issuer to one org-owned service
 * account; the STS endpoint reads the rows. Every check and all validation lives in
 * `core.federation`, so REST, the dashboard and the CLI share one behaviour.
 */

const restriction = z.object({
	permissions: z.array(z.string().trim().min(1).max(100)).max(500).optional(),
	resources: z.array(z.string().trim().min(1).max(200)).max(256).optional(),
});

const createSchema = z.object({
	serviceAccountId: z.string().trim().min(1).max(100),
	issuer: z.string().trim().min(1).max(2048),
	audiences: z.array(z.string().trim().min(1).max(512)).min(1).max(32),
	subjectPattern: z.string().trim().min(1).max(512).optional(),
	claimConditions: z.record(z.string(), z.unknown()).optional(),
	maxTtlSeconds: z.number().int().positive().max(3600).optional(),
	restriction: restriction.optional(),
});

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { federationTrusts: core.federation.list(principal) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createSchema);
		return json(
			core.federation.create(principal, {
				...input,
				restriction: input.restriction as FederationRestriction | undefined
			}),
			201,
		);
	});
