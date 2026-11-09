import type { RequestHandler } from './$types';
import { requirePermission } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** Settings → Access: roles, bindings and groups for the caller's org (IAM.md §12). */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		requirePermission(principal, 'iam:read');
		const org = { type: 'org' as const };
		return {
			version: core.iam.version(principal.orgId),
			roles: core.iam.listRoles(principal.orgId),
			bindings: core.iam.listBindings(principal.orgId),
			groups: core.iam.listGroups(principal.orgId),
			can: {
				manageRoles: core.iam.can(principal, 'iam:manage-roles', org),
				manageBindings: core.iam.can(principal, 'iam:manage-bindings', org),
				manageGroups: core.iam.can(principal, 'iam:manage-groups', org),
			},
		};
	});
