import * as z from 'zod';
import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Access keys for one service account (IAM.md I13–I14, §7.2). `serviceAccount:manage-keys` covers
 * all three operations. `POST` returns the raw `yoal_…` key exactly once; every later read carries
 * only its `start`. Key creation and revocation are the generic `AccessKeyService` paths, bound to
 * this account's id and the caller's org.
 */

const createSchema = z.object({
	name: z.string().trim().min(1).max(100),
	permissions: z.array(z.string().min(1).max(100)).max(500).optional(),
	resources: z.array(z.string().min(1).max(200)).max(256).optional(),
	expiresInSeconds: z.number().int().positive().optional(),
	allowedCidrs: z.array(z.string().min(1).max(64)).max(32).optional(),
});

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		// Resolve the account first, so a key list can never cross an org boundary.
		core.serviceAccounts.get(principal, event.params.id);
		return { accessKeys: core.ctx.accessKeys.list(principal, { principalId: event.params.id }) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		core.serviceAccounts.get(principal, event.params.id);
		const input = await readJson(event.request, createSchema);
		const created = core.ctx.accessKeys.create(principal, {
			...input,
			principalType: 'serviceAccount',
			principalId: event.params.id,
		});
		return json(created, 201);
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		core.serviceAccounts.get(principal, event.params.id);
		const keyId = event.url.searchParams.get('keyId')?.trim();
		if (!keyId) {
			return json(
				{ error: 'validation', message: 'Name the key to revoke with ?keyId=…' },
				400,
			);
		}
		// Check ownership before revoking: the generic revoke path only knows the key id.
		const keys = core.ctx.accessKeys.list(principal, { principalId: event.params.id });
		if (!keys.some((key) => key.id === keyId)) {
			return json(
				{ error: 'not_found', message: 'That key does not belong to this service account.' },
				404,
			);
		}
		const revoked = core.ctx.accessKeys.revoke(principal, keyId);
		return { ok: true, accessKey: revoked };
	});
