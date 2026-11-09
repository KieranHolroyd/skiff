import { error, fail, redirect } from '@sveltejs/kit';
import { CoreError, isFunctionTier } from '@yoal/core';
import { hasPermission, type WorkloadView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { parseTrafficRange, trafficRangeHref, trafficRanges } from '#lib/server/traffic-range.js';
import { failStatus, formString, toFormFailure } from '../../../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * One deployment as its own resource (like a database): what it is, which hosts serve it, its
 * traffic, and its runtime and build logs. Mutations reuse the same core calls as the project's
 * deployment table.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const principal = locals.principal!;
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
	// Functions have their own console (D110).
	if (isFunctionTier(row))
		redirect(
			307,
			`/functions/${encodeURIComponent(params.slug)}/deployments/${encodeURIComponent(deployment.id)}`
		);
	// Short-id links are canonicalised so tabs and range links share one URL.
	if (params.id !== deployment.id)
		redirect(
			307,
			`/projects/${encodeURIComponent(params.slug)}/deployments/${encodeURIComponent(deployment.id)}${url.search}`
		);

	// Traffic for one host: an environment host this deployment serves, or its preview host.
	const hosts = [
		...deployment.serving.map((item) => ({
			host: item.host,
			label: item.environmentName,
			kind: 'serving' as const
		})),
		{ host: deployment.previewHost, label: 'Preview', kind: 'preview' as const }
	];
	const requestedHost = url.searchParams.get('host');
	const host = hosts.find((item) => item.host === requestedHost) ?? hosts[0]!;
	const range = parseTrafficRange(url.searchParams.get('range'));
	let traffic;
	try {
		traffic = await core.metrics.trafficForDeployment(
			principal,
			params.slug,
			deployment.id,
			host.host,
			{
				from: range.from,
				to: range.to,
				interval: range.interval
			}
		);
	} catch {
		traffic = null;
	}
	const rangeLinks = Object.fromEntries(
		trafficRanges.map((item) => [item.key, trafficRangeHref(url, item.key, { tab: 'metrics' })])
	);
	const hostLinks = Object.fromEntries(
		hosts.map((item) => {
			const next = new URL(url);
			next.searchParams.set('tab', 'metrics');
			next.searchParams.set('host', item.host);
			return [item.host, `${next.pathname}${next.search}`];
		})
	);

	let workload: WorkloadView | null;
	try {
		workload = core.workloads.get(principal, row);
	} catch {
		workload = null;
	}

	return {
		project,
		deployment,
		// The project's one workload (D44) only describes this deployment while it runs it.
		workload: workload?.deploymentId === deployment.id ? workload : null,
		runningDeploymentId: workload?.deploymentId ?? null,
		traffic,
		range,
		ranges: trafficRanges,
		rangeLinks,
		hosts,
		host: host.host,
		hostLinks,
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
		redirect(303, `/projects/${encodeURIComponent(params.slug)}?tab=deployments`);
	}
};
