import { fail } from '@sveltejs/kit';
import { hasPermission } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import type { Actions, PageServerLoad } from './$types';

/** Registry: the platform registry's repositories, usage and CI logins (docs/REGISTRY.md). */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'image:pull')) return { denied: true as const };
	const registry = core.registry.view(principal);
	return {
		denied: false as const,
		registry,
		repositories: registry.enabled ? core.registry.listRepositories(principal) : [],
		usage: core.registry.usage(principal),
		trusts: registry.enabled ? core.registry.listOidcTrusts(principal) : [],
		canEditTrusts: hasPermission(principal, 'image:credentials'),
		canAdminister: core.ctx.platformIam.canAdminister(principal)
	};
};

function string(data: FormData, name: string): string {
	return String(data.get(name) ?? '').trim();
}

export const actions: Actions = {
	addTrust: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const ref = string(data, 'ref');
		try {
			const provider = string(data, 'provider') === 'gitlab' ? 'gitlab' : 'github';
			const issuer = string(data, 'issuer');
			const trust = core.registry.createOidcTrust(principal, {
				provider,
				...(provider === 'gitlab'
					? { gitlabProject: string(data, 'subject'), ...(issuer ? { issuer } : {}) }
					: { githubRepository: string(data, 'subject') }),
				repository: string(data, 'repository'),
				...(ref ? { ref } : {}),
				push: data.get('push') === 'on'
			});
			return {
				success: `${provider === 'gitlab' ? 'CI jobs' : 'Workflows'} in ${trust.subject} can now ${trust.push ? 'push to and pull' : 'pull'} ${trust.repository}.`
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	removeTrust: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.registry.deleteOidcTrust(principal, string(data, 'id'));
			return { success: 'Trust removed. Workflows from that repository can no longer log in.' };
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	}
};
