import { error, fail } from '@sveltejs/kit';
import { hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → GitHub (docs/GITHUB.md): Skiff's GitHub App (platform admins register it) and the
 * installations linked to this organisation, which git builds, pipelines, runners and registry
 * trusts then use instead of hand-made webhooks and tokens.
 */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'build:read')) error(403, 'You need permission to read builds to see GitHub settings.');
	const isAdmin = core.ctx.platformIam.canAdminister(principal);
	const app = core.githubApp.view(principal);
	const installations = core.githubApp.installations(principal);
	return {
		app,
		installations: installations.filter((entry) => entry.orgId === principal.orgId),
		unclaimed: installations.filter((entry) => entry.orgId === null),
		elsewhere: isAdmin
			? core.githubApp.allInstallations(principal).filter((entry) => entry.orgId && entry.orgId !== principal.orgId)
			: [],
		installUrl: app.configured ? core.githubApp.installUrl(principal) : null,
		isAdmin,
		canLink: principal.kind === 'user' && (principal.role === 'owner' || principal.role === 'admin'),
		defaultName: `Skiff ${new URL(core.ctx.config.platformOrigin).hostname}`.slice(0, 34),
		/** Set by the callback pages after a redirect. */
		notice: url.searchParams.get('created')
			? 'GitHub App created. Install it on an account to connect repositories.'
			: url.searchParams.get('linked')
				? `Connected ${url.searchParams.get('linked')}. Its repositories are ready to use.`
				: null
	};
};

function text(data: FormData, name: string): string {
	return String(data.get(name) ?? '').trim();
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export const actions: Actions = {
	manifest: async ({ request, locals }) => {
		const data = await request.formData();
		try {
			const started = core.githubApp.startManifest(locals.principal!, {
				name: text(data, 'name'),
				owner: text(data, 'owner'),
				public: data.get('public') === 'on'
			});
			return { manifestPost: { url: started.postUrl, manifest: started.manifest } };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	manual: async ({ request, locals }) => {
		const data = await request.formData();
		try {
			const view = await core.githubApp.configureManual(locals.principal!, {
				appId: Number(text(data, 'appId')),
				privateKey: String(data.get('privateKey') ?? ''),
				webhookSecret: String(data.get('webhookSecret') ?? ''),
				clientId: text(data, 'clientId'),
				clientSecret: text(data, 'clientSecret')
			});
			return { success: `Connected ${view.name ?? `App ${view.appId}`}.` };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	sync: async ({ locals }) => {
		try {
			const count = await core.githubApp.syncInstallations(locals.principal!);
			return { success: `GitHub lists ${count} installation${count === 1 ? '' : 's'}.` };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	link: async ({ request, locals }) => {
		const id = Number(text(await request.formData(), 'installationId'));
		try {
			const linked = core.githubApp.linkInstallation(locals.principal!, id);
			return { success: `Connected ${linked.account.login} to this organisation.` };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	unlink: async ({ request, locals }) => {
		const id = Number(text(await request.formData(), 'installationId'));
		try {
			core.githubApp.unlinkInstallation(locals.principal!, id);
			return { success: 'Disconnected. The App stays installed on GitHub until you uninstall it there.' };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	remove: async ({ locals }) => {
		try {
			core.githubApp.remove(locals.principal!);
			return { success: 'GitHub App removed from Skiff. Delete it on GitHub too if you no longer need it.' };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	}
};
