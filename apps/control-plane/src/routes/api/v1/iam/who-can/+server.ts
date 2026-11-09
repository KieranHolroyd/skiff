import type { RequestHandler } from './$types';
import { isPermission } from '@yoal/contracts';
import { ForbiddenError, ValidationError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { resourceFromQuery } from '#lib/server/iam-resource.js';

/** "Who can do Y on Z?" (IAM.md §9.3, I12). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		if (!core.iam.can(principal, 'iam:read', { type: 'org' }))
			throw new ForbiddenError('iam:read');
		const permission = event.url.searchParams.get('permission') ?? '';
		if (!isPermission(permission)) throw new ValidationError(`"${permission}" is not a permission.`);
		return {
			permission,
			principals: core.iam.whoCan(principal.orgId, permission, resourceFromQuery(event.url)),
		};
	});
