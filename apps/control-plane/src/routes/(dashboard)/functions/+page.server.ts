import { fail } from '@sveltejs/kit';
import { hasPermission, type FunctionView, type WorkloadStatus } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { secretBindings, secretIndex } from '../_lib/function-view.js';
import { failStatus, formString, toFormFailure } from '../_lib/errors.js';
import { summariseTraffic, type FunctionMetrics } from './_lib/function-metrics.js';
import type { Actions, PageServerLoad } from './$types';

/** One function as the console list shows it. No secret values, only names. */
export interface FunctionListItem {
	slug: string;
	name: string;
	productionUrl: string;
	createdAt: string;
	view: FunctionView | null;
	workload: {
		status: WorkloadStatus;
		nodeId: string | null;
		nodeName: string | null;
		memoryMb: number;
		replicas: number;
		message: string | null;
		updatedAt: string;
	} | null;
	/** The newest deployment, whichever environment it went to. */
	lastDeploy: { id: string; shortId: string; createdAt: string; isProduction: boolean } | null;
	/** Store secrets a binding names that no longer exist for the function. */
	missingSecrets: string[];
}

/** Rows whose request metrics are fetched; beyond this the list shows dashes. */
const METRICS_LIMIT = 50;
const METRICS_HOURS = 24;

/**
 * The Functions console list (D110, docs/FUNCTIONS.md §4.11): every function with its host state,
 * last deploy and anything wrong with it. Request metrics are streamed so a slow telemetry store
 * never holds up the list.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	const enabled = features.FUNCTIONS;
	const none: Promise<Record<string, FunctionMetrics>> = Promise.resolve({});
	if (!enabled)
		return { enabled, items: [], trash: [], denied: false, metrics: none, metricsPermitted: false };

	let projects: ReturnType<typeof core.projects.list> = [];
	let trash: Array<{ slug: string; name: string; purgeAt: string | null }> = [];
	let denied = false;
	try {
		projects = core.projects.list(principal).filter((project) => project.runtime === 'function');
		trash = core.projects
			.list(principal, { onlyDeleted: true })
			.filter((project) => project.runtime === 'function')
			.map((project) => ({ slug: project.slug, name: project.name, purgeAt: project.purgeAt }));
	} catch {
		denied = true;
	}

	// Node names come from capacity, which only platform admins can read.
	const nodeNames = new Map<string, string>();
	if (core.ctx.platformIam.canView(principal)) {
		try {
			for (const node of core.workloads.capacity(principal)) nodeNames.set(node.nodeId, node.name);
		} catch {
			// Ids are shown instead.
		}
	}
	const canReadSecrets = hasPermission(principal, 'secret:read-metadata');

	const items: FunctionListItem[] = projects.map((project) => {
		const item: FunctionListItem = {
			slug: project.slug,
			name: project.name,
			productionUrl: project.productionUrl,
			createdAt: project.createdAt,
			view: null,
			workload: null,
			lastDeploy: null,
			missingSecrets: []
		};
		try {
			const row = core.projects.requireRow(principal, project.slug);
			item.view = core.functions.view(principal, row);
			const current = core.workloads.get(principal, row);
			if (current)
				item.workload = {
					status: current.status,
					nodeId: current.nodeId,
					nodeName: current.nodeId ? (nodeNames.get(current.nodeId) ?? null) : null,
					memoryMb: current.memoryMb,
					replicas: current.replicas,
					message: current.message,
					updatedAt: current.updatedAt
				};
			const latest = core.deployments.list(principal, row, { limit: 1 })[0];
			if (latest)
				item.lastDeploy = {
					id: latest.id,
					shortId: latest.shortId,
					createdAt: latest.createdAt,
					isProduction: latest.isProduction
				};
			if (item.view && canReadSecrets) {
				const index = secretIndex(core.secrets.list(principal, { visibleTo: row.id }), row.id);
				item.missingSecrets = [
					...new Set(secretBindings(item.view.bindings).map((binding) => binding.secret))
				].filter((name) => !index.has(name));
			}
		} catch {
			// A viewer without deployment:read still sees the function in the list.
		}
		return item;
	});

	const metricsPermitted = hasPermission(principal, 'metrics:read');
	// Inclusive hourly bucket starts: the current hour plus the 23 before it.
	const to = Math.floor(Date.now() / 3_600_000) * 3_600_000;
	const from = to - (METRICS_HOURS - 1) * 3_600_000;
	const metrics: Promise<Record<string, FunctionMetrics>> = metricsPermitted
		? Promise.all(
				items
					.filter((item) => item.lastDeploy !== null)
					.slice(0, METRICS_LIMIT)
					.map(async (item) => {
						const traffic = await core.metrics
							.trafficForProject(principal, item.slug, { from, to, interval: '1h' })
							.catch(() => null);
						if (!traffic?.available) return null;
						return [
							item.slug,
							summariseTraffic(traffic.report, { from, hours: METRICS_HOURS })
						] as const;
					})
			).then((rows) =>
				Object.fromEntries(rows.filter((row): row is NonNullable<typeof row> => row !== null))
			)
		: none;

	return { enabled, items, trash, denied, metrics, metricsPermitted };
};

export const actions: Actions = {
	/** Bring a deleted function back from the trash before it is purged. */
	restore: async ({ request, locals }) => {
		const principal = locals.principal!;
		const slug = formString(await request.formData(), 'slug');
		if (!slug) return fail(400, { message: 'Missing function slug.' });
		try {
			await core.projects.restore(principal, slug);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: `“${slug}” restored. Deploy or promote to serve it again.` };
	}
};
