import { error, fail } from '@sveltejs/kit';
import type { UserPoolClientView } from '@skiff/contracts';
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
 * Settings → Identity (IAM.md I26–I29, §11.2): user pools, their OIDC clients and the public
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
	const access: Record<string, { update: boolean; credentials: boolean; delete: boolean }> = {};
	for (const pool of pools) {
		clients[pool.id] = core.userPools.listClients(principal, pool.id);
		const resource = { type: 'userPool' as const, id: pool.id };
		access[pool.id] = {
			update: core.iam.can(principal, 'userPool:update', resource),
			credentials: core.iam.can(principal, 'userPool:credentials', resource),
			delete: core.iam.can(principal, 'userPool:delete', resource)
		};
	}

	return {
		pools,
		clients,
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
	}
};
