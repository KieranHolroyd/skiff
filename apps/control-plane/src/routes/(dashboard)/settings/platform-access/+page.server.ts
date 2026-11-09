import { fail } from '@sveltejs/kit';
import { platformRoleDescriptions, platformRoleIds } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formOptionalString, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

interface UserOption {
	id: string;
	name: string;
	email: string;
	/** Better Auth's `user.role`; `admin` seeds a platform-admin binding. */
	role: string;
}

function userOptions(): UserOption[] {
	try {
		return core.ctx.sqlite
			.query<UserOption, []>('SELECT id, name, email, COALESCE(role, \'\') AS role FROM user ORDER BY name COLLATE NOCASE')
			.all();
	} catch {
		// A boot before Better Auth has created its tables.
		return [];
	}
}

/**
 * Settings → Platform access (IAM.md I24, §10). Platform roles are bound at platform scope and
 * never grant org access; the three built-in roles and fleet-wide deny guardrails live here.
 * Reading needs a platform read; bindings need a platform administrator (D129), and guardrail
 * writes also need `iam:manage-guardrails` in the caller's own org.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	let bindings: ReturnType<typeof core.platformIam.list> = [];
	let guardrails: ReturnType<typeof core.platformIam.listGuardrails> = [];
	let denied = false;
	try {
		bindings = core.platformIam.list(principal);
		guardrails = core.platformIam.listGuardrails(principal);
	} catch {
		denied = true;
	}
	const canManage = core.platformIam.canAdminister(principal);
	return {
		denied,
		bindings,
		guardrails,
		users: userOptions(),
		roles: platformRoleIds.map((id) => ({
			id,
			description: platformRoleDescriptions[id],
		})),
		can: {
			administer: canManage,
			manageGuardrails:
				canManage && core.iam.can(principal, 'iam:manage-guardrails', { type: 'org' }),
		},
	};
};

export const actions: Actions = {
	bind: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const condition = formString(data, 'condition');
		try {
			core.platformIam.bind(principal, {
				userId: formString(data, 'userId'),
				roleId: formString(data, 'roleId'),
				// `none` is the quota-write exception (D129): a binding without the session condition.
				condition: condition === 'none' ? null : undefined,
				reason: formOptionalString(data, 'reason'),
			});
		} catch (cause) {
			return fail(failStatus(cause), toFormFailure(cause));
		}
		return { success: 'Platform role bound.' };
	},

	unbind: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.platformIam.unbind(principal, formString(data, 'id'));
		} catch (cause) {
			return fail(failStatus(cause), toFormFailure(cause));
		}
		return { success: 'Platform binding removed.' };
	},

	createGuardrail: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const permissions = formString(data, 'permissions')
			.split(/[\s,]+/)
			.map((entry) => entry.trim())
			.filter(Boolean);
		try {
			core.platformIam.createGuardrail(principal, {
				name: formString(data, 'name'),
				permissions,
			});
		} catch (cause) {
			return fail(failStatus(cause), toFormFailure(cause));
		}
		return { success: 'Fleet-wide guardrail created.' };
	},

	deleteGuardrail: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.platformIam.deleteGuardrail(principal, formString(data, 'id'));
		} catch (cause) {
			return fail(failStatus(cause), toFormFailure(cause));
		}
		return { success: 'Guardrail deleted.' };
	}
};
