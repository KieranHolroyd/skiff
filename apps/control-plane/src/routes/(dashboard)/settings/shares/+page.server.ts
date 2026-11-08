import { fail } from '@sveltejs/kit';
import type { ShareGrant, ShareView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formRawString, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	try {
		const shares = core.shares.list(principal);
		// Mount targets: every enrolled node. The server refuses one whose agent cannot mount yet.
		const nodes = core.nodes.list(principal).map((node) => ({ id: node.id, name: node.name, status: node.status }));
		return { shares, nodes, denied: false };
	} catch {
		return { shares: [] as ShareView[], nodes: [] as Array<{ id: string; name: string; status: string }>, denied: true };
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

/** SMB credentials from a form, or undefined when the username is blank. */
function formCredentials(data: FormData): { username: string; password: string; domain?: string } | undefined {
	const username = formString(data, 'username');
	if (!username) return undefined;
	const domain = formString(data, 'domain');
	return { username, password: formRawString(data, 'password'), ...(domain ? { domain } : {}) };
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const protocol = formString(data, 'protocol');
		if (protocol !== 'nfs' && protocol !== 'smb') return fail(400, { message: 'Choose NFS or SMB.' });
		const credentials = protocol === 'smb' ? formCredentials(data) : undefined;
		if (protocol === 'smb' && !credentials)
			return fail(400, { message: 'SMB shares need a username and password to mount.' });
		try {
			core.shares.create(principal, {
				name,
				protocol,
				server: formString(data, 'server'),
				exportPath: formString(data, 'exportPath'),
				zone: formString(data, 'zone') || 'default',
				readOnly: formBoolean(data, 'readOnly'),
				...(credentials ? { credentials } : {}),
			});
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Share “${name}” created. Mount it on a node to use it.` };
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

	credentials: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const credentials = formCredentials(data);
		if (!credentials) return fail(400, { message: 'Enter the SMB username and password.' });
		try {
			core.shares.update(principal, name, { credentials });
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Credentials for “${name}” saved. Failed mounts retry with them now.` };
	},

	mount: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const node = formString(data, 'node');
		if (!node) return fail(400, { message: 'Pick a node to mount the share on.' });
		const diskName = formString(data, 'diskName');
		let readOnly = false;
		try {
			readOnly = core.shares.mount(principal, name, { node, ...(diskName ? { diskName } : {}) }).readOnly;
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: readOnly
				? `Mounting “${name}” on the node.`
				: `Mounting “${name}”. It becomes a disk under Settings → Storage as soon as the node reports the mount.`,
		};
	},

	unmount: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		try {
			core.shares.unmount(principal, name, formString(data, 'node'));
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Unmounting “${name}”.` };
	},

	link: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const diskName = formString(data, 'diskName') || name;
		try {
			core.shares.link(principal, name, formString(data, 'node'), { diskName });
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `“${name}” becomes the disk “${diskName}”.` };
	},

	/** Benchmark the disk a mount became (docs/STORAGE.md §5.1). */
	profile: async ({ request, locals }) => {
		const data = await request.formData();
		try {
			core.disks.profile(locals.principal!, formString(data, 'diskId'));
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `Profiling “${formString(data, 'name')}”. Results appear on the mount in about a minute.` };
	},

	unlink: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		try {
			core.shares.unlink(principal, name, formString(data, 'node'));
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: `“${name}” is no longer a disk. The share stays mounted.` };
	},
};
