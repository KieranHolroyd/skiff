import { fail } from '@sveltejs/kit';
import type { ShareGrant, ShareView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	try {
		return { shares: core.shares.list(principal), denied: false };
	} catch {
		return { shares: [] as ShareView[], denied: true };
	}
};

function parseGrants(value: string): ShareGrant[] {
	const grants: ShareGrant[] = [];
	for (const line of value.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [orgId, mode, ...prefix] = trimmed.split(/\s+/);
		if (!orgId) throw new Error('Each grant line needs an org id.');
		grants.push({
			orgId,
			mode: mode === 'rw' ? 'rw' : 'ro',
			pathPrefix: prefix.join(' '),
		});
	}
	return grants;
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const protocol = formString(data, 'protocol');
		if (protocol !== 'nfs' && protocol !== 'smb') return fail(400, { message: 'Choose NFS or SMB.' });
		try {
			core.shares.create(principal, {
				name,
				protocol,
				server: formString(data, 'server'),
				exportPath: formString(data, 'exportPath'),
				zone: formString(data, 'zone') || 'default',
				readOnly: formBoolean(data, 'readOnly'),
			});
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Share “${name}” created.` };
	},

	remove: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		try {
			core.shares.remove(principal, name);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Share “${name}” removed.` };
	},

	grants: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		try {
			core.shares.setGrants(principal, name, { grants: parseGrants(formString(data, 'grants')) });
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Grants for “${name}” saved.` };
	},
};
