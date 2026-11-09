import { error, fail } from '@sveltejs/kit';
import type {
	UserPoolClientView,
	UserPoolGroupMemberView,
	UserPoolGroupView,
	UserPoolOAuthProviderView
} from '@yoal/contracts';
import type { UserPoolUserView } from '@yoal/core';
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
	const oauthProviders: Record<string, UserPoolOAuthProviderView[]> = {};
	const access: Record<
		string,
		{
			update: boolean;
			credentials: boolean;
			delete: boolean;
			manageUsers: boolean;
			impersonate: boolean;
		}
	> = {};
	for (const pool of pools) {
		clients[pool.id] = core.userPools.listClients(principal, pool.id);
		const resource = { type: 'userPool' as const, id: pool.id };
		const manageUsers = core.iam.can(principal, 'userPool:manage-users', resource);
		access[pool.id] = {
			update: core.iam.can(principal, 'userPool:update', resource),
			credentials: core.iam.can(principal, 'userPool:credentials', resource),
			delete: core.iam.can(principal, 'userPool:delete', resource),
			manageUsers,
			impersonate: core.iam.can(principal, 'userPool:impersonate-user', resource)
		};
		if (access[pool.id]!.credentials)
			oauthProviders[pool.id] = core.userPools.listOAuthProviders(principal, pool.id);
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
		oauthProviders,
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

	/** Toggle the Have I Been Pwned check for new and reset passwords. */
	setPoolBreachCheck: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		if (!poolId) return fail(400, { message: 'Missing user pool id.' });
		try {
			const enabled = formBoolean(data, 'breachCheckEnabled');
			await core.userPools.update(principal, poolId, { breachCheckEnabled: enabled });
			return { success: enabled ? 'Breached-password checks are on.' : 'Breached-password checks are off.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	/**
	 * Import a pool export or an Auth0/Cognito/Firebase user export. A dry run returns the same
	 * report without touching a row; the dialog shows it and asks before applying.
	 */
	importPool: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		if (!poolId) return fail(400, { message: 'Missing user pool id.' });
		const upload = data.get('file');
		let payload = formString(data, 'data');
		if (upload instanceof File && upload.size > 0) payload = await upload.text();
		if (!payload.trim()) return fail(400, { message: 'Choose a file or paste an export.' });
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload) as unknown;
		} catch {
			// Cognito's CSV export is text; the service recognises it. Anything else fails there.
			parsed = payload;
		}
		const format = formString(data, 'format');
		try {
			const report = await core.userPools.importPool(principal, poolId, {
				format: (format || 'auto') as 'auto' | 'yoal' | 'auth0' | 'cognito' | 'firebase',
				dryRun: formBoolean(data, 'dryRun'),
				data: parsed
			});
			return {
				success: report.dryRun
					? `Dry run: ${report.users.create} user(s) would be imported, ${report.users.skip} skipped.`
					: `Imported ${report.users.create} user(s); ${report.users.mustResetPassword} must reset their password.`,
				report
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	/** Store one social provider. The secret field is optional: blank keeps the sealed one. */
	saveOAuthProvider: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const provider = formString(data, 'provider');
		const clientId = formString(data, 'clientId');
		if (!poolId || !provider || !clientId)
			return fail(400, { message: 'Choose a provider and enter its client id.' });
		const clientSecret = formOptionalString(data, 'clientSecret');
		const scopes = formString(data, 'scopes')
			.split(/[\s,]+/)
			.map((scope) => scope.trim())
			.filter(Boolean);
		try {
			const view = core.userPools.setOAuthProvider(principal, poolId, provider, {
				clientId,
				...(clientSecret ? { clientSecret } : {}),
				scopes,
				enabled: formBoolean(data, 'enabled')
			});
			return {
				success: view.enabled
					? `${view.label} sign-in is enabled.`
					: `${view.label} configuration saved; sign-in is off.`
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	deleteOAuthProvider: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const provider = formString(data, 'provider');
		if (!poolId || !provider) return fail(400, { message: 'Missing pool or provider.' });
		try {
			core.userPools.deleteOAuthProvider(principal, poolId, provider);
			return { success: 'Social provider removed.' };
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
	},

	/** Start a support-impersonation session (IAM.md I29); the token is returned once. */
	impersonateUser: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const userId = formString(data, 'userId');
		if (!poolId || !userId) return fail(400, { message: 'Missing pool or user id.' });
		const ttlText = formOptionalString(data, 'ttlSeconds');
		const ttlSeconds = ttlText ? Number(ttlText) : undefined;
		if (ttlText && (!Number.isInteger(ttlSeconds) || (ttlSeconds ?? 0) <= 0))
			return fail(400, { message: 'The impersonation lifetime must be a positive number of seconds.' });
		try {
			const impersonation = core.userPools.impersonateUser(principal, poolId, userId, {
				...(ttlSeconds ? { ttlSeconds } : {})
			});
			return {
				success: `Impersonation session for ${impersonation.user.email} started. It ends on its own, or use Stop impersonation.`,
				impersonation: {
					userId: impersonation.user.id,
					email: impersonation.user.email,
					token: impersonation.token,
					expiresAt: impersonation.session.expiresAt,
					impersonatedBy: impersonation.session.impersonatedBy
				}
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	/** End support impersonation for one user; their own normal sessions stay signed in. */
	endImpersonation: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const poolId = formString(data, 'poolId');
		const userId = formString(data, 'userId');
		if (!poolId || !userId) return fail(400, { message: 'Missing pool or user id.' });
		try {
			const result = core.userPools.endImpersonation(principal, poolId, userId);
			return {
				success:
					result.revoked > 0
						? `Ended ${result.revoked} impersonation session${result.revoked === 1 ? '' : 's'}.`
						: 'That user has no active impersonation session.'
			};
		} catch (cause) {
			return failure(cause);
		}
	}
};
