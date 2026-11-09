import { fail } from '@sveltejs/kit';
import { destructivePermissions, isPermission } from '@skiff/contracts';
import { CONNECTED_APPS_ORG_PERMISSION, type ConnectedApp } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

const destructive = new Set<string>(destructivePermissions);

/** What the table needs: permission scopes split from the sign-in ones, destructive ones counted. */
function summary(app: ConnectedApp) {
	const permissions = app.scopes.filter(isPermission);
	return {
		id: app.id,
		clientId: app.clientId,
		name: app.name,
		uri: app.uri,
		registration: app.registration,
		permissions,
		identityScopes: app.scopes.filter((scope) => !isPermission(scope)),
		destructive: permissions.filter((scope) => destructive.has(scope)).length,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
		lastUsedAt: app.lastUsedAt,
		activeRefreshTokens: app.activeRefreshTokens,
		user: app.user
	};
}

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	const canManageOrg = principal.permissions.has(CONNECTED_APPS_ORG_PERMISSION);
	const mine = core.connectedApps.list(principal).map(summary);
	// Other members' grants, for owners and admins; an admin may not revoke an owner's.
	const others = canManageOrg
		? core.connectedApps
				.list(principal, { scope: 'org' })
				.filter((app) => app.user.id !== principal.userId)
				.map((app) => ({
					...summary(app),
					canRevoke: app.user.role !== 'owner' || principal.permissions.has('iam:manage-owners')
				}))
		: [];
	return { mine, others, canManageOrg };
};

export const actions: Actions = {
	revoke: async ({ request, locals }) => {
		const id = formString(await request.formData(), 'grantId');
		if (!id) return fail(400, { message: 'Missing connected app id.' });
		try {
			await core.connectedApps.revoke(locals.principal!, id);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: 'Disconnected. Its next request is refused until it is approved again.' };
	}
};
