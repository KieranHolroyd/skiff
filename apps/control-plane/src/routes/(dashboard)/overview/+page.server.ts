import type { BuildView, DatabaseView, DomainView, StorageView } from '@skiff/contracts';
import type { DeploymentView, NodeView, StatusSummary } from '@skiff/core';
import type { PageServerLoad } from './$types';
import { core } from '#lib/server/core.js';
import { trafficRanges, parseTrafficRange, trafficRangeHref } from '#lib/server/traffic-range.js';
import { buildAttention } from './attention.js';
import { summariseResources } from './resources.js';

/** One row of the activity feed: a deployment or a git build. */
export type ActivityItem =
	| { kind: 'deployment'; at: string; deployment: DeploymentView }
	| { kind: 'build'; at: string; build: BuildView };

export interface DataService {
	kind: 'database' | 'storage';
	name: string;
	status: string;
	label: string;
	nodeName: string | null;
	usedBytes: number | null;
	budgetBytes: number;
	/** Databases: last backup outcome. Storage: bucket count. */
	note: string | null;
	noteTone: 'danger' | 'muted';
}

const MB = 1024 * 1024;

/** Run a read that some principals are not allowed to make; denied reads become `fallback`. */
function attempt<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

/**
 * Fleet overview (DESIGN §8): a cheap summary built from the service layer. Every read is
 * permission-checked by the service, so a narrow principal sees a smaller page, never an error.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const principal = locals.principal!;
	const now = Date.now();

	const status: StatusSummary | null = attempt(() => core.metrics.status(principal), null);
	const everything = core.projects.list(principal);
	// Functions are their own product (D110); the Projects card and counts leave them out.
	const projects = everything.filter((project) => project.runtime !== 'function');

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

	let nodesDenied = false;
	let nodes: NodeView[] = [];
	try {
		nodes = core.nodes.list(principal);
	} catch {
		nodesDenied = true;
	}

	// Capacity is platform-level: only an admin can see other nodes' slice budgets.
	let capacity: { sliceMemoryMb: number; reservedMemoryMb: number; workloads: number } | null =
		null;
	if (core.ctx.platformIam.canView(principal)) {
		const rows = attempt(() => core.workloads.capacity(principal), null);
		if (rows)
			capacity = {
				sliceMemoryMb: rows.reduce((sum, item) => sum + item.sliceMemoryMb, 0),
				reservedMemoryMb: rows.reduce((sum, item) => sum + item.reservedMemoryMb, 0),
				workloads: rows.reduce((sum, item) => sum + item.workloadCount, 0)
			};
	}

	const domains: DomainView[] | null = attempt(() => core.domains.list(principal), null);
	const databases: DatabaseView[] | null = attempt(() => core.databases.list(principal), null);
	const storage: StorageView[] | null = attempt(() => core.storage.list(principal), null);
	const usage = await Promise.resolve(attempt(() => core.usage.view(principal), null)).catch(
		() => null
	);

	const deployments: DeploymentView[] = [];
	const builds: BuildView[] = [];
	let buildsReadable = everything.length === 0;
	for (const project of everything.slice(0, 40)) {
		const row = attempt(() => core.projects.requireRow(principal, project.slug), null);
		if (!row) continue;
		deployments.push(...attempt(() => core.deployments.list(principal, row, { limit: 5 }), []));
		const projectBuilds = attempt(() => core.builds.list(principal, row, { limit: 10 }), null);
		if (projectBuilds) {
			buildsReadable = true;
			builds.push(...projectBuilds);
		}
	}
	deployments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	builds.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	const activeBuilds = builds.filter(
		(build) => build.status === 'queued' || build.status === 'building'
	);

	const attention = buildAttention({
		now,
		nodes,
		databases,
		storage,
		deployments,
		builds,
		domains,
		quotaWarnings: usage?.warnings ?? []
	});

	// --- data services ------------------------------------------------------------------------

	const dataServices: DataService[] = [
		...(databases ?? []).map((db): DataService => ({
			kind: 'database',
			name: db.name,
			status: db.status,
			label: `${db.engineLabel} ${db.version}`,
			nodeName: db.nodeName,
			usedBytes: db.sizeBytes,
			budgetBytes: db.storageMb * MB,
			note:
				db.backup.lastBackupStatus === 'failed'
					? 'Last backup failed'
					: db.backup.lastBackupAt
						? null
						: db.backup.enabled
							? 'No backup yet'
							: 'Backups off',
			noteTone: db.backup.lastBackupStatus === 'failed' ? 'danger' : 'muted'
		})),
		...(storage ?? []).map((st): DataService => ({
			kind: 'storage',
			name: st.name,
			status: st.status,
			label: `${st.buckets.length} ${st.buckets.length === 1 ? 'bucket' : 'buckets'}${st.public ? ' · public' : ''}`,
			nodeName: st.nodeName,
			usedBytes: st.usedBytes,
			budgetBytes: st.storageMb * MB,
			note: null,
			noteTone: 'muted'
		}))
	];

	const activity: ActivityItem[] = [
		...deployments.map((deployment) => ({
			kind: 'deployment' as const,
			at: deployment.createdAt,
			deployment
		})),
		// Successful builds are followed by a deployment row; show builds that are running or failed.
		...builds
			.filter((build) => build.status !== 'succeeded')
			.map((build) => ({ kind: 'build' as const, at: build.createdAt, build }))
	]
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		.slice(0, 10);

	return {
		status,
		projects: [...projects]
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
			.slice(0, 6),
		projectCount: projects.length,
		liveProjects: projects.filter((project) => project.productionDeploymentId !== null).length,
		traffic,
		trafficRange,
		trafficRanges,
		trafficLinks,
		projectNames,
		nodes,
		nodesDenied,
		resources: nodesDenied ? null : summariseResources(nodes, now),
		capacity,
		domains: domains
			? {
					total: domains.length,
					live: domains.filter((d) => d.status === 'verified' || d.status === 'active').length
				}
			: null,
		databases: databases
			? {
					total: databases.length,
					running: databases.filter((db) => db.status === 'running').length,
					bytes: databases.reduce((sum, db) => sum + (db.sizeBytes ?? 0), 0)
				}
			: null,
		storage: storage
			? {
					total: storage.length,
					running: storage.filter((st) => st.status === 'running').length,
					bytes: storage.reduce((sum, st) => sum + (st.usedBytes ?? 0), 0),
					objects: storage.reduce((sum, st) => sum + (st.objects ?? 0), 0)
				}
			: null,
		dataServices,
		builds: { active: activeBuilds.length, readable: buildsReadable },
		activity,
		attention
	};
};
