import { error, fail } from '@sveltejs/kit';
import {
	REGISTRY_MIRROR_UPSTREAMS,
	hasPermission,
	type RegistryMirrorUpstream,
	type RegistrySettingsUpdate
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Container registries: the platform registry's setup (admins) and logins for external
 * registries (docs/REGISTRY.md R2). Repositories, tags and CI trusts are on /registry.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'image:pull'))
		error(403, 'You need permission to pull images to see registry credentials.');
	const canAdminister = core.ctx.platformIam.canAdminister(principal);
	return {
		credentials: core.registryCredentials.list(principal),
		canEdit: hasPermission(principal, 'image:credentials'),
		registry: core.registry.view(principal),
		canAdminister,
		nodes: canAdminister
			? core.nodes.list(principal).map((node) => ({ id: node.id, name: node.name, status: node.status }))
			: []
	};
};

function string(data: FormData, name: string): string {
	return String(data.get(name) ?? '').trim();
}

const SIGNATURE_POLICIES = ['off', 'warn', 'enforce'] as const;

/** The registry dialog's form → a settings update; blank optional fields keep what is stored. */
function registryUpdate(data: FormData): RegistrySettingsUpdate {
	const keepTags = Number(string(data, 'keepTags'));
	const signatures = string(data, 'signatures');
	const mirrors = data
		.getAll('mirrors')
		.map(String)
		.filter((value): value is RegistryMirrorUpstream => (REGISTRY_MIRROR_UPSTREAMS as readonly string[]).includes(value));
	// Keys are separated by blank lines; an empty textarea keeps the stored keys.
	const cosignKeys = String(data.get('cosignKeys') ?? '')
		.split(/\r?\n\s*\r?\n/)
		.map((key) => key.trim())
		.filter(Boolean);
	const endpoint = string(data, 's3Endpoint');
	const s3: RegistrySettingsUpdate['s3'] =
		data.get('s3Disk') === 'on'
			? null
			: endpoint
				? {
						endpoint,
						bucket: string(data, 's3Bucket'),
						...(string(data, 's3Region') ? { region: string(data, 's3Region') } : {}),
						accessKeyId: string(data, 's3AccessKeyId'),
						secretAccessKey: String(data.get('s3SecretAccessKey') ?? ''),
						cacheUrl: string(data, 's3CacheUrl')
					}
				: undefined;
	return {
		enabled: data.get('enabled') === 'on',
		...(string(data, 'node') ? { node: string(data, 'node') } : {}),
		...(string(data, 'host') ? { host: string(data, 'host') } : {}),
		...(Number.isInteger(keepTags) && keepTags > 0 ? { keepTags } : {}),
		mirrors,
		...((SIGNATURE_POLICIES as readonly string[]).includes(signatures)
			? { signatures: signatures as (typeof SIGNATURE_POLICIES)[number] }
			: {}),
		...(cosignKeys.length > 0 ? { cosignKeys } : {}),
		cveScanning: data.get('cveScanning') === 'on',
		...(s3 !== undefined ? { s3 } : {})
	};
}

export const actions: Actions = {
	add: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const credential = core.registryCredentials.create(principal, {
				name: string(data, 'name'),
				registry: string(data, 'registry'),
				username: string(data, 'username'),
				password: String(data.get('password') ?? '')
			});
			return { success: `Saved ${credential.name}. Nodes pull ${credential.registry} images with it from the next deploy or retry.` };
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	update: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const username = string(data, 'username');
		const password = String(data.get('password') ?? '');
		try {
			const credential = core.registryCredentials.update(principal, string(data, 'name'), {
				...(username ? { username } : {}),
				...(password ? { password } : {})
			});
			return { success: `Updated ${credential.name}.` };
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	registry: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const view = core.registry.update(principal, registryUpdate(data));
			return {
				success: view.enabled
					? `Registry ${view.host} is on. The node pulls zot and starts it within a minute.`
					: 'Registry is off. Its data stays on the node.'
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	remove: async ({ request, locals }) => {
		const principal = locals.principal!;
		const name = string(await request.formData(), 'name');
		try {
			core.registryCredentials.remove(principal, name);
			return { success: `Deleted ${name}. Running containers keep the image they already pulled.` };
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	}
};
