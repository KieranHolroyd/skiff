import type { RequestHandler } from './$types';
import { isPermission, requirePermission } from '@yoal/contracts';
import { ValidationError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { resourceFromQuery } from '#lib/server/iam-resource.js';

/** "Why can (or can't) I?" (IAM.md §9.3, I12). Explains the caller. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		requirePermission(principal, 'iam:read');
		const permission = event.url.searchParams.get('permission') ?? '';
		if (!isPermission(permission)) throw new ValidationError(`"${permission}" is not a permission.`);
		return core.iam.explain(principal, permission, resourceFromQuery(event.url));
	});
