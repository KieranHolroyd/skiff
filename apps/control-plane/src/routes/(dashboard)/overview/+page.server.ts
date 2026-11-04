import type { DeploymentView, NodeView, StatusSummary } from '@skiff/core';
import type { PageServerLoad } from './$types';
import { core } from '#lib/server/core.js';
import { trafficRanges, parseTrafficRange, trafficRangeHref } from '#lib/server/traffic-range.js';

interface V2Summary {
	capacity: {
		nodes: number;
		sliceMemoryMb: number;
		reservedMemoryMb: number;
		freeMemoryMb: number;
		workloads: number;
	} | null;
	domains: {
		total: number;
		verified: number;
	} | null;
	builds: {
		active: number;
		readable: boolean;
	};
}

/**
 * Fleet overview (DESIGN §8): a small, cheap summary built from the service layer.
 * Node detail is platform-admin only, so non-admins simply get `nodesDenied: true`.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const principal = locals.principal!;

	let status: StatusSummary | null = null;
	try {
		status = core.metrics.status(principal);
	} catch {
		// A viewer without project:read should not be able to break the whole overview.
	}

	const projects = core.projects.list(principal);

	const trafficRange = parseTrafficRange(url.searchParams.get('range'));
	const traffic = await core.metrics.trafficOverview(principal, {
		from: trafficRange.from,
		to: trafficRange.to,
		interval: trafficRange.interval
	});
	const trafficLinks = Object.fromEntries(
		trafficRanges.map((range) => [range.key, trafficRangeHref(url, range.key)])
	);
	const projectNames = Object.fromEntries(
		core.projects
			.list(principal, { includeDeleted: true })
			.map((project) => [project.id, { name: project.name, slug: project.slug }])
	);

	let nodes: NodeView[] = [];
	let nodesDenied = false;
	try {
		nodes = core.nodes.list(principal);
	} catch {
		nodesDenied = true;
	}

	const v2: V2Summary = {
		capacity: null,
		domains: null,
		builds: { active: 0, readable: true }
	};

	// Capacity is platform-level: only an admin can see other nodes' slice budgets.
	if (principal.platformAdmin === true) {
		try {
			const capacity = core.workloads.capacity(principal);
			v2.capacity = {
				nodes: capacity.length,
				sliceMemoryMb: capacity.reduce((sum, item) => sum + item.sliceMemoryMb, 0),
				reservedMemoryMb: capacity.reduce((sum, item) => sum + item.reservedMemoryMb, 0),
				freeMemoryMb: capacity.reduce((sum, item) => sum + item.freeMemoryMb, 0),
				workloads: capacity.reduce((sum, item) => sum + item.workloadCount, 0)
			};
		} catch {
			// A missing platform permission must not break the overview.
		}
	}

	// Org-wide custom domains; `domain:read` is denied to some token scopes.
	try {
		const domains = core.domains.list(principal);
		v2.domains = {
			total: domains.length,
			verified: domains.filter(
				(domain) => domain.status === 'verified' || domain.status === 'active'
			).length
		};
	} catch {
		// Leave domains null so the UI can say the data is not visible.
	}

	const recent: DeploymentView[] = [];
	let activeBuilds = 0;
	let buildsReadable = false;
	for (const project of projects.slice(0, 40)) {
		let row: ReturnType<typeof core.projects.requireRow>;
		try {
			row = core.projects.requireRow(principal, project.slug);
		} catch {
			continue;
		}
		try {
			recent.push(...core.deployments.list(principal, row, { limit: 5 }));
		} catch {
			// One inaccessible project should not hide the rest of the fleet.
		}
		try {
			for (const build of core.builds.list(principal, row, { limit: 10 })) {
				if (build.status === 'queued' || build.status === 'building') activeBuilds += 1;
			}
			buildsReadable = true;
		} catch {
			// `build:read` can be narrower than `project:read`; skip the project.
		}
	}
	recent.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	v2.builds = { active: activeBuilds, readable: projects.length === 0 || buildsReadable };

	return {
		status,
		projects: projects.slice(0, 5),
		projectCount: projects.length,
		traffic,
		trafficRange,
		trafficRanges,
		trafficLinks,
		projectNames,
		nodes,
		nodesDenied,
		deployments: recent.slice(0, 12),
		v2
	};
};
