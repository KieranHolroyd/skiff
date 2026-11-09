import type { RequestHandler } from './$types';
import { accessServiceTokenTouchSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';

/**
 * Best-effort last-used reporting for a machine token (IAM.md I25, §11.1).
 *
 * This is the one access endpoint an agent may call without a platform session: the edge has only
 * the token's SHA-256, which is already published in desired state, and the only effect is a
 * `last_used_at` timestamp. It never reveals whether a token exists (204 either way) and the core
 * ignores reports more than once a minute. Nothing secret is accepted or returned.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const input = await readJson(event.request, accessServiceTokenTouchSchema);
		core.accessPolicies.touchServiceToken(input.policyId, input.tokenHash);
		return new Response(null, {
			status: 204,
			headers: { 'cache-control': 'no-store' },
		});
	});
