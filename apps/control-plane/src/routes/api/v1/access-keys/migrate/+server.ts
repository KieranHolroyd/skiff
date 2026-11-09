import * as z from 'zod';
import type { RequestHandler } from './$types';
import { ForbiddenError } from '@yoal/core';
import { canMaintainPlatform } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * One-time Better Auth `apikey` → `access_keys` migration (IAM.md I14, §14 S1). The service keeps
 * every hash verbatim (`hash_scheme = 'better-auth'`), so old `yoal_…` keys keep working without a
 * reissue, and leaves `apikey` untouched as the fallback. Idempotent by hash.
 *
 * A platform administrator may migrate every org or pass `orgId`; `accessKey:read-all` may migrate
 * its own org only. The CLI surface is `yoal iam migrate-keys`.
 */

const migrateSchema = z.object({
	orgId: z.string().trim().min(1).max(128).optional(),
});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		if (!canMaintainPlatform(principal) && !principal.permissions.has('accessKey:read-all'))
			throw new ForbiddenError('accessKey:read-all');
		const input = event.request.body ? await readJson(event.request, migrateSchema) : {};
		const orgId = canMaintainPlatform(principal) ? input.orgId : principal.orgId;
		return json(core.ctx.accessKeys.migrateBetterAuthKeys(orgId, principal));
	});
