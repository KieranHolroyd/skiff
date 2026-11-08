import { error, fail } from '@sveltejs/kit';
import { permissionCatalog, type Permission, type ScopeRef } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formOptionalString, formString, toFormFailure } from '../../_lib/errors.js';
import { RESOURCE_LABELS } from '../_lib/resources.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Access (IAM.md §12): the org's roles, bindings and groups, plus an explain panel.
 * Every write goes through `core.iam`, which checks `iam:manage-*` and audits the change.
 */

const PRINCIPAL_TYPES = ['user', 'group', 'serviceAccount'] as const;
const SCOPE_TYPES = ['org', 'project', 'environment'] as const;

interface MemberOption {
	userId: string;
	name: string;
	email: string | null;
}

function pick<T extends string>(value: string, choices: readonly T[]): T | undefined {
	return (choices as readonly string[]).includes(value) ? (value as T) : undefined;
}

function isMember(orgId: string, userId: string): boolean {
	return Boolean(
		core.ctx.sqlite
			.query('SELECT 1 FROM member WHERE organizationId = ? AND userId = ? LIMIT 1')
			.get(orgId, userId)
	);
}

/** `datetime-local` value → epoch ms. `invalid` and `past` are reported as field errors. */
function futureTime(value: string): number | 'invalid' | 'past' | undefined {
	if (!value) return undefined;
	const at = new Date(value).getTime();
	if (!Number.isFinite(at)) return 'invalid';
	if (at <= Date.now()) return 'past';
	return at;
}

function failure(cause: unknown) {
	return fail(failStatus(cause), toFormFailure(cause));
}

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	const org = { type: 'org' as const };
	if (!core.iam.can(principal, 'iam:read', org))
		error(403, 'You need permission to read access settings.');

	const showEmails = principal.permissions.has('member:update-role');
	let members: MemberOption[] = [];
	const groupMembers: Record<string, MemberOption[]> = {};

	try {
		members = core.ctx.sqlite
			.query<{ userId: string; name: string | null; email: string | null }, [string]>(
				`SELECT m.userId AS userId, u.name AS name, u.email AS email
				 FROM member m LEFT JOIN user u ON u.id = m.userId
				 WHERE m.organizationId = ?
				 ORDER BY COALESCE(u.name, u.email, m.userId) COLLATE NOCASE`
			)
			.all(principal.orgId)
			.map((row) => ({
				userId: row.userId,
				name: row.name || row.email || row.userId,
				email: showEmails ? row.email : null
			}));

		const rows = core.ctx.sqlite
			.query<
				{ groupId: string; userId: string; name: string | null; email: string | null },
				[string]
			>(
				`SELECT m.group_id AS groupId, m.user_id AS userId, u.name AS name, u.email AS email
				 FROM iam_group_members m
				 JOIN iam_groups g ON g.id = m.group_id
				 LEFT JOIN user u ON u.id = m.user_id
				 WHERE g.org_id = ?
				 ORDER BY COALESCE(u.name, u.email, m.user_id) COLLATE NOCASE`
			)
			.all(principal.orgId);
		for (const row of rows) {
			const list = groupMembers[row.groupId] ?? [];
			list.push({
				userId: row.userId,
				name: row.name || row.email || row.userId,
				email: showEmails ? row.email : null
			});
			groupMembers[row.groupId] = list;
		}
	} catch {
		// Better Auth tables may not exist during first boot; the IAM page still renders.
	}

	let projects: Array<{
		id: string;
		slug: string;
		name: string;
		environments: Array<{ id: string; name: string; slug: string }>;
	}> = [];
	try {
		projects = core.projects.list(principal).map((project) => ({
			id: project.id,
			slug: project.slug,
			name: project.name,
			environments: core.environments.rows(project.id).map((environment) => ({
				id: environment.id,
				name: environment.name,
				slug: environment.slug
			}))
		}));
	} catch {
		// The caller may hold `iam:read` without `project:read`.
	}

	const grouped = new Map<
		string,
		Array<{ permission: Permission; risk: string; description: string }>
	>();
	for (const meta of Object.values(permissionCatalog)) {
		const list = grouped.get(meta.resource) ?? [];
		list.push({ permission: meta.permission, risk: meta.risk, description: meta.description });
		grouped.set(meta.resource, list);
	}
	const catalog = [...grouped].map(([resource, permissions]) => ({
		resource,
		label: RESOURCE_LABELS[resource] ?? resource,
		permissions
	}));

	return {
		roles: core.iam.listRoles(principal.orgId),
		bindings: core.iam.listBindings(principal.orgId),
		groups: core.iam.listGroups(principal.orgId),
		members,
		groupMembers,
		projects,
		catalog,
		// Not `can`: that would shadow the dashboard layout's `can`, which the settings sidebar reads.
		accessCan: {
			manageRoles: core.iam.can(principal, 'iam:manage-roles', org),
			manageBindings: core.iam.can(principal, 'iam:manage-bindings', org),
			manageGroups: core.iam.can(principal, 'iam:manage-groups', org)
		},
		showEmails,
		now: Date.now()
	};
};

export const actions: Actions = {
	createRole: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const role = core.iam.createRole(principal, {
				name: formString(data, 'name'),
				description: formOptionalString(data, 'description'),
				permissions: data.getAll('permissions').map(String)
			});
			return { success: `Created the ${role.name} role.` };
		} catch (cause) {
			return failure(cause);
		}
	},

	deleteRole: async ({ request, locals }) => {
		const principal = locals.principal!;
		const roleId = formString(await request.formData(), 'roleId');
		if (!roleId) return fail(400, { message: 'Missing role id.' });
		try {
			core.iam.deleteRole(principal, roleId);
			return { success: 'Role deleted.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	createBinding: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();

		const principalType = pick(formString(data, 'principalType'), PRINCIPAL_TYPES);
		if (!principalType)
			return fail(400, {
				message: 'Pick what the binding is for.',
				fieldErrors: { principalType: 'Pick a principal type.' }
			});
		const principalId = formString(data, 'principalId');
		if (!principalId)
			return fail(400, {
				message: 'Pick a principal.',
				fieldErrors: { principalId: 'Pick a principal.' }
			});
		const roleId = formString(data, 'roleId');
		if (!roleId)
			return fail(400, {
				message: 'Pick a role.',
				fieldErrors: { roleId: 'Pick a role.' }
			});

		const scopeType = pick(formString(data, 'scopeType') || 'org', SCOPE_TYPES);
		if (!scopeType)
			return fail(400, {
				message: 'Pick a scope.',
				fieldErrors: { scopeType: 'Pick a scope.' }
			});
		const projectId = formString(data, 'projectId');
		const environmentId = formString(data, 'environmentId');

		const reason = formString(data, 'reason');
		if (reason.length > 500)
			return fail(400, {
				message: 'Keep the reason under 500 characters.',
				fieldErrors: { reason: 'Too long.' }
			});

		const expires = futureTime(formString(data, 'expiresAt'));
		if (expires === 'invalid')
			return fail(400, {
				message: 'That expiry is not a valid date and time.',
				fieldErrors: { expiresAt: 'Invalid date.' }
			});
		if (expires === 'past')
			return fail(400, {
				message: 'An expiry must be in the future.',
				fieldErrors: { expiresAt: 'Pick a future time.' }
			});

		try {
			const roles = core.iam.listRoles(principal.orgId);
			if (!roles.some((role) => role.id === roleId))
				return fail(400, {
					message: 'That role no longer exists.',
					fieldErrors: { roleId: 'Pick a role.' }
				});

			if (principalType === 'user' && !isMember(principal.orgId, principalId))
				return fail(400, {
					message: 'That user is not a member of this organisation.',
					fieldErrors: { principalId: 'Pick a member.' }
				});
			if (
				principalType === 'group' &&
				!core.iam.listGroups(principal.orgId).some((group) => group.id === principalId)
			)
				return fail(400, {
					message: 'That group no longer exists.',
					fieldErrors: { principalId: 'Pick a group.' }
				});
			if (principalType === 'serviceAccount' && !principalId.startsWith('sa_'))
				return fail(400, {
					message: 'A service account id starts with sa_.',
					fieldErrors: { principalId: 'Use the service account id.' }
				});

			let scope: ScopeRef;
			if (scopeType === 'org') {
				scope = { type: 'org' };
			} else {
				const project = core.projects.list(principal).find((entry) => entry.id === projectId);
				if (!project)
					return fail(400, {
						message: 'Pick a project for this scope.',
						fieldErrors: { projectId: 'Pick a project.' }
					});
				if (scopeType === 'project') {
					scope = { type: 'project', id: project.id };
				} else {
					const environment = core.environments
						.rows(project.id)
						.find((entry) => entry.id === environmentId);
					if (!environment)
						return fail(400, {
							message: 'Pick an environment in that project.',
							fieldErrors: { environmentId: 'Pick an environment.' }
						});
					scope = { type: 'environment', id: environment.id, projectId: project.id };
				}
			}

			core.iam.bind(principal, {
				principalType,
				principalId,
				roleId,
				scope,
				...(expires === undefined ? {} : { expiresAt: expires }),
				...(reason ? { reason } : {})
			});
			return { success: 'Binding created.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	removeBinding: async ({ request, locals }) => {
		const principal = locals.principal!;
		const bindingId = formString(await request.formData(), 'bindingId');
		if (!bindingId) return fail(400, { message: 'Missing binding id.' });
		try {
			core.iam.unbind(principal, bindingId);
			return { success: 'Binding removed.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	createGroup: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const group = core.iam.createGroup(principal, {
				name: formString(data, 'name'),
				description: formOptionalString(data, 'description')
			});
			return { success: `Created the ${group.name} group.` };
		} catch (cause) {
			return failure(cause);
		}
	},

	addGroupMember: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const groupId = formString(data, 'groupId');
		const userId = formString(data, 'userId');
		if (!groupId) return fail(400, { message: 'Missing group id.' });
		if (!userId)
			return fail(400, {
				message: 'Pick a member to add.',
				fieldErrors: { userId: 'Pick a member.' }
			});
		if (!isMember(principal.orgId, userId))
			return fail(400, { message: 'That user is not a member of this organisation.' });
		try {
			core.iam.addGroupMember(principal, groupId, userId);
			return { success: 'Member added to the group.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	removeGroupMember: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const groupId = formString(data, 'groupId');
		const userId = formString(data, 'userId');
		if (!groupId || !userId) return fail(400, { message: 'Missing group or member id.' });
		try {
			core.iam.removeGroupMember(principal, groupId, userId);
			return { success: 'Member removed from the group.' };
		} catch (cause) {
			return failure(cause);
		}
	}
};
