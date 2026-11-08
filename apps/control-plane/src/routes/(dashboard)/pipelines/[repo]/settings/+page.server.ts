import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import type {
	PipelineEnvironmentView,
	PipelineProjectLinkView,
	PipelineRepositoryView,
	PipelineSecretView,
	PipelineVariableView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { formBoolean, formRawString, formString } from '../../../_lib/errors.js';
import { attempt, lines, pipelineCan } from '../../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/** Read a list the viewer may not have permission for; the section then shows as unavailable. */
function optional<T>(read: () => T[]): T[] | null {
	try {
		return read();
	} catch {
		return null;
	}
}

export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let repository: PipelineRepositoryView;
	try {
		repository = core.pipelines.getRepository(principal, params.repo);
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
	const can = pipelineCan(principal);
	const secrets: PipelineSecretView[] | null = optional(() => core.pipelines.listSecrets(principal, params.repo));
	const variables: PipelineVariableView[] | null = optional(() => core.pipelines.listVariables(principal, params.repo));
	const environments: PipelineEnvironmentView[] = optional(() => core.pipelines.listEnvironments(principal, params.repo)) ?? [];
	const links: PipelineProjectLinkView[] = optional(() => core.pipelines.listProjectLinks(principal, params.repo)) ?? [];
	const linked = new Set(links.map((link) => link.projectSlug));
	const projects = can.link
		? (optional(() => core.projects.list(principal)) ?? [])
				.filter((project) => !linked.has(project.slug))
				.map((project) => ({ slug: project.slug, name: project.name, runtime: project.runtime }))
		: [];
	return {
		repository,
		secrets,
		variables,
		environments,
		links,
		projects,
		webhookUrl: `${platformOrigin}${repository.webhookPath}`,
		can
	};
};

export const actions: Actions = {
	update: async ({ request, locals, params }) => {
		const data = await request.formData();
		const defaultImage = formString(data, 'defaultImage');
		const result = await attempt(() =>
			core.pipelines.updateRepository(locals.principal!, params.repo, {
				cloneUrl: formString(data, 'cloneUrl'),
				defaultBranch: formString(data, 'defaultBranch'),
				defaultImage: defaultImage || null,
				enabled: formBoolean(data, 'enabled')
			})
		);
		if (!result.ok) return result.failure;
		return { success: 'Repository saved.' };
	},

	setWebhookSecret: async ({ request, locals, params }) => {
		const secret = formRawString(await request.formData(), 'webhookSecret').trim();
		if (secret.length < 16) return fail(400, { message: 'Use at least 16 characters.' });
		const result = await attempt(() =>
			core.pipelines.updateRepository(locals.principal!, params.repo, { webhookSecret: secret })
		);
		if (!result.ok) return result.failure;
		return { success: 'Webhook secret saved. Use the same value in GitHub.' };
	},

	clearWebhookSecret: async ({ locals, params }) => {
		const result = await attempt(() =>
			core.pipelines.updateRepository(locals.principal!, params.repo, { webhookSecret: null })
		);
		if (!result.ok) return result.failure;
		return { success: 'Webhook secret cleared.' };
	},

	setStatusToken: async ({ request, locals, params }) => {
		const token = formRawString(await request.formData(), 'statusToken').trim();
		if (token.length < 10) return fail(400, { message: 'Paste a GitHub token.' });
		const result = await attempt(() =>
			core.pipelines.updateRepository(locals.principal!, params.repo, { statusToken: token })
		);
		if (!result.ok) return result.failure;
		return { success: 'Status token saved. Runs now report commit statuses.' };
	},

	clearStatusToken: async ({ locals, params }) => {
		const result = await attempt(() =>
			core.pipelines.updateRepository(locals.principal!, params.repo, { statusToken: null })
		);
		if (!result.ok) return result.failure;
		return { success: 'Status token cleared.' };
	},

	setIsolation: async ({ request, locals, params }) => {
		const data = await request.formData();
		const tier = (name: string) => {
			const value = formString(data, name);
			return value === 'container' || value === 'gvisor' || value === 'microvm' || value === 'sandbox' ? value : null;
		};
		const result = await attempt(() =>
			core.pipelines.updateRepository(locals.principal!, params.repo, {
				minIsolation: { trusted: tier('trusted'), untrusted: tier('untrusted') }
			})
		);
		if (!result.ok) return result.failure;
		return { success: 'Isolation minimums saved.' };
	},

	setSecret: async ({ request, locals, params }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		const environment = formString(data, 'environment');
		const value = formRawString(data, 'value');
		if (!name) return fail(400, { message: 'A secret name is required.' });
		const result = await attempt(() =>
			core.pipelines.setSecret(locals.principal!, params.repo, name, {
				value,
				environment: environment || undefined
			})
		);
		if (!result.ok) return result.failure;
		return { success: `Secret ${result.value.name} saved.` };
	},

	deleteSecret: async ({ request, locals, params }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		const environment = formString(data, 'environment');
		const result = await attempt(() =>
			core.pipelines.deleteSecret(locals.principal!, params.repo, name, environment || null)
		);
		if (!result.ok) return result.failure;
		return { success: `Secret ${name} deleted.` };
	},

	setVariable: async ({ request, locals, params }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		if (!name) return fail(400, { message: 'A variable name is required.' });
		const result = await attempt(() =>
			core.pipelines.setVariable(locals.principal!, params.repo, name, formRawString(data, 'value'))
		);
		if (!result.ok) return result.failure;
		return { success: `Variable ${result.value.name} saved.` };
	},

	deleteVariable: async ({ request, locals, params }) => {
		const name = formString(await request.formData(), 'name');
		const result = await attempt(() => core.pipelines.deleteVariable(locals.principal!, params.repo, name));
		if (!result.ok) return result.failure;
		return { success: `Variable ${name} deleted.` };
	},

	setEnvironment: async ({ request, locals, params }) => {
		const data = await request.formData();
		const name = formString(data, 'name');
		if (!name) return fail(400, { message: 'An environment name is required.' });
		const result = await attempt(() =>
			core.pipelines.setEnvironment(locals.principal!, params.repo, name, {
				allowedRefs: lines(formRawString(data, 'allowedRefs')),
				requireApproval: formBoolean(data, 'requireApproval')
			})
		);
		if (!result.ok) return result.failure;
		return { success: `Environment ${name} saved.` };
	},

	deleteEnvironment: async ({ request, locals, params }) => {
		const name = formString(await request.formData(), 'name');
		const result = await attempt(() => core.pipelines.deleteEnvironment(locals.principal!, params.repo, name));
		if (!result.ok) return result.failure;
		return { success: `Environment ${name} deleted.` };
	},

	link: async ({ request, locals, params }) => {
		const data = await request.formData();
		const slug = formString(data, 'project');
		if (!slug) return fail(400, { message: 'Pick a project.' });
		const environment = formString(data, 'environment');
		const result = await attempt(() =>
			core.pipelines.linkProject(locals.principal!, params.repo, slug, { environment: environment || null })
		);
		if (!result.ok) return result.failure;
		return { success: `${result.value.projectName} can now be deployed from this repository.` };
	},

	unlink: async ({ request, locals, params }) => {
		const slug = formString(await request.formData(), 'project');
		const result = await attempt(() => core.pipelines.unlinkProject(locals.principal!, params.repo, slug));
		if (!result.ok) return result.failure;
		return { success: `${slug} unlinked.` };
	},

	delete: async ({ request, locals, params }) => {
		const confirm = formString(await request.formData(), 'confirm');
		if (confirm !== params.repo) return fail(400, { message: 'Type the repository name to confirm.' });
		const result = await attempt(() => core.pipelines.deleteRepository(locals.principal!, params.repo));
		if (!result.ok) return result.failure;
		redirect(303, '/pipelines');
	}
};
