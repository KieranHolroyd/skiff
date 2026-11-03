import type { DeploymentView, NodeView, StatusSummary } from '@skiff/core';
import type { PageServerLoad } from './$types';
import { core } from '#lib/server/core.js';

/**
 * Fleet overview (DESIGN §8): a small, cheap summary built from the service layer.
 * Node detail is platform-admin only, so non-admins simply get `nodesDenied: true`.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;

	let status: StatusSummary | null = null;
	try {
		status = core.metrics.status(principal);
	} catch {
		// A viewer without project:read should not be able to break the whole overview.
	}

	const projects = core.projects.list(principal);

	let nodes: NodeView[] = [];
	let nodesDenied = false;
	try {
		nodes = core.nodes.list(principal);
	} catch {
		nodesDenied = true;
	}

	const recent: DeploymentView[] = [];
	for (const project of projects.slice(0, 40)) {
		try {
			const row = core.projects.requireRow(principal, project.slug);
			recent.push(...core.deployments.list(principal, row, { limit: 5 }));
		} catch {
			// One inaccessible project should not hide the rest of the fleet.
		}
	}
	recent.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

	return {
		status,
		projects: projects.slice(0, 5),
		projectCount: projects.length,
		nodes,
		nodesDenied,
		deployments: recent.slice(0, 12)
	};
};
