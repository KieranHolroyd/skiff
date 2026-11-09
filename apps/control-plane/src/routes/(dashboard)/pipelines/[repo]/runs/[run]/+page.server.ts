import { error, fail } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { formBoolean, formString } from '../../../../_lib/errors.js';
import type { RunDetail } from '../../../_lib/api.js';
import { attempt, pipelineCan } from '../../../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const principal = locals.principal!;
	let run: RunDetail;
	try {
		// `getRun` spreads `runSummary`, which also carries the run-level `error` (invalid workflow).
		run = await core.pipelines.getRun(principal, params.repo, params.run);
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
	return {
		repo: params.repo,
		run,
		crumbLabel: `#${run.number}`,
		can: pipelineCan(principal)
	};
};

export const actions: Actions = {
	cancel: async ({ locals, params }) => {
		const result = await attempt(() => core.pipelines.cancelRun(locals.principal!, params.repo, params.run));
		if (!result.ok) return result.failure;
		return { success: 'Cancelling. Running jobs stop after their cleanup steps.' };
	},

	rerun: async ({ request, locals, params }) => {
		const failedOnly = formBoolean(await request.formData(), 'failedOnly');
		const result = await attempt(() =>
			core.pipelines.rerun(locals.principal!, params.repo, params.run, failedOnly)
		);
		if (!result.ok) return result.failure;
		return { success: failedOnly ? 'Re-running failed jobs.' : 'Re-running all jobs.' };
	},

	approve: async ({ request, locals, params }) => {
		const data = await request.formData();
		const jobId = formString(data, 'jobId');
		if (!jobId) return fail(400, { message: 'Missing job.' });
		const approve = formString(data, 'decision') !== 'reject';
		const result = await attempt(() =>
			core.pipelines.approveJob(locals.principal!, params.repo, params.run, jobId, approve)
		);
		if (!result.ok) return result.failure;
		return { success: approve ? 'Approved. The job is queued.' : 'Rejected. The job will not run.' };
	}
};
