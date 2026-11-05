import { error, fail } from '@sveltejs/kit';
import {
	hasPermission,
	quotaFieldNames,
	quotaUpdateSchema,
	type QuotaUpdate
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { formString } from '../../_lib/errors.js';
import { QUOTA_FIELD_SCALE, QUOTA_FIELDS } from './quota-fields.js';
import type { Actions, PageServerLoad } from './$types';

/** Settings → Usage: org quotas, current usage and the 30-day trend (plan 16). */
export const load: PageServerLoad = async ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'project:read'))
		error(403, 'You need permission to read projects to see usage.');

	const [view, quotas, history, projects] = await Promise.all([
		core.usage.view(principal),
		core.usage.quotas(principal),
		core.usage.history(principal),
		Promise.resolve(core.projects.list(principal))
	]);
	return {
		view,
		quotas,
		history,
		projects,
		canSetQuotas: principal.platformAdmin === true
	};
};

export const actions: Actions = {
	/**
	 * Org limits from the "Edit limits" dialog. A blank field is unlimited; byte fields arrive in
	 * the unit the dialog shows (see `QUOTA_FIELD_SCALE`) and are stored in bytes.
	 */
	quotas: async ({ request, locals }) => {
		const principal = locals.principal!;
		if (principal.platformAdmin !== true)
			return fail(403, { message: 'Only a platform admin can change quotas.' });
		const data = await request.formData();
		const input: Record<string, number> = {};
		for (const field of quotaFieldNames) {
			// Only fields the form sent; a missing field keeps its current limit.
			if (!data.has(field)) continue;
			const raw = formString(data, field);
			if (raw === '') {
				input[field] = -1;
				continue;
			}
			const value = Number(raw);
			if (!Number.isFinite(value) || value < 0)
				return fail(400, {
					message: `${QUOTA_FIELDS[field].label}: enter a positive number, or leave it blank for no limit.`
				});
			input[field] = Math.round(value * (QUOTA_FIELD_SCALE[field] ?? 1));
		}
		const parsed = quotaUpdateSchema.safeParse(input);
		if (!parsed.success)
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Check the limits and try again.'
			});
		const update: QuotaUpdate = parsed.data;
		core.ctx.quota.set(principal.orgId, update);
		core.ctx.audit.record({
			principal,
			action: 'quota.set',
			resource: 'org',
			resourceId: principal.orgId,
			args: update,
			result: 'ok'
		});
		return { success: 'Limits saved. New requests are checked against them straight away.' };
	}
};
