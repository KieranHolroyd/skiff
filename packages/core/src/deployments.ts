import { and, desc, eq, inArray, isNotNull, lte, ne } from 'drizzle-orm';
import { configSnapshots, deployments, projects, releases } from '@skiff/db';
import { requirePermission, type Principal } from '@skiff/contracts';
import type { FileEntry } from './artifact.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError } from './errors.ts';
import type { PreparedRelease } from './releases.ts';
import { newId, parseJson, shortId } from './util.ts';
import type { ParsedConfig } from '@skiff/site-config';
import type { ProjectRow } from './projects.ts';

export interface DeploymentView {
	id: string;
	shortId: string;
	projectId: string;
	projectSlug: string;
	status: string;
	runtime: string;
	release: { sha256: string; sizeBytes: number; fileCount: number; precompressed: boolean };
	previewUrl: string;
	productionUrl: string;
	isProduction: boolean;
	pinned: boolean;
	message: string | null;
	createdAt: string;
	activatedAt: string | null;
}

/** Release + config snapshot; immutable, preview URL always, production pointer moved explicitly (D13, D17). */
export class DeploymentService {
	constructor(private readonly ctx: CoreContext) {}

	private contentDomain(): string {
		return this.ctx.config.contentDomain;
	}

	async deployEntries(
		principal: Principal,
		project: ProjectRow,
		entries: FileEntry[],
		options: { promote?: boolean; message?: string; precompress?: boolean } = {},
	): Promise<DeploymentView> {
		requirePermission(principal, 'deployment:create');
		let prepared = await this.ctx.releases.prepare(principal, entries, { precompress: options.precompress });
		// Release GC runs concurrently and may have removed a reused release row while we awaited.
		// Re-check synchronously right before `create` (also synchronous) so nothing can slip between.
		for (let attempt = 0; attempt < 3; attempt++) {
			const stillThere = this.ctx.db.select({ id: releases.id }).from(releases).where(eq(releases.id, prepared.release.id)).get();
			if (stillThere) return this.create(principal, project, prepared, options);
			prepared = { ...prepared, release: await this.ctx.releases.store(principal, prepared.artifact) };
		}
		throw new ConflictError('The release was garbage-collected while deploying; please retry.');
	}

	create(
		principal: Principal,
		project: ProjectRow,
		prepared: PreparedRelease,
		options: { promote?: boolean; message?: string } = {},
	): DeploymentView {
		requirePermission(principal, 'deployment:create');
		const now = this.ctx.now();
		const id = newId('dep_');
		let idShort = shortId();
		for (let i = 0; i < 5; i++) {
			const clash = this.ctx.db.select({ id: deployments.id }).from(deployments).where(eq(deployments.shortId, idShort)).get();
			if (!clash) break;
			idShort = shortId();
		}
		const environment = this.ctx.environments.ensureProduction(project);
		const workload =
			project.runtime === 'static' ? null : this.ctx.workloads.plan(principal, project);
		const nodeId = workload?.nodeId ?? this.nodeForPlacement(project.placement);
		const promote = options.promote ?? true;
		const row: typeof deployments.$inferInsert = {
			id,
			orgId: project.orgId,
			projectId: project.id,
			releaseId: prepared.release.id,
			configSnapshotId: prepared.snapshotId,
			shortId: idShort,
			environmentId: environment.id,
			runtime: project.runtime,
			workloadJson: workload ? JSON.stringify(workload.spec) : null,
			status: 'active',
			previewHost: `${project.slug}--${idShort}.${this.contentDomain()}`,
			pinned: false,
			message: options.message ?? null,
			nodeId,
			createdBy: principal.userId,
			createdAt: now,
			activatedAt: now,
			promotedAt: promote ? now : null,
		};
		this.ctx.audit.wrap(
			{
				principal,
				action: 'deployment.create',
				resource: 'deployment',
				resourceId: id,
				args: { project: project.slug, sha256: prepared.release.sha256, promote },
			},
			() => {
				this.ctx.db.insert(deployments).values(row).run();
				if (workload) this.ctx.workloads.record(project, id, workload);
				if (promote) {
					this.ctx.db
						.update(projects)
						.set({ productionDeploymentId: id, updatedAt: now })
						.where(eq(projects.id, project.id))
						.run();
					this.ctx.environments.setDeployment(environment, id);
				}
				this.ctx.db
					.update(projects)
					.set({ siteConfigJson: JSON.stringify(prepared.config), updatedAt: now })
					.where(eq(projects.id, project.id))
					.run();
				this.ctx.projects.bump(project.orgId);
			},
		);
		this.retention(project);
		return this.view(row as typeof deployments.$inferSelect, project, promote);
	}

	private nodeForPlacement(placement: string): string | null {
		if (this.ctx.config.edgeNodeId) {
			if (placement === 'edge' || placement === 'auto') return this.ctx.config.edgeNodeId;
			return placement;
		}
		const edge = this.ctx.sqlite
			.query<{ id: string }, []>("SELECT id FROM nodes WHERE mode = 'edge' ORDER BY created_at ASC LIMIT 1")
			.get();
		if (placement === 'edge' || placement === 'auto') return edge?.id ?? null;
		return placement;
	}

	view(row: typeof deployments.$inferSelect, project: ProjectRow, isProduction?: boolean): DeploymentView {
		const release = this.ctx.db.select().from(releases).where(eq(releases.id, row.releaseId)).get();
		return {
			id: row.id,
			shortId: row.shortId,
			projectId: project.id,
			projectSlug: project.slug,
			status: row.status,
			runtime: row.runtime,
			release: {
				sha256: release?.sha256 ?? '',
				sizeBytes: release?.sizeBytes ?? 0,
				fileCount: release?.fileCount ?? 0,
				precompressed: release?.precompressed ?? false,
			},
			previewUrl: `https://${row.previewHost}`,
			productionUrl: `https://${project.slug}.${this.contentDomain()}`,
			isProduction: isProduction ?? project.productionDeploymentId === row.id,
			pinned: row.pinned,
			message: row.message,
			createdAt: new Date(row.createdAt).toISOString(),
			activatedAt: row.activatedAt ? new Date(row.activatedAt).toISOString() : null,
		};
	}

	list(principal: Principal, project: ProjectRow, options: { limit?: number } = {}): DeploymentView[] {
		requirePermission(principal, 'deployment:read');
		const rows = this.ctx.db
			.select()
			.from(deployments)
			.where(and(eq(deployments.projectId, project.id), ne(deployments.status, 'deleted')))
			.orderBy(desc(deployments.createdAt))
			.limit(Math.min(options.limit ?? 50, 200))
			.all();
		return rows.map((row) => this.view(row, project));
	}

	get(principal: Principal, project: ProjectRow, idOrShort: string): DeploymentView {
		requirePermission(principal, 'deployment:read');
		const row = this.ctx.db
			.select()
			.from(deployments)
			.where(and(eq(deployments.projectId, project.id), eq(deployments.id, idOrShort)))
			.get() ??
			this.ctx.db
				.select()
				.from(deployments)
				.where(and(eq(deployments.projectId, project.id), eq(deployments.shortId, idOrShort)))
				.get();
		if (!row || row.status === 'deleted') throw new NotFoundError('Deployment');
		return this.view(row, project);
	}

	async promote(principal: Principal, project: ProjectRow, idOrShort: string): Promise<DeploymentView> {
		requirePermission(principal, 'deployment:promote');
		const row = this.requireRow(project, idOrShort);
		if (row.status !== 'active') throw new ConflictError('Only active deployments can be promoted.');
		const now = this.ctx.now();
		await this.ctx.audit.wrap(
			{ principal, action: 'deployment.promote', resource: 'deployment', resourceId: row.id, args: { project: project.slug } },
			() => {
				this.ctx.db.update(deployments).set({ promotedAt: now }).where(eq(deployments.id, row.id)).run();
				this.setProduction(project, row.id, now);
			},
		);
		this.retention(project);
		return this.view({ ...row, promotedAt: now }, { ...project, productionDeploymentId: row.id });
	}

	/**
	 * Move production back to the deployment that was live before the current one (promotion
	 * history, never a preview that was never promoted). The target keeps its original
	 * `promotedAt`, so repeated rollbacks keep walking back instead of toggling between two.
	 */
	async rollback(principal: Principal, project: ProjectRow): Promise<DeploymentView> {
		requirePermission(principal, 'deployment:rollback');
		const previous = this.previouslyPromoted(project);
		if (!previous)
			throw new ConflictError(
				'No earlier production deployment to roll back to. Promote a specific deployment instead.',
			);
		await this.ctx.audit.wrap(
			{
				principal,
				action: 'deployment.rollback',
				resource: 'deployment',
				resourceId: previous.id,
				args: { project: project.slug, from: project.productionDeploymentId },
			},
			() => this.setProduction(project, previous.id, this.ctx.now()),
		);
		this.retention({ ...project, productionDeploymentId: previous.id });
		return this.view(previous, { ...project, productionDeploymentId: previous.id });
	}

	/**
	 * The most recently promoted active deployment that went live before the current production one
	 * (or, with no current production, the most recently promoted at all).
	 */
	private previouslyPromoted(project: ProjectRow, excludeId?: string) {
		const currentId = excludeId ?? project.productionDeploymentId;
		const current = currentId
			? this.ctx.db.select().from(deployments).where(eq(deployments.id, currentId)).get()
			: undefined;
		const filters = [
			eq(deployments.projectId, project.id),
			eq(deployments.status, 'active'),
			isNotNull(deployments.promotedAt),
		];
		if (currentId) filters.push(ne(deployments.id, currentId));
		// `<=` so two promotions in the same millisecond still have an order (by createdAt below).
		if (current?.promotedAt != null) filters.push(lte(deployments.promotedAt, current.promotedAt));
		return this.ctx.db
			.select()
			.from(deployments)
			.where(and(...filters))
			.orderBy(desc(deployments.promotedAt), desc(deployments.createdAt))
			.get();
	}

	private setProduction(project: ProjectRow, deploymentId: string | null, now: number): void {
		this.ctx.db
			.update(projects)
			.set({ productionDeploymentId: deploymentId, updatedAt: now })
			.where(eq(projects.id, project.id))
			.run();
		const environment = this.ctx.environments.ensureProduction(project);
		this.ctx.environments.setDeployment(environment, deploymentId);
		// Rollback restores the runtime spec and placement recorded on that deployment (D17).
		if (deploymentId && project.runtime !== 'static') this.ctx.workloads.syncDeployment(project, deploymentId);
		this.ctx.projects.bump(project.orgId);
	}

	/** Deployments that became production since `since` (used by the 5xx-after-promote alert). */
	recentlyPromoted(since: number) {
		return this.ctx.sqlite
			.query<
				{ id: string; short_id: string; project_id: string; slug: string; org_id: string; promoted_at: number },
				[number]
			>(
				`SELECT d.id, d.short_id, d.project_id, p.slug, d.org_id, d.promoted_at
				 FROM deployments d JOIN projects p ON p.id = d.project_id
				 WHERE d.promoted_at >= ? AND d.status = 'active'
				   AND p.production_deployment_id = d.id AND p.deleted_at IS NULL`,
			)
			.all(since);
	}

	async setPinned(principal: Principal, project: ProjectRow, idOrShort: string, pinned: boolean): Promise<DeploymentView> {
		requirePermission(principal, 'deployment:promote');
		const row = this.requireRow(project, idOrShort);
		this.ctx.db.update(deployments).set({ pinned }).where(eq(deployments.id, row.id)).run();
		this.retention(project);
		return this.view({ ...row, pinned }, project);
	}

	async delete(principal: Principal, project: ProjectRow, idOrShort: string): Promise<void> {
		requirePermission(principal, 'deployment:delete');
		const row = this.requireRow(project, idOrShort);
		const now = this.ctx.now();
		await this.ctx.audit.wrap(
			{ principal, action: 'deployment.delete', resource: 'deployment', resourceId: row.id, args: { project: project.slug } },
			() => {
				this.ctx.db
					.update(deployments)
					.set({ status: 'deleted', deletedAt: now })
					.where(eq(deployments.id, row.id))
					.run();
				if (project.productionDeploymentId === row.id) {
					// Fall back to what was live before (promotion history), or nothing: never a
					// preview that was never promoted.
					const previous = this.previouslyPromoted(project, row.id);
					this.setProduction(project, previous?.id ?? null, now);
				} else {
					this.ctx.projects.bump(project.orgId);
				}
			},
		);
		this.retention(project);
	}

	private requireRow(project: ProjectRow, idOrShort: string) {
		const row =
			this.ctx.db.select().from(deployments).where(and(eq(deployments.projectId, project.id), eq(deployments.id, idOrShort))).get() ??
			this.ctx.db.select().from(deployments).where(and(eq(deployments.projectId, project.id), eq(deployments.shortId, idOrShort))).get();
		if (!row || row.status === 'deleted') throw new NotFoundError('Deployment');
		return row;
	}

	/** Keep the last N unpinned deployments plus pinned and production; GC unreferenced releases. */
	retention(project: ProjectRow): void {
		const keep = this.ctx.quota.retention(project.orgId);
		if (keep < 0) return;
		const rows = this.ctx.db
			.select()
			.from(deployments)
			.where(and(eq(deployments.projectId, project.id), eq(deployments.status, 'active')))
			.orderBy(desc(deployments.createdAt))
			.all();
		let unpinned = 0;
		const remove: string[] = [];
		for (const row of rows) {
			const isProduction = row.id === project.productionDeploymentId;
			if (row.pinned || isProduction) continue;
			unpinned++;
			if (unpinned > keep) remove.push(row.id);
		}
		if (remove.length) {
			this.ctx.db
				.update(deployments)
				.set({ status: 'deleted', deletedAt: this.ctx.now() })
				.where(inArray(deployments.id, remove))
				.run();
		}
		void this.gcReleases(project.orgId);
	}

	private readonly gcQueue = new Map<string, Promise<void>>();
	private readonly objectDeletes = new Map<string, Promise<void>>();

	/**
	 * Delete release rows no surviving deployment references, and their objects once no release in
	 * *any* org uses them (keys are content-addressed and shared across orgs). Runs are serialised per
	 * org; each row is re-checked and deleted in one statement, before its object is touched.
	 */
	gcReleases(orgId: string): Promise<void> {
		const previous = this.gcQueue.get(orgId) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(() => this.runGc(orgId));
		this.gcQueue.set(orgId, run);
		void run
			.finally(() => {
				if (this.gcQueue.get(orgId) === run) this.gcQueue.delete(orgId);
			})
			.catch(() => undefined);
		return run;
	}

	/** Resolves once any in-flight GC delete of `objectKey` has finished, so a re-upload can't be clobbered. */
	async objectDeleteSettled(objectKey: string): Promise<void> {
		await this.objectDeletes.get(objectKey)?.catch(() => undefined);
	}

	private async runGc(orgId: string): Promise<void> {
		const candidates = this.ctx.sqlite
			.query<{ id: string; object_key: string }, [string]>(
				`SELECT id, object_key FROM releases r WHERE org_id = ?
				 AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.release_id = r.id AND d.status != 'deleted')`,
			)
			.all(orgId);
		for (const candidate of candidates) {
			const removed = this.ctx.sqlite.run(
				`DELETE FROM releases WHERE id = ?
				 AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.release_id = ? AND d.status != 'deleted')`,
				[candidate.id, candidate.id],
			);
			if (removed.changes === 0) continue;
			const shared = this.ctx.db
				.select({ id: releases.id })
				.from(releases)
				.where(eq(releases.objectKey, candidate.object_key))
				.get();
			if (shared) continue;
			const deletion = this.ctx.objectStore.delete(candidate.object_key);
			this.objectDeletes.set(candidate.object_key, deletion);
			try {
				await deletion;
			} finally {
				if (this.objectDeletes.get(candidate.object_key) === deletion) this.objectDeletes.delete(candidate.object_key);
			}
		}
	}

	/** The parsed config a route needs at activation. */
	configFor(row: typeof deployments.$inferSelect): ParsedConfig {
		const snapshot = this.ctx.db
			.select()
			.from(configSnapshots)
			.where(eq(configSnapshots.id, row.configSnapshotId))
			.get();
		return parseSnapshot(snapshot?.siteConfigJson);
	}
}

function parseSnapshot(json: string | undefined): ParsedConfig {
	return parseJson<ParsedConfig>(json, {
		config: { spa: false, cleanUrls: false, trailingSlash: 'ignore', notFound: null },
		redirects: [],
		headers: [],
	});
}
