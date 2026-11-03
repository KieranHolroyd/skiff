import { error, redirect } from '@sveltejs/kit';
import { hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { contentDomain, platformOrigin, sharedDomain } from '#lib/server/config.js';
import type { LayoutServerLoad } from './$types';

/**
 * The dashboard auth guard. Every page below this layout can assume a principal exists;
 * unauthenticated visitors are sent back here after signing in.
 */
export const load: LayoutServerLoad = ({ locals, url, cookies }) => {
	const principal = locals.principal;
	if (!principal && locals.user) {
		// Signed in, but not a member of any org yet (invite-only, D10).
		error(
			403,
			'You are signed in but not a member of any organization yet. Open the invitation link from your email to join one.'
		);
	}
	if (!principal) {
		const redirectTo = `${url.pathname}${url.search}`;
		redirect(303, `/login?redirect=${encodeURIComponent(redirectTo)}`);
	}

	let org: { name: string; slug: string } | null = null;
	try {
		org = core.ctx.sqlite
			.query<{ name: string; slug: string }, [string]>(
				'SELECT name, slug FROM organization WHERE id = ?'
			)
			.get(principal.orgId);
	} catch {
		// The auth tables are not ready yet during first boot; the shell can still render.
	}

	const platformHostname = new URL(platformOrigin).hostname;
	return {
		user: {
			id: principal.userId,
			name: locals.user?.name || locals.user?.email?.split('@')[0] || 'Account',
			email: locals.user?.email ?? null
		},
		org: {
			id: principal.orgId,
			name: org?.name ?? 'Personal',
			slug: org?.slug ?? null
		},
		role: principal.role,
		permissions: [...principal.permissions].sort(),
		can: {
			createProject: hasPermission(principal, 'project:create'),
			updateProject: hasPermission(principal, 'project:update'),
			deleteProject: hasPermission(principal, 'project:delete'),
			createDeployment: hasPermission(principal, 'deployment:create'),
			promote: hasPermission(principal, 'deployment:promote'),
			rollback: hasPermission(principal, 'deployment:rollback'),
			deleteDeployment: hasPermission(principal, 'deployment:delete'),
			createShareLink: hasPermission(principal, 'shareLink:create'),
			revokeShareLink: hasPermission(principal, 'shareLink:revoke'),
			createBuild: hasPermission(principal, 'build:create'),
			cancelBuild: hasPermission(principal, 'build:cancel'),
			createDomain: hasPermission(principal, 'domain:create'),
			deleteDomain: hasPermission(principal, 'domain:delete'),
			createSecret: hasPermission(principal, 'secret:create'),
			deleteSecret: hasPermission(principal, 'secret:delete'),
			manageWorkload: hasPermission(principal, 'project:update'),
			manageNodes: principal.platformAdmin === true,
			viewCapacity: principal.platformAdmin === true,
			manageApiKeys: hasPermission(principal, 'apiKey:create'),
			seeMemberEmails: principal.role === 'owner' || principal.role === 'admin'
		},
		platform: {
			origin: platformOrigin,
			hostname: platformHostname
		},
		contentDomain,
		/** shadcn sidebar persists its collapsed state in this cookie. */
		sidebarOpen: cookies.get('sidebar_state') !== 'false',
		/** Shared-domain mode is warned about persistently (DESIGN §5, D19). */
		sharedDomain
	};
};
