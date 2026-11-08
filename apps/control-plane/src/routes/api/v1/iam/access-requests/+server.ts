import type { RequestHandler } from './$types';
import * as z from 'zod';
import type { ScopeRef } from '@skiff/contracts';
import { MAX_DURATION_SECONDS, REQUEST_TTL_SECONDS } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const scope = z.object({
	type: z.string().min(1),
	id: z.string().min(1).optional(),
	projectId: z.string().min(1).optional()
});

const status = z.enum(['pending', 'approved', 'denied', 'cancelled', 'expired']);

const createRequest = z.object({
	roleId: z.string().min(1).max(80),
	scope,
	durationSeconds: z.number().int().min(60).max(MAX_DURATION_SECONDS),
	reason: z.string().min(3).max(500),
	changeRef: z.string().max(200).optional()
});

/**
 * Just-in-time access (IAM.md I22, §9.4). Anyone in the org may ask; only an approver who is not
 * the requester, with `iam:manage-bindings` at the scope, may decide. `GET` returns the caller's
 * requests plus the ones they may decide.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const raw = event.url.searchParams.get('status');
		const parsed = raw ? status.safeParse(raw) : undefined;
		return {
			requests: core.governance.list(principal, {
				status: parsed?.success ? parsed.data : undefined
			}),
			limits: {
				maxDurationSeconds: MAX_DURATION_SECONDS,
				requestTtlSeconds: REQUEST_TTL_SECONDS
			}
		};
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, createRequest);
		return json(
			core.governance.request(principal, {
				...input,
				scope: input.scope as ScopeRef
			}),
			201
		);
	});
