import { fail, redirect } from '@sveltejs/kit';
import {
	pipelineRepositoryCreateSchema,
	type PipelineRepositoryView,
	type PipelineRunSummary
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { formString } from '../_lib/errors.js';
import { fieldErrorsFrom } from '../databases/_lib/forms.server.js';
import { attempt, pipelineCan } from './_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/** Pipelines (docs/PIPELINES.md §8): repositories and recent runs. Every check lives in `core.pipelines`. */
export const load: PageServerLoad = ({ locals, depends }) => {
	depends('yoal:pipelines');
	const principal = locals.principal!;
	let repositories: PipelineRepositoryView[] = [];
	let recent: PipelineRunSummary[] = [];
	let denied = false;
	/**
	 * D172/D177: a push with `.yoal/workflows` adds its repository here, through the GitHub App or a
	 * forge connection's group/organisation webhook. Lists what delivers such pushes, for the hint.
	 */
	let automatic: string[] = [];
	try {
		repositories = core.pipelines.listRepositories(principal);
		recent = core.pipelines.recentRuns(principal, 15);
		if (core.pipelines.autoSetup(principal).enabled) {
			if (core.githubApp.installations(principal).some((entry) => entry.orgId === principal.orgId && !entry.suspended))
				automatic.push('Yoal’s GitHub App');
			for (const connection of core.forges.list(principal))
				if (connection.webhooks.some((hook) => hook.scope === 'namespace' && hook.hookId))
					automatic.push(`a watched ${connection.kind === 'gitlab' ? 'group' : 'organisation'} on ${connection.name}`);
		}
	} catch {
		denied = true;
	}
	return { repositories, recent, denied, automatic, origin: platformOrigin, can: pipelineCan(principal) };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const values = {
			name: formString(data, 'name'),
			cloneUrl: formString(data, 'cloneUrl'),
			// Blank lets the control plane infer it from the URL (GitHub, a connected forge, else generic).
			provider: formString(data, 'provider'),
			defaultBranch: formString(data, 'defaultBranch') || 'main',
			defaultImage: formString(data, 'defaultImage')
		};
		const webhookSecret = formString(data, 'webhookSecret');
		const input = {
			...values,
			webhookSecret: webhookSecret || undefined,
			provider: values.provider || undefined,
			defaultImage: values.defaultImage || undefined
		};
		const parsed = pipelineRepositoryCreateSchema.safeParse(input);
		if (!parsed.success)
			return fail(400, {
				message: 'Check the highlighted fields.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues),
				values
			});
		const result = await attempt(() => core.pipelines.createRepository(principal, parsed.data));
		if (!result.ok) return result.failure;
		redirect(303, `/pipelines/${encodeURIComponent(result.value.name)}`);
	}
};
