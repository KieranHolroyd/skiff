import { and, eq, isNull, sql } from 'drizzle-orm';
import { deployments, orgQuotas, projects, releases } from '@skiff/db';
import { limits } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { QuotaError } from './errors.ts';

/** Unlimited for the owner org, enforced for everyone else (D9). */
export interface Quota {
	projects: number;
	storageBytes: number;
	retainedDeployments: number;
	maxUploadBytes: number;
}

const UNLIMITED: Quota = { projects: -1, storageBytes: -1, retainedDeployments: -1, maxUploadBytes: -1 };

export class QuotaService {
	constructor(private readonly ctx: CoreContext) {}

	get(orgId: string): Quota {
		const row = this.ctx.db.select().from(orgQuotas).where(eq(orgQuotas.orgId, orgId)).get();
		if (!row) return UNLIMITED;
		return {
			projects: row.projects,
			storageBytes: row.storageBytes,
			retainedDeployments: row.retainedDeployments,
			maxUploadBytes: row.maxUploadBytes,
		};
	}

	set(orgId: string, quota: Partial<Quota>): void {
		this.ctx.db
			.insert(orgQuotas)
			.values({ orgId, ...UNLIMITED, ...quota, updatedAt: Date.now() })
			.onConflictDoUpdate({ target: orgQuotas.orgId, set: { ...quota, updatedAt: Date.now() } })
			.run();
	}

	assertCanCreateProject(orgId: string): void {
		const quota = this.get(orgId);
		if (quota.projects < 0) return;
		const count = this.ctx.db
			.select({ count: sql<number>`count(*)` })
			.from(projects)
			.where(and(eq(projects.orgId, orgId), isNull(projects.deletedAt)))
			.get();
		if ((count?.count ?? 0) >= quota.projects)
			throw new QuotaError(`Project limit reached (${quota.projects}). Delete a project or raise the org quota.`);
	}

	assertCanUpload(orgId: string, bytes: number): void {
		const quota = this.get(orgId);
		if (quota.maxUploadBytes >= 0 && bytes > quota.maxUploadBytes)
			throw new QuotaError(`Upload is ${bytes} bytes; this org allows ${quota.maxUploadBytes}.`);
		if (quota.storageBytes < 0) return;
		const used = this.ctx.db
			.select({ total: sql<number>`coalesce(sum(${releases.sizeBytes}), 0)` })
			.from(releases)
			.where(eq(releases.orgId, orgId))
			.get();
		if ((used?.total ?? 0) + bytes > quota.storageBytes)
			throw new QuotaError(`Storage quota exceeded (${quota.storageBytes} bytes).`);
	}

	/** Effective retention count: org quota if set, otherwise the platform default. */
	retention(orgId: string): number {
		const quota = this.get(orgId);
		return quota.retainedDeployments >= 0 ? quota.retainedDeployments : limits.retainedDeployments;
	}

	assertCanCreateDeployment(_orgId: string): void {
		// Deployment creation is bounded by upload/storage and retention, not a separate counter.
	}
}

export const _deploymentTable = deployments;
