import { error, fail } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import type { PipelineRepositoryView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { formRawString, formString } from '../../_lib/errors.js';
import { attempt, parseKeyValueLines, pipelineCan } from '../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

const STATUSES = new Set(['queued', 'in_progress', 'completed']);

export const load: PageServerLoad = ({ locals, params, url }) => {
	const principal = locals.principal!;
	let repository: PipelineRepositoryView;
	try {
		repository = core.pipelines.getRepository(principal, params.repo);
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
	const status = STATUSES.has(url.searchParams.get('status') ?? '') ? url.searchParams.get('status')! : '';
	const workflow = url.searchParams.get('workflow') ?? '';
	const runs = core.pipelines.listRuns(principal, params.repo, {
		status: status || undefined,
		workflow: workflow || undefined,
		limit: 50
	});
	// Workflow choices for the filter: whatever has run recently, plus the current pick.
	const recent = status || workflow ? core.pipelines.listRuns(principal, params.repo, { limit: 100 }) : runs;
	const workflows = [
		...new Map(
			[...recent, ...runs].map((run) => [run.workflowPath, { path: run.workflowPath, name: run.workflowName }])
		).values()
	];
	if (workflow && !workflows.some((item) => item.path === workflow)) workflows.push({ path: workflow, name: workflow });
	return {
		repository,
		runs,
		triggers: core.pipelines.listTriggers(principal, params.repo, 20),
		filter: { status, workflow },
		workflows,
		webhookUrl: `${platformOrigin}${repository.webhookPath}`,
		can: pipelineCan(principal)
	};
};

export const actions: Actions = {
	dispatch: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const workflow = formString(data, 'workflow');
		const workflowText = formRawString(data, 'workflowText').trim();
		const ref = formString(data, 'ref');
		if (Boolean(workflow) === Boolean(workflowText))
			return fail(400, { message: 'Pick a workflow file or paste inline YAML, not both.' });
		const inputs = parseKeyValueLines(formRawString(data, 'inputs'));
		if (inputs.error) return fail(400, { message: `Inputs: ${inputs.error}` });
		const result = await attempt(() =>
			core.pipelines.dispatch(principal, params.repo, {
				workflow: workflow || undefined,
				workflowText: workflowText ? `${workflowText}\n` : undefined,
				ref: ref || undefined,
				inputs: inputs.values
			})
		);
		if (!result.ok) return result.failure;
		return { success: `Reading the workflow at ${result.value.ref}. The run appears here in a moment.` };
	}
};
