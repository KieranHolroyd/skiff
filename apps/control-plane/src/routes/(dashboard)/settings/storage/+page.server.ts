import { error, fail, redirect } from '@sveltejs/kit';
import { storageKinds, type StorageKind, type StorageDefaultInput } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/** Settings → Storage (docs/STORAGE.md §5): pools, volumes, network shares and the storage rules. */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	if (!principal.platformAdmin) error(403, 'Storage is platform infrastructure; a platform admin manages it.');
	const overview = core.storagePools.overview(principal);
	return {
		overview,
		shares: core.shares.list(principal).map((share) => ({
			name: share.name,
			protocol: share.protocol,
			server: share.server,
			exportPath: share.exportPath,
			mounts: share.mounts.length,
		})),
		onboarding: url.searchParams.has('onboarding') || overview.onboarding === 'pending',
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

export const actions: Actions = {
	createPool: async ({ request, locals }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		return act(
			() =>
				core.storagePools.createPool(locals.principal!, {
					name,
					description: formString(data, 'description'),
					allocation: formString(data, 'allocation') === 'fill-up' ? 'fill-up' : 'most-free',
					minFreePercent: Number(formString(data, 'minFreePercent') || 10),
					volumes: data.getAll('volumes').map(String),
				}),
			`Pool “${name}” created.`,
		);
	},

	updatePool: async ({ request, locals }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		return act(
			() =>
				core.storagePools.updatePool(locals.principal!, name, {
					description: formString(data, 'description'),
					allocation: formString(data, 'allocation') === 'fill-up' ? 'fill-up' : 'most-free',
					minFreePercent: Number(formString(data, 'minFreePercent') || 10),
				}),
			`Pool “${name}” saved.`,
		);
	},

	deletePool: async ({ request, locals }) => {
		const name = formString(await request.formData(), 'name');
		return act(() => core.storagePools.deletePool(locals.principal!, name), `Pool “${name}” deleted. Its volumes are unassigned; no data moved.`);
	},

	assignVolume: async ({ request, locals }) => {
		const data = await request.formData();
		const pool = formString(data, 'pool');
		return act(
			() => core.storagePools.setVolumePool(locals.principal!, formString(data, 'volumeId'), pool || null),
			pool ? `Volume added to “${pool}”.` : 'Volume removed from its pool.',
		);
	},

	/** Adopt a mount the node reports and (optionally) put it straight into a pool. */
	adopt: async ({ request, locals }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		const pool = formString(data, 'pool');
		return act(() => {
			const volume = core.volumes.adopt(locals.principal!, formString(data, 'nodeId'), {
				name,
				sourceKey: formString(data, 'sourceKey'),
			});
			if (pool) core.storagePools.setVolumePool(locals.principal!, volume.id, pool);
		}, pool ? `“${name}” adopted into “${pool}”.` : `“${name}” adopted.`);
	},

	/** Mount an unmounted partition by UUID at /mnt/skiff-disks/<name>, then adopt it (docs/VOLUMES.md §3.1). */
	mountPartition: async ({ request, locals }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		const pool = formString(data, 'pool');
		return act(
			() =>
				core.diskMounts.mount(locals.principal!, formString(data, 'nodeId'), {
					fsUuid: formString(data, 'fsUuid'),
					name,
					pool: pool || null,
					defaultVolume: formBoolean(data, 'defaultVolume'),
				}),
			`Mounting the partition as “${name}”. It becomes a volume${pool ? ` in “${pool}”` : ''} once the node reports it, usually within a minute.`,
		);
	},

	/** Unregister the volume (refused while anything is on it) and unmount the partition. */
	unmountPartition: async ({ request, locals }) => {
		const data = await request.formData();
		return act(
			() => core.diskMounts.unmount(locals.principal!, formString(data, 'nodeId'), formString(data, 'id')),
			'Unmounting the partition. Its files stay on the disk.',
		);
	},

	saveDefaults: async ({ request, locals }) => {
		const data = await request.formData();
		const defaults: StorageDefaultInput[] = storageKinds.map((kind: StorageKind) => ({
			kind,
			pool: formString(data, `${kind}.pool`) || 'system',
		}));
		const result = act(
			() => core.storagePools.setDefaults(locals.principal!, { defaults }),
			'Default storage saved. New services start with it; anything already created stays where it is.',
		);
		if ('success' in result && formBoolean(data, 'finish')) {
			core.storagePools.setOnboarding(locals.principal!, { state: 'done' });
			redirect(303, '/overview?storage=ready');
		}
		return result;
	},

	/** Benchmark every ready member of a pool, or one volume (docs/STORAGE.md §5). */
	profilePool: async ({ request, locals }) => {
		const name = formString(await request.formData(), 'name');
		try {
			const result = core.storagePools.profilePool(locals.principal!, name);
			const skipped = result.skipped.length ? ` Skipped: ${result.skipped.map((item) => `${item.volume} ${item.reason}`).join('; ')}.` : '';
			return { success: `Profiling ${result.queued.join(', ')}. Results appear here in about a minute per volume.${skipped}` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	profileVolume: async ({ request, locals }) => {
		const volumeId = formString(await request.formData(), 'volumeId');
		return act(() => core.storagePools.profileVolume(locals.principal!, volumeId), 'Profiling the volume. Results appear here in about a minute.');
	},

	skipOnboarding: async ({ locals }) => {
		try {
			core.storagePools.setOnboarding(locals.principal!, { state: 'skipped' });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, '/overview');
	},
};
