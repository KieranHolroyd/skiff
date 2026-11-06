import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { deployments, nodes, projects, releases } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ValidationError } from './errors.ts';
import { requirePermission } from '@skiff/contracts';
import {
	TELEMETRY_NOT_INSTALLED,
	emptyTrafficReport,
	type TelemetryInterval,
	type TimeInput,
	type TrafficReport,
} from './telemetry.ts';

export interface StatusSummary {
	nodes: { total: number; online: number; offline: number };
	projects: number;
	deployments: { active: number; total: number };
	storageBytes: number;
	versions: { controlPlane: string; agent: string };
}

export interface TrafficWindow {
	from: TimeInput;
	to: TimeInput;
	interval: TelemetryInterval;
}

/** Dashboard payload: `available` separates "ClickHouse is down" from "quiet period". */
export interface TrafficView {
	permitted: boolean;
	available: boolean;
	report: TrafficReport;
	/** Why telemetry is unavailable, when it is not. */
	reason?: string;
	/** False when the optional telemetry store is not installed (a normal state, D101). */
	installed?: boolean;
}

function unavailableReason(telemetry: { error: Error | null } | undefined): string {
	return telemetry?.error?.message ?? TELEMETRY_NOT_INSTALLED;
}

export class MetricsService {
	constructor(
		private readonly ctx: CoreContext,
		private readonly version = '0.1.0',
	) {}

	status(principal: Principal): StatusSummary {
		requirePermission(principal, 'project:read');
		const nodeRows = this.ctx.db.select({ status: nodes.status }).from(nodes).all();
		const deploymentsRow = this.ctx.db
			.select({
				active: sql<number>`sum(case when ${deployments.status} = 'active' then 1 else 0 end)`,
				total: sql<number>`count(*)`,
			})
			.from(deployments)
			.innerJoin(projects, eq(projects.id, deployments.projectId))
			.where(
				and(eq(deployments.orgId, principal.orgId), ne(deployments.status, 'deleted'), isNull(projects.deletedAt)),
			)
			.get();
		const projectCount = this.ctx.db
			.select({ count: sql<number>`count(*)` })
			.from(projects)
			.where(and(eq(projects.orgId, principal.orgId), isNull(projects.deletedAt)))
			.get();
		const storage = this.ctx.db
			.select({ total: sql<number>`coalesce(sum(${releases.sizeBytes}), 0)` })
			.from(releases)
			.where(eq(releases.orgId, principal.orgId))
			.get();
		return {
			nodes: {
				total: nodeRows.length,
				online: nodeRows.filter((row) => row.status === 'online').length,
				offline: nodeRows.filter((row) => row.status === 'offline').length,
			},
			projects: projectCount?.count ?? 0,
			deployments: { active: deploymentsRow?.active ?? 0, total: deploymentsRow?.total ?? 0 },
			storageBytes: storage?.total ?? 0,
			versions: { controlPlane: this.version, agent: this.ctx.config.desiredAgentVersion ?? this.version },
		};
	}

	/**
	 * ClickHouse traffic for one project (every environment host), scoped by RBAC. Returns a
	 * `permitted: false` payload instead of throwing so a read-only token without metrics
	 * visibility can still open the project page.
	 */
	async trafficForProject(
		principal: Principal,
		projectSlug: string,
		window: TrafficWindow,
	): Promise<TrafficView> {
		const empty = { permitted: false, available: false, report: emptyTrafficReport() } as const;
		if (!principal.permissions.has('metrics:read')) return { ...empty };
		requirePermission(principal, 'project:read');
		const project = this.ctx.projects.requireRow(principal, projectSlug);
		const telemetry = this.ctx.telemetry;
		if (!telemetry || !(await telemetry.ready())) {
			return { permitted: true, available: false, report: emptyTrafficReport(), reason: unavailableReason(telemetry), installed: telemetry?.installed ?? false };
		}
		const report = await telemetry.report({ ...window, projectId: project.id });
		return { permitted: true, available: true, report };
	}

	/**
	 * Traffic for one deployment, read at its preview host or at an environment host it serves
	 * now. Any other host is refused, so the host-only filter cannot reach another project. The
	 * query filters by host alone: an agent tags a bucket with its project only while the host is
	 * in its routes, so a project filter would drop a deleted preview's traffic.
	 */
	async trafficForDeployment(
		principal: Principal,
		projectSlug: string,
		deploymentId: string,
		host: string,
		window: TrafficWindow,
	): Promise<TrafficView> {
		const empty = { permitted: false, available: false, report: emptyTrafficReport() } as const;
		if (!principal.permissions.has('metrics:read')) return { ...empty };
		requirePermission(principal, 'project:read');
		const project = this.ctx.projects.requireRow(principal, projectSlug);
		const deployment = this.ctx.deployments.detail(principal, project, deploymentId);
		const hosts = [deployment.previewHost, ...deployment.serving.map((item) => item.host)];
		if (!hosts.includes(host)) throw new ValidationError('That host does not serve this deployment.');
		const telemetry = this.ctx.telemetry;
		if (!telemetry || !(await telemetry.ready())) {
			return { permitted: true, available: false, report: emptyTrafficReport(), reason: unavailableReason(telemetry), installed: telemetry?.installed ?? false };
		}
		const report = await telemetry.report({ ...window, host });
		return { permitted: true, available: true, report };
	}

	/** Fleet traffic for every project this principal can read. */
	async trafficOverview(principal: Principal, window: TrafficWindow): Promise<TrafficView> {
		if (!principal.permissions.has('metrics:read')) {
			return { permitted: false, available: false, report: emptyTrafficReport() };
		}
		requirePermission(principal, 'project:read');
		const telemetry = this.ctx.telemetry;
		if (!telemetry || !(await telemetry.ready())) {
			return { permitted: true, available: false, report: emptyTrafficReport(), reason: unavailableReason(telemetry), installed: telemetry?.installed ?? false };
		}
		const projectIds = this.ctx.projects
			.list(principal, { includeDeleted: true })
			.map((project) => project.id);
		if (projectIds.length === 0) {
			return { permitted: true, available: true, report: emptyTrafficReport() };
		}
		const report = await telemetry.report({ ...window, projectIds });
		return { permitted: true, available: true, report };
	}

	/**
	 * Unauthenticated fleet summary on `GET /metrics` (DESIGN §8: export only). Kept for callers
	 * that predate the scoped exporter; `MetricsExporter.render` is the full surface.
	 */
	async prometheus(): Promise<string> {
		return this.ctx.metricsExport.render(undefined, { section: 'all' });
	}

	/** The fleet counters that open every platform exposition. */
	platformLines(): string[] {
		const summary = this.rawSummary();
		return [
			'# HELP skiff_nodes_total Nodes known to the control plane.',
			'# TYPE skiff_nodes_total gauge',
			`skiff_nodes_total ${summary.nodes}`,
			'# HELP skiff_nodes_online Nodes currently online.',
			'# TYPE skiff_nodes_online gauge',
			`skiff_nodes_online ${summary.online}`,
			'# HELP skiff_projects_total Projects (apps), excluding the trash.',
			'# TYPE skiff_projects_total gauge',
			`skiff_projects_total ${summary.projects}`,
			'# HELP skiff_deployments_active Active deployments.',
			'# TYPE skiff_deployments_active gauge',
			`skiff_deployments_active ${summary.activeDeployments}`,
			'# HELP skiff_storage_bytes Release artifact bytes across every org.',
			'# TYPE skiff_storage_bytes gauge',
			`skiff_storage_bytes ${summary.storageBytes}`,
			'# HELP skiff_agent_desired_version_info Agent version the control plane wants nodes on.',
			'# TYPE skiff_agent_desired_version_info gauge',
			`skiff_agent_desired_version_info{version="${escape(summary.agentVersion)}"} 1`,
		];
	}

	private rawSummary() {
		const nodeRows = this.ctx.db.select({ status: nodes.status }).from(nodes).all();
		const deploymentsRow = this.ctx.db
			.select({ active: sql<number>`sum(case when ${deployments.status} = 'active' then 1 else 0 end)` })
			.from(deployments)
			.innerJoin(projects, eq(projects.id, deployments.projectId))
			.where(isNull(projects.deletedAt))
			.get();
		const projectCount = this.ctx.db
			.select({ count: sql<number>`count(*)` })
			.from(projects)
			.where(isNull(projects.deletedAt))
			.get();
		const storage = this.ctx.db.select({ total: sql<number>`coalesce(sum(${releases.sizeBytes}), 0)` }).from(releases).get();
		return {
			nodes: nodeRows.length,
			online: nodeRows.filter((row) => row.status === 'online').length,
			projects: projectCount?.count ?? 0,
			activeDeployments: deploymentsRow?.active ?? 0,
			storageBytes: storage?.total ?? 0,
			agentVersion: this.ctx.config.desiredAgentVersion ?? '0.1.0',
		};
	}
}

function escape(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
