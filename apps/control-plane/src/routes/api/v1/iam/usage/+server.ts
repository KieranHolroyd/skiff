import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Audit-derived permission usage (IAM.md I23, §9.5): per principal and permission, when it was
 * last used and how often in the 30-day window. Reading someone else's usage needs `iam:read`;
 * `?principalId=…` narrows to one principal.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const principalId = event.url.searchParams.get('principalId')?.trim() || undefined;
		return {
			usage: core.governance.usageFor(principal, { principalId }),
			windowDays: 30
		};
	});
