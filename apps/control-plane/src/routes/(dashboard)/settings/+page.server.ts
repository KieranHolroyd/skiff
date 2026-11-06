import { fail } from '@sveltejs/kit';
import { destructivePermissions, statements, type Permission } from '@skiff/contracts';
import { renameOrganization } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../_lib/errors.js';
import { RESOURCE_LABELS } from './_lib/resources.js';
import type { Actions, PageServerLoad } from './$types';

function iso(value: unknown): string | null {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string' && value.length > 0) return value;
	if (typeof value === 'number') return new Date(value).toISOString();
	return null;
}

/**
 * Settings → General: the organisation, a glance at its people, and the full permission table
 * for the viewer's role (the page "View your role" links point at). API keys moved to their own
 * section (Settings → API keys).
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;

	let org: { id: string; name: string; slug: string; createdAt: string } | null = null;
	let members: Array<{ userId: string; role: string; name: string }> = [];
	try {
		org = core.ctx.sqlite
			.query<{ id: string; name: string; slug: string; createdAt: string }, [string]>(
				'SELECT id, name, slug, createdAt FROM organization WHERE id = ?'
			)
			.get(principal.orgId);
		members = core.ctx.sqlite
			.query<{ userId: string; role: string; name: string }, [string]>(
				`SELECT m.userId AS userId, m.role AS role, u.name AS name
				 FROM member m LEFT JOIN user u ON u.id = m.userId
				 WHERE m.organizationId = ?
				 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'deployer' THEN 2 ELSE 3 END, u.name ASC`
			)
			.all(principal.orgId)
			.map((row) => ({ userId: row.userId, role: row.role, name: row.name || row.userId }));
	} catch {
		// Auth tables may not exist during first boot; the page still renders.
	}

	const destructive = new Set<string>(destructivePermissions);
	const access = Object.entries(statements).map(([resource, actions]) => ({
		resource,
		label: RESOURCE_LABELS[resource] ?? resource,
		actions: actions.map((action) => {
			const permission = `${resource}:${action}` as Permission;
			return {
				action,
				held: principal.permissions.has(permission),
				destructive: destructive.has(permission)
			};
		})
	}));

	return {
		org: org
			? { ...org, createdAt: iso(org.createdAt) }
			: { id: principal.orgId, name: 'Personal', slug: null, createdAt: null },
		members,
		access,
		heldCount: principal.permissions.size,
		totalCount: access.reduce((sum, group) => sum + group.actions.length, 0),
		platformAdmin: principal.platformAdmin === true,
		/** Owners and admins may rename the org (Better Auth grants both `organization:update`). */
		canRename:
			principal.kind === 'user' && (principal.role === 'owner' || principal.role === 'admin')
	};
};

export const actions: Actions = {
	rename: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const input = { name: formString(data, 'name'), slug: formString(data, 'slug') };
		try {
			const saved = renameOrganization(core.ctx.sqlite, principal, input);
			core.ctx.audit.record({
				principal,
				action: 'org.rename',
				resource: 'organization',
				resourceId: principal.orgId,
				args: saved,
				result: 'ok'
			});
			return { success: 'Organisation renamed.' };
		} catch (cause) {
			return fail(failStatus(cause), toFormFailure(cause));
		}
	}
};
