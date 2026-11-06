import { fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { failStatus, toFormFailure } from '../../_lib/errors.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	requireOwnerPage(locals);
	return { config: core.cluster.get() };
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		const raw = String(data.get('config') ?? '').trim();
		if (!raw) return fail(400, { message: 'Configuration is empty.' });
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return fail(400, { message: 'Configuration must be valid JSON.' });
		}
		try {
			core.cluster.update(principal, parsed);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Cluster configuration saved.' };
	}
};
