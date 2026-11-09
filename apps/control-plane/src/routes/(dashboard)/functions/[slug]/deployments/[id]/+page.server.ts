import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError, isFunctionTier } from '@yoal/core';
import { hasPermission, type WorkloadView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { failStatus, formString, toFormFailure } from '../../../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/** One deployment of a function: its bundle snapshot, the hosts serving it, logs and source. */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
	if (!features.FUNCTIONS) error(404, 'Functions are not enabled on this platform.');
	let project;
	let row;
	let deployment;
	try {
		project = await core.projects.get(principal, params.slug);
		row = core.projects.requireRow(principal, params.slug);
		deployment = core.deployments.detail(principal, row, params.id);
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
	const path = (slug: string, id: string) =>
		`${encodeURIComponent(slug)}/deployments/${encodeURIComponent(id)}${url.search}`;
	if (!isFunctionTier(row)) redirect(307, `/projects/${path(params.slug, deployment.id)}`);
	// Short-id links are canonicalised so tabs share one URL.
	if (params.id !== deployment.id) redirect(307, `/functions/${path(params.slug, deployment.id)}`);

	let workload: WorkloadView | null;
	try {
		workload = core.workloads.get(principal, row);
	} catch {
		workload = null;
	}

	return {
		project,
		deployment,
		workload: workload?.deploymentId === deployment.id ? workload : null,
		runningDeploymentId: workload?.deploymentId ?? null,
		can: {
			promote: hasPermission(principal, 'deployment:promote'),
			delete: hasPermission(principal, 'deployment:delete'),
			readLogs: hasPermission(principal, 'logs:read')
		}
	};
};

export const actions: Actions = {
	promote: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.promote(principal, project, params.id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Production pointer moved. Traffic switches on the next reconcile.' };
	},

	pin: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const pinned = formString(await request.formData(), 'pinned') === 'true';
		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.setPinned(principal, project, params.id, pinned);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: pinned ? 'Deployment pinned; retention will keep it.' : 'Deployment unpinned.'
		};
	},

	delete: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.delete(principal, project, params.id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		redirect(303, `/functions/${encodeURIComponent(params.slug)}?tab=deployments`);
	}
};
