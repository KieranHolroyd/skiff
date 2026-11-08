import { error, fail } from '@sveltejs/kit';
import { hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Git providers (docs/FORGES.md): the org's GitLab, Gitea and Forgejo connections, the
 * hooks Skiff created on them, and where the GitHub App stands (it has its own page).
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'build:read')) error(403, 'You need permission to read builds to see git provider settings.');
	const app = core.githubApp.view(principal);
	return {
		connections: core.forges.list(principal),
		github: {
			configured: app.configured,
			name: app.name ?? app.slug,
			installations: app.configured ? core.githubApp.installations(principal).filter((entry) => entry.orgId === principal.orgId).length : 0
		},
		pipelineSetup: core.pipelines.autoSetup(principal),
		canManage: hasPermission(principal, 'build:create') && (principal.role === 'owner' || principal.role === 'admin')
	};
};

function text(data: FormData, name: string): string {
	return String(data.get(name) ?? '').trim();
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const data = await request.formData();
		try {
			const kind = text(data, 'kind') as 'gitlab' | 'gitea' | 'forgejo';
			const view = await core.forges.create(locals.principal!, {
				kind,
				baseUrl: text(data, 'baseUrl'),
				name: text(data, 'name') || undefined,
				token: text(data, 'token'),
				cloneToken: text(data, 'cloneToken') || undefined
			});
			return { success: `Connected ${view.name} as ${view.accountLogin ?? 'the token’s account'}.` };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	update: async ({ request, locals }) => {
		const data = await request.formData();
		try {
			const clone = text(data, 'cloneToken');
			const view = await core.forges.update(locals.principal!, text(data, 'id'), {
				name: text(data, 'name') || undefined,
				token: text(data, 'token') || undefined,
				cloneToken: data.get('removeCloneToken') === 'on' ? null : clone || undefined
			});
			return { success: `Saved ${view.name}.` };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	remove: async ({ request, locals }) => {
		const id = text(await request.formData(), 'id');
		try {
			await core.forges.remove(locals.principal!, id);
			return { success: 'Connection removed, with the webhooks Skiff created on the forge.' };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	webhook: async ({ request, locals }) => {
		const data = await request.formData();
		const scope = text(data, 'scope');
		const path = text(data, 'path');
		try {
			const hook = await core.forges.addWebhook(
				locals.principal!,
				text(data, 'id'),
				scope === 'namespace' ? { namespace: path } : { repository: path }
			);
			if (hook.error) return fail(400, { message: `The forge refused the webhook on ${hook.path}: ${hook.error}` });
			return {
				success:
					hook.scope === 'namespace'
						? `Every repository under ${hook.path} now sends its events to Skiff.`
						: `${hook.path} now sends its events to Skiff.`
			};
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	},

	removeWebhook: async ({ request, locals }) => {
		const data = await request.formData();
		try {
			await core.forges.removeWebhook(locals.principal!, text(data, 'id'), text(data, 'webhookId'));
			return { success: 'Webhook removed.' };
		} catch (cause) {
			return fail(400, { message: message(cause) });
		}
	}
};
