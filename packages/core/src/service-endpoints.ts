import { and, eq, isNull } from 'drizzle-orm';
import {
	databaseAttachments,
	databases,
	serviceEndpoints,
	storageAttachments,
	storageInstances,
} from '@skiff/db';
import type { ExistingEndpoint, EndpointService as PlannedService } from './endpoints.ts';
import { planServiceEndpoints } from './endpoints.ts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';

/**
 * Materialises C2's service endpoints from a project's live attachments (docs/CLUSTERING.md §4.3).
 *
 * Placement is resolved first; this then keeps one consumer-side port per remote database. Only
 * process workloads are enabled for now: a container needs the workload-network gateway alias,
 * which is a separate helper change.
 */
export class ServiceEndpointService {
	constructor(private readonly ctx: CoreContext) {}

	reconcile(projectId: string, consumerNodeId: string): { created: number; updated: number; removed: number } {
		if (!featureEnabled(this.ctx.config, 'SERVICE_ENDPOINTS'))
			return { created: 0, updated: 0, removed: 0 };
		const services = this.servicesForProject(projectId);
		const existingRows = this.ctx.db
			.select()
			.from(serviceEndpoints)
			.where(eq(serviceEndpoints.consumerNodeId, consumerNodeId))
			.all();
		const existing: ExistingEndpoint[] = existingRows.map((row) => ({
			kind: row.serviceKind,
			serviceId: row.serviceId,
			localPort: row.localPort,
		}));
		const range = this.ctx.cluster.get().endpoints;
		const plan = planServiceEndpoints(consumerNodeId, services, existing, {
			min: range.portMin,
			max: range.portMax,
		});
		const existingByKey = new Map(existingRows.map((row) => [`${row.serviceKind}:${row.serviceId}`, row]));
		const now = this.ctx.now();
		let created = 0;
		let updated = 0;
		let removed = 0;

		this.ctx.db.transaction(() => {
			for (const item of plan.removed) {
				const row = existingByKey.get(item);
				if (!row) continue;
				this.ctx.db.delete(serviceEndpoints).where(eq(serviceEndpoints.id, row.id)).run();
				removed += 1;
			}
			for (const endpoint of plan.endpoints) {
				const row = existingByKey.get(`${endpoint.kind}:${endpoint.serviceId}`);
				const upstreamPort = endpoint.upstream.port;
				if (!row) {
					this.ctx.db
						.insert(serviceEndpoints)
						.values({
							id: endpoint.id,
							consumerNodeId,
							serviceKind: endpoint.kind,
							serviceId: endpoint.serviceId,
							localPort: endpoint.localPort,
							upstreamNodeId: endpoint.upstream.nodeId,
							upstreamPort,
							createdAt: now,
							updatedAt: now,
						})
						.run();
					created += 1;
				} else if (
					row.localPort !== endpoint.localPort ||
					row.upstreamNodeId !== endpoint.upstream.nodeId ||
					row.upstreamPort !== upstreamPort
				) {
					this.ctx.db
						.update(serviceEndpoints)
						.set({
							localPort: endpoint.localPort,
							upstreamNodeId: endpoint.upstream.nodeId,
							upstreamPort,
							updatedAt: now,
						})
						.where(eq(serviceEndpoints.id, row.id))
						.run();
					updated += 1;
				}
			}
		});
		if (created || updated || removed) this.ctx.projects.bump();
		return { created, updated, removed };
	}

	/** Live remote attachments that need an endpoint. Same-node services are excluded by the planner. */
	private servicesForProject(projectId: string): PlannedService[] {
		const databasesOnProject = this.ctx.db
			.select({ id: databases.id, nodeId: databases.nodeId, port: databases.hostPort })
			.from(databaseAttachments)
			.innerJoin(databases, eq(databases.id, databaseAttachments.databaseId))
			.where(and(eq(databaseAttachments.projectId, projectId), isNull(databases.deletedAt)))
			.all()
			.map((row) => ({
				kind: 'database' as const,
				serviceId: row.id,
				upstreamNodeId: row.nodeId,
				upstreamPort: row.port,
			}));
		const storageOnProject = this.ctx.db
			.select({
				id: storageInstances.id,
				nodeId: storageInstances.nodeId,
				port: storageInstances.hostPort,
				public: storageInstances.public,
			})
			.from(storageAttachments)
			.innerJoin(storageInstances, eq(storageInstances.id, storageAttachments.storageId))
			.where(and(eq(storageAttachments.projectId, projectId), isNull(storageInstances.deletedAt)))
			.all()
			.filter((row) => !row.public)
			.map((row) => ({
				kind: 'storage' as const,
				serviceId: row.id,
				upstreamNodeId: row.nodeId,
				upstreamPort: row.port,
			}));
		return [...databasesOnProject, ...storageOnProject];
	}
}
