import { fail } from '@sveltejs/kit';
import { hasPermission, roles, type Permission, type Principal, type Role } from '@skiff/contracts';
import { isRole, memberChangeError } from '@skiff/core';
import { auth } from '#lib/server/auth.js';
import { platformOrigin } from '#lib/server/config.js';
import { core } from '#lib/server/core.js';
import { authErrorMessage } from '#lib/server/user-settings.js';
import { formString } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Members and invitations of the signed-in org (DESIGN §6.2). Mutations go through Better Auth's
 * organization endpoints, which re-check the same RBAC table (auth.ts maps `member:*` onto them);
 * Skiff checks the permission and the ownership rules (`memberChangeError`) first for clear errors.
 */

const ROLES = Object.keys(roles) as Role[];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MemberRow {
	id: string;
	userId: string;
	role: string;
	name: string | null;
	email: string | null;
	createdAt: string | null;
}

function members(orgId: string): MemberRow[] {
	return core.ctx.sqlite
		.query<MemberRow, [string]>(
			`SELECT m.id AS id, m.userId AS userId, m.role AS role, u.name AS name, u.email AS email, m.createdAt AS createdAt
			 FROM member m LEFT JOIN user u ON u.id = m.userId
			 WHERE m.organizationId = ?
			 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'deployer' THEN 2 ELSE 3 END, u.name ASC`
		)
		.all(orgId);
}

function ownerCount(orgId: string): number {
	return (
		core.ctx.sqlite
			.query<{ n: number }, [string]>(
				"SELECT count(*) AS n FROM member WHERE organizationId = ? AND role = 'owner'"
			)
			.get(orgId)?.n ?? 0
	);
}

function memberById(orgId: string, memberId: string): MemberRow | undefined {
	return members(orgId).find((member) => member.id === memberId);
}

function roleOf(value: string): Role {
	return isRole(value) ? value : 'viewer';
}

function denied(principal: Principal, permission: Permission) {
	return hasPermission(principal, permission)
		? undefined
		: fail(403, { message: `Your role (${principal.role}) does not include ${permission}.` });
}

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	const showEmails = principal.role === 'owner' || principal.role === 'admin';
	const can = {
		invite: hasPermission(principal, 'member:invite'),
		updateRole: hasPermission(principal, 'member:update-role'),
		remove: hasPermission(principal, 'member:remove')
	};

	let list: Array<{
		id: string;
		userId: string;
		name: string;
		email: string | null;
		role: Role;
		joinedAt: string | null;
		self: boolean;
	}> = [];
	let invitations: Array<{
		id: string;
		email: string;
		role: Role;
		expiresAt: string | null;
		url: string;
	}> = [];
	let loadError: string | null = null;
	try {
		list = members(principal.orgId).map((row) => ({
			id: row.id,
			userId: row.userId,
			name: row.name || row.email?.split('@')[0] || row.userId,
			email: showEmails ? row.email : null,
			role: roleOf(row.role),
			joinedAt: row.createdAt,
			self: row.userId === principal.userId
		}));
		if (can.invite) {
			invitations = core.ctx.sqlite
				.query<
					{ id: string; email: string; role: string | null; expiresAt: string | null },
					[string, string]
				>(
					`SELECT id, email, role, expiresAt FROM invitation
					 WHERE organizationId = ? AND status = 'pending' AND expiresAt > ?
					 ORDER BY expiresAt DESC`
				)
				.all(principal.orgId, new Date().toISOString())
				.map((row) => ({
					id: row.id,
					email: row.email,
					role: roleOf(row.role ?? 'viewer'),
					expiresAt: row.expiresAt,
					url: `${platformOrigin}/accept-invitation/${row.id}`
				}));
		}
	} catch {
		loadError = 'Members are temporarily unavailable. Try again in a moment.';
	}

	// Only owners may grant `owner` (Better Auth enforces this too).
	const assignableRoles = ROLES.filter((role) => role !== 'owner' || principal.role === 'owner');

	return {
		members: list,
		invitations,
		ownerCount: list.filter((member) => member.role === 'owner').length,
		loadError,
		can,
		actorRole: principal.role,
		assignableRoles
	};
};

export const actions: Actions = {
	invite: async ({ request, locals }) => {
		const principal = locals.principal!;
		const refused = denied(principal, 'member:invite');
		if (refused) return refused;
		const data = await request.formData();
		const email = formString(data, 'email').toLowerCase();
		const role = formString(data, 'role');
		if (!EMAIL.test(email))
			return fail(400, {
				message: 'Enter a valid email address.',
				fieldErrors: { email: 'Invalid email.' }
			});
		if (!isRole(role))
			return fail(400, { message: 'Pick a role.', fieldErrors: { role: 'Pick a role.' } });
		const problem = memberChangeError(
			principal.role,
			{ action: 'invite', role },
			ownerCount(principal.orgId)
		);
		if (problem) return fail(403, { message: problem });
		try {
			await auth.api.createInvitation({
				body: { email, role, organizationId: principal.orgId, resend: true },
				headers: request.headers
			});
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}
		core.audit.record({
			principal,
			action: 'member.invite',
			resource: 'invitation',
			args: { email, role },
			result: 'ok'
		});
		return { success: `Invitation sent to ${email}.` };
	},

	cancelInvitation: async ({ request, locals }) => {
		const principal = locals.principal!;
		const refused = denied(principal, 'member:invite');
		if (refused) return refused;
		const invitationId = formString(await request.formData(), 'invitationId');
		if (!invitationId) return fail(400, { message: 'Missing invitation id.' });
		try {
			await auth.api.cancelInvitation({ body: { invitationId }, headers: request.headers });
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}
		core.audit.record({
			principal,
			action: 'member.cancel_invitation',
			resource: 'invitation',
			resourceId: invitationId,
			result: 'ok'
		});
		return { success: 'Invitation cancelled.' };
	},

	updateRole: async ({ request, locals }) => {
		const principal = locals.principal!;
		const refused = denied(principal, 'member:update-role');
		if (refused) return refused;
		const data = await request.formData();
		const memberId = formString(data, 'memberId');
		const role = formString(data, 'role');
		if (!isRole(role)) return fail(400, { message: 'Pick a role.' });
		const target = memberById(principal.orgId, memberId);
		if (!target) return fail(404, { message: 'That member is no longer in this organisation.' });
		const problem = memberChangeError(
			principal.role,
			{
				action: 'update-role',
				targetRole: roleOf(target.role),
				role,
				self: target.userId === principal.userId
			},
			ownerCount(principal.orgId)
		);
		if (problem) return fail(403, { message: problem });
		try {
			await auth.api.updateMemberRole({
				body: { memberId, role, organizationId: principal.orgId },
				headers: request.headers
			});
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}
		core.audit.record({
			principal,
			action: 'member.update_role',
			resource: 'member',
			resourceId: memberId,
			args: { from: target.role, to: role },
			result: 'ok'
		});
		return { success: `${target.name || target.email || 'Member'} is now ${role}.` };
	},

	remove: async ({ request, locals }) => {
		const principal = locals.principal!;
		const refused = denied(principal, 'member:remove');
		if (refused) return refused;
		const memberId = formString(await request.formData(), 'memberId');
		const target = memberById(principal.orgId, memberId);
		if (!target) return fail(404, { message: 'That member is no longer in this organisation.' });
		const problem = memberChangeError(
			principal.role,
			{
				action: 'remove',
				targetRole: roleOf(target.role),
				self: target.userId === principal.userId
			},
			ownerCount(principal.orgId)
		);
		if (problem) return fail(403, { message: problem });
		try {
			await auth.api.removeMember({
				body: { memberIdOrEmail: memberId, organizationId: principal.orgId },
				headers: request.headers
			});
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}
		core.audit.record({
			principal,
			action: 'member.remove',
			resource: 'member',
			resourceId: memberId,
			args: { role: target.role },
			result: 'ok'
		});
		return { success: `${target.name || target.email || 'Member'} was removed.` };
	}
};
