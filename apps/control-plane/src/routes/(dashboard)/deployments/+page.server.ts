import type { DeploymentView } from '@yoal/core';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/** Recent deployments across the org, optionally narrowed to one project. */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const projects = core.projects.list(principal);
	const filter = url.searchParams.get('project') ?? '';
	const project = filter ? projects.find((candidate) => candidate.slug === filter) : undefined;
	const scoped = project ? [project] : filter ? [] : projects;

	const deployments: DeploymentView[] = [];
	for (const candidate of scoped) {
		try {
			const row = core.projects.requireRow(principal, candidate.slug);
			deployments.push(...core.deployments.list(principal, row, { limit: 50 }));
		} catch {
			// Skip a project this principal cannot read rather than failing the whole list.
		}
	}
	deployments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

	return {
		projects,
		deployments: deployments.slice(0, 150),
		filter,
		filterMissing: filter.length > 0 && !project
	};
};
