import { redirect } from '@sveltejs/kit';
import { defaultAgentScopes, destructivePermissions, isPermission } from '@skiff/contracts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, `/login?${url.searchParams}`);
	const requested = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
	return {
		clientId: url.searchParams.get('client_id') ?? '',
		scopes: requested.map((scope) => ({
			scope,
			permission: isPermission(scope),
			destructive: (destructivePermissions as readonly string[]).includes(scope),
			// Pre-tick identity scopes and deployer-level permissions; destructive ones stay unticked.
			checked: !isPermission(scope) || (defaultAgentScopes as readonly string[]).includes(scope)
		}))
	};
};
