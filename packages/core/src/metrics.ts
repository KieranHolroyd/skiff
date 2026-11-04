import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { deployments, nodes, projects, releases } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { requirePermission } from '@skiff/contracts';
import {
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

/** Dashboard payload: `available` separates "DuckDB is off" from "quiet period". */
export interface TrafficView {
	permitted: boolean;
	available: boolean;
	report: TrafficReport;
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
	 * DuckDB traffic for one project (every environment host), scoped by RBAC. Returns a
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
		if (!telemetry?.available) {
			return { permitted: true, available: false, report: emptyTrafficReport() };
		}
		const report = await telemetry.report({ ...window, projectId: project.id });
		return { permitted: true, available: true, report };
	}

	/** Fleet traffic for every project this principal can read. */
	async trafficOverview(principal: Principal, window: TrafficWindow): Promise<TrafficView> {
		if (!principal.permissions.has('metrics:read')) {
			return { permitted: false, available: false, report: emptyTrafficReport() };
		}
		requirePermission(principal, 'project:read');
		const telemetry = this.ctx.telemetry;
		if (!telemetry?.available) {
			return { permitted: true, available: false, report: emptyTrafficReport() };
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

	/** Prometheus text exposition (DESIGN §8: export only, no external scraper required). */
	async prometheus(): Promise<string> {
		const summary = this.rawSummary();
		const lines = [
			'# HELP skiff_nodes_total Nodes known to the control plane.',
			'# TYPE skiff_nodes_total gauge',
			`skiff_nodes_total ${summary.nodes}`,
			'skiff_nodes_online ' + summary.online,
			'skiff_projects_total ' + summary.projects,
			'skiff_deployments_active ' + summary.activeDeployments,
			'skiff_storage_bytes ' + summary.storageBytes,
			'skiff_agent_desired_version_info{version="' + escape(summary.agentVersion) + '"} 1',
		];
		if (this.ctx.telemetry?.available) {
			try {
				lines.push(await this.ctx.telemetry.getPrometheusMetrics());
			} catch (error) {
				console.error('[metrics] telemetry exposition failed:', error);
			}
		}
		return `${lines.join('\n')}\n`;
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
