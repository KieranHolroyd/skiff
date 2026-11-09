import { error, fail } from '@sveltejs/kit';
import type {
	UserPoolClientView,
	UserPoolGroupMemberView,
	UserPoolGroupView
} from '@skiff/contracts';
import type { UserPoolUserView } from '@skiff/core';
import { core } from '#lib/server/core.js';
import {
	failStatus,
	formBoolean,
	formOptionalString,
	formString,
	toFormFailure
} from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → User pools (IAM.md I26–I29, §11.2): user pools, their OIDC clients and the public
 * discovery/JWKS URLs. The hosted sign-in UI, users, sessions and MFA are not built yet and are
 * listed as such rather than faked. Every write goes through `core.userPools`.
 */

function failure(cause: unknown) {
	return fail(failStatus(cause), toFormFailure(cause));
}

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!core.userPools.canReadAny(principal))
		error(403, 'You need permission to read user pools.');

	const pools = core.userPools.list(principal);
	const clients: Record<string, UserPoolClientView[]> = {};
	const users: Record<string, UserPoolUserView[]> = {};
	const groups: Record<string, UserPoolGroupView[]> = {};
	const groupMembers: Record<string, UserPoolGroupMemberView[]> = {};
	const access: Record<
		string,
		{ update: boolean; credentials: boolean; delete: boolean; manageUsers: boolean }
	> = {};
	for (const pool of pools) {
		clients[pool.id] = core.userPools.listClients(principal, pool.id);
		const resource = { type: 'userPool' as const, id: pool.id };
		const manageUsers = core.iam.can(principal, 'userPool:manage-users', resource);
		access[pool.id] = {
			update: core.iam.can(principal, 'userPool:update', resource),
			credentials: core.iam.can(principal, 'userPool:credentials', resource),
			delete: core.iam.can(principal, 'userPool:delete', resource),
			manageUsers
		};
		if (manageUsers) {
			users[pool.id] = core.userPools.listUsers(principal, pool.id);
			groups[pool.id] = core.userPools.listGroups(principal, pool.id);
			for (const group of groups[pool.id]!)
				groupMembers[group.id] = core.userPools.listGroupMembers(principal, pool.id, group.id);
		}
	}

	return {
		pools,
		clients,
		users,
		groups,
		groupMembers,
		access,
		canCreate: core.iam.can(principal, 'userPool:create', { type: 'org' }),
		discoveryBase: `${core.ctx.config.platformOrigin}/api/v1/user-pools`
	};
};

export const actions: Actions = {
	createPool: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const description = formOptionalString(data, 'description');
		try {
			const pool = await core.userPools.create(principal, {
				name: formString(data, 'name'),
				...(description ? { description } : {}),
				signupMode: formString(data, 'signupMode') === 'open' ? 'open' : 'invite'
			});
			return { success: `Created the ${pool.name} user pool.` };
		} catch (cause) {
			return failure(cause);
		}
	},

	setPoolDisabled: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		if (!poolId) return fail(400, { message: 'Missing user pool id.' });
		try {
			await core.userPools.update(principal, poolId, {
				disabled: formBoolean(data, 'disabled')
			});
			return { success: formBoolean(data, 'disabled') ? 'User pool disabled.' : 'User pool enabled.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	createClient: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		if (!poolId) return fail(400, { message: 'Missing user pool id.' });
		const redirectUris = formString(data, 'redirectUris')
			.split(/[\s,]+/)
			.map((uri) => uri.trim())
			.filter(Boolean);
		try {
			const created = core.userPools.createClient(principal, poolId, {
				name: formString(data, 'name'),
				redirectUris,
				public: formBoolean(data, 'public')
			});
			return {
				success: `Created the ${created.client.name} client. Copy its secret now; it is shown once.`,
				created
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	deleteClient: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const clientId = formString(data, 'clientId');
		if (!poolId || !clientId) return fail(400, { message: 'Missing pool or client id.' });
		try {
			core.userPools.deleteClient(principal, poolId, clientId);
			return { success: 'Client removed.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	setPoolMfaRequired: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		if (!poolId) return fail(400, { message: 'Missing user pool id.' });
		try {
			const required = formBoolean(data, 'mfaRequired');
			await core.userPools.update(principal, poolId, { mfaRequired: required });
			return { success: required ? 'MFA is now required.' : 'MFA is now optional.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	createGroup: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const name = formString(data, 'name');
		if (!poolId || !name) return fail(400, { message: 'Missing pool or group name.' });
		try {
			const group = core.userPools.createGroup(principal, poolId, name);
			return { success: `Created the ${group.name} group.` };
		} catch (cause) {
			return failure(cause);
		}
	},

	deleteGroup: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const groupId = formString(data, 'groupId');
		if (!poolId || !groupId) return fail(400, { message: 'Missing pool or group id.' });
		try {
			core.userPools.deleteGroup(principal, poolId, groupId);
			return { success: 'Group removed.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	addGroupMember: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const groupId = formString(data, 'groupId');
		const userId = formString(data, 'userId');
		if (!poolId || !groupId || !userId)
			return fail(400, { message: 'Choose a group and a user.' });
		try {
			core.userPools.addGroupMember(principal, poolId, groupId, userId);
			return { success: 'Member added.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	removeGroupMember: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const groupId = formString(data, 'groupId');
		const userId = formString(data, 'userId');
		if (!poolId || !groupId || !userId)
			return fail(400, { message: 'Missing pool, group or member.' });
		try {
			core.userPools.removeGroupMember(principal, poolId, groupId, userId);
			return { success: 'Member removed.' };
		} catch (cause) {
			return failure(cause);
		}
	}
};
