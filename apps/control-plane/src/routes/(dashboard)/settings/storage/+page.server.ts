import { error, fail, redirect } from '@sveltejs/kit';
import {
	storageDefaultTargets,
	storageKinds,
	type StorageDefaultInput,
	type StorageDefaultTarget
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/** Settings → Storage (docs/STORAGE.md §5): defaults per kind, then each node's disks. */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	if (!core.ctx.platformIam.can(principal, 'platform:storage'))
		error(403, 'Storage is platform infrastructure; a platform operator or admin manages it.');
	const overview = core.disks.overview(principal);
	return {
		overview,
		shares: core.shares.list(principal).length,
		onboarding: url.searchParams.has('onboarding') || overview.onboarding === 'pending'
	};
};

function act<T>(fn: () => T, success: string) {
	try {
		fn();
	} catch (caught) {
		return fail(failStatus(caught), toFormFailure(caught));
	}
	return { success };
}

function tierField(data: FormData): 'fast' | 'bulk' | undefined {
	const value = formString(data, 'tier');
	return value === 'fast' || value === 'bulk' ? value : undefined;
}

export const actions: Actions = {
	addDisk: async ({ request, locals }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		let message = '';
		const result = act(() => {
			const disk = core.disks.add(locals.principal!, {
				node: formString(data, 'nodeId'),
				candidate: formString(data, 'candidate'),
				...(name ? { name } : {}),
				...(tierField(data) ? { tier: tierField(data) } : {})
			});
			message =
				disk.status === 'ready'
					? `“${disk.name}” is ready. New services can be stored on it.`
					: `Mounting “${disk.name}” at ${disk.mountPath}. It is ready as soon as the node reports it (about a minute).`;
		}, '');
		return 'success' in result ? { success: message } : result;
	},

	updateDisk: async ({ request, locals }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		return act(
			() =>
				core.disks.update(locals.principal!, formString(data, 'id'), {
					...(name ? { name } : {}),
					...(tierField(data) ? { tier: tierField(data) } : {})
				}),
			'Disk saved. New services follow the tier; nothing already stored moves.'
		);
	},

	removeDisk: async ({ request, locals }) => {
		const data = await request.formData();
		let unmounting = false;
		const result = act(() => {
			unmounting = core.disks.remove(locals.principal!, formString(data, 'id')).unmounting;
		}, '');
		if (!('success' in result)) return result;
		return {
			success: unmounting
				? 'Unmounting the disk on its node. Its files stay on the disk.'
				: 'Disk removed from Skiff. Its files and mount were left alone.'
		};
	},

	profileDisk: async ({ request, locals }) => {
		const data = await request.formData();
		return act(
			() => core.disks.profile(locals.principal!, formString(data, 'id')),
			'Profiling the disk. Results appear here in about a minute.'
		);
	},

	saveDefaults: async ({ request, locals }) => {
		const data = await request.formData();
		const defaults: StorageDefaultInput[] = storageKinds.flatMap((kind) => {
			const target = formString(data, `${kind}.target`);
			return (storageDefaultTargets as readonly string[]).includes(target)
				? [{ kind, target: target as StorageDefaultTarget }]
				: [];
		});
		if (defaults.length === 0)
			return fail(400, { message: 'Pick a default for at least one kind of service.' });
		const finish = formBoolean(data, 'finish');
		const result = act(() => {
			core.disks.setDefaults(locals.principal!, { defaults });
			if (finish) core.disks.setOnboarding(locals.principal!, { state: 'done' });
		}, 'Defaults saved. New services start with them; nothing already created moved.');
		if (finish && 'success' in result) redirect(303, '/settings/storage');
		return result;
	},

	skipOnboarding: async ({ locals }) => {
		const result = act(
			() => core.disks.setOnboarding(locals.principal!, { state: 'skipped' }),
			'Using the system disk for now.'
		);
		if ('success' in result) redirect(303, '/settings/storage');
		return result;
	}
};
