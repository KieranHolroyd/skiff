import type { RequestHandler } from './$types';
import {
	platformRoleDescriptions,
	platformRoleIds,
	platformRoles,
} from '@skiff/contracts';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The three built-in platform roles and their permissions (IAM.md I24, §10). */
export const GET: RequestHandler = (event) =>
	route(() => {
		requirePrincipal(event);
		return {
			roles: platformRoleIds.map((id) => ({
				id,
				description: platformRoleDescriptions[id],
				permissions: platformRoles[id],
			})),
		};
	});
