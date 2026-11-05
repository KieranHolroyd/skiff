import { error, fail } from '@sveltejs/kit';
import { canAdministerPlatform, hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { Actions, PageServerLoad } from './$types';

/** Settings → Backup targets (plan 05). Org targets plus the read-only platform default. */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'database:read'))
		error(403, 'You need permission to read databases to see backup targets.');
	return {
		targets: core.backupTargets.list(principal),
		canEdit: hasPermission(principal, 'database:update'),
		canPlatform: canAdministerPlatform(principal)
	};
};

function string(data: FormData, name: string): string {
	return String(data.get(name) ?? '').trim();
}

export const actions: Actions = {
	add: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const kind = string(data, 'kind') === 'local' ? 'local' : 's3';
		try {
			const result =
				kind === 'local'
					? core.backupTargets.create(
							principal,
							{
								name: string(data, 'name'),
								kind,
								path: string(data, 'path'),
								writeOnly: data.get('writeOnly') === 'on'
							},
							{ platform: data.get('platform') === 'on' }
						)
					: core.backupTargets.create(
							principal,
							{
								name: string(data, 'name'),
								kind,
								bucket: string(data, 'bucket'),
								accessKeyId: string(data, 'accessKeyId'),
								secretAccessKey: string(data, 'secretAccessKey'),
								...(string(data, 'endpoint') ? { endpoint: string(data, 'endpoint') } : {}),
								...(string(data, 'region') ? { region: string(data, 'region') } : {}),
								...(string(data, 'pathPrefix') ? { pathPrefix: string(data, 'pathPrefix') } : {}),
								writeOnly: data.get('writeOnly') === 'on',
								objectLock: data.get('objectLock') === 'on'
							},
							{ platform: data.get('platform') === 'on' }
						);
			return {
				success: `Created ${result.target.name}. Test it before relying on it.`,
				credentials: result.credentials
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	test: async ({ request, locals }) => {
		const principal = locals.principal!;
		const id = string(await request.formData(), 'id');
		try {
			const result = await core.backupTargets.testConnection(principal, id);
			return result.ok ? { success: result.message } : fail(400, { message: result.message });
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	remove: async ({ request, locals }) => {
		const principal = locals.principal!;
		const id = string(await request.formData(), 'id');
		try {
			core.backupTargets.delete(principal, id);
			return { success: 'Backup target deleted. Existing backups were not removed.' };
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	}
};
