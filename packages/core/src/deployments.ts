import { and, desc, eq, inArray, isNotNull, lte, ne } from 'drizzle-orm';
import { builds, configSnapshots, deployments, environments, nodes, projects, releases } from '@skiff/db';
import {
	contentUrl,
	hasPermission,
	requirePermission,
	workloadSpecSchema,
	type BuildView,
	type Principal,
	type WorkloadIngress,
} from '@skiff/contracts';
import type { FileEntry } from './artifact.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError } from './errors.ts';
import type { PreparedRelease } from './releases.ts';
import { newId, parseJson, shortId } from './util.ts';
import type { ParsedConfig } from '@skiff/site-config';
import type { ProjectRow } from './projects.ts';
import type { EnvironmentRow } from './environments.ts';

export interface DeploymentView {
	id: string;
	shortId: string;
	projectId: string;
	projectSlug: string;
	status: string;
	runtime: string;
	release: { sha256: string; sizeBytes: number; fileCount: number; precompressed: boolean };
	/** Environment the deployment was created in (legacy v1 rows read as production). */
	environmentId: string | null;
	environmentSlug: string;
	environmentName: string;
	/** Canonical host for this deployment: production if it follows production, else its environment. */
	host: string;
	previewUrl: string;
	/** URL this deployment serves at its environment's pointer (production URL for production). */
	productionUrl: string;
	isProduction: boolean;
	pinned: boolean;
	message: string | null;
	createdAt: string;
	activatedAt: string | null;
}

/** A host serving a deployment right now, besides its own immutable preview host. */
export interface DeploymentHostView {
	host: string;
	url: string;
	environmentSlug: string;
	environmentName: string;
	isProduction: boolean;
}

/**
 * Everything the deployment detail page shows about one deployment. Env and secret values never
 * appear here: only the names captured in the snapshot.
 */
export interface DeploymentDetailView extends DeploymentView {
	previewHost: string;
	/** Environment hosts whose pointer is this deployment. Empty when only the preview serves it. */
	serving: DeploymentHostView[];
	node: { id: string; name: string } | null;
	createdBy: { id: string; name: string | null; email: string | null };
	/** When this deployment last became production; null if it never did. */
	promotedAt: string | null;
	/** Runtime spec snapshot for process/container deployments (rollback restores it, D17). */
	spec: {
		command: string[] | null;
		image: string | null;
		port: number;
		memoryMb: number;
		cpus: number;
		replicas: number;
		ingress: WorkloadIngress;
		healthPath: string;
	} | null;
	config: {
		envNames: string[];
		secretNames: string[];
		redirects: number;
		headerRules: number;
		spa: boolean;
		cleanUrls: boolean;
	};
	/** The git build that produced this deployment; null for CLI/API uploads or without `build:read`. */
	build: BuildView | null;
}

type DeploymentOptions = { promote?: boolean; message?: string; environment?: string };
type EnvironmentLike = Pick<EnvironmentRow, 'slug' | 'isProduction' | 'name'>;

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
		options: DeploymentOptions & { precompress?: boolean } = {},
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
		options: DeploymentOptions = {},
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
		const environment = this.resolveEnvironment(project, options.environment);
		const workload =
			project.runtime === 'static' ? null : this.ctx.workloads.plan(principal, project);
		const nodeId = workload?.nodeId ?? this.nodeForPlacement(project.placement);
		// `promote` moves the pointer for the deployment's own environment. Only production also
		// moves the project-level pointer; non-production environments never touch it.
		const promote = options.promote ?? true;
		const promoteProduction = promote && environment.isProduction;
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
			promotedAt: promoteProduction ? now : null,
		};
		this.ctx.audit.wrap(
			{
				principal,
				action: 'deployment.create',
				resource: 'deployment',
				resourceId: id,
				args: {
					project: project.slug,
					sha256: prepared.release.sha256,
					promote,
					environment: environment.slug,
				},
			},
			() => {
				this.ctx.db.insert(deployments).values(row).run();
				if (workload) this.ctx.workloads.record(project, id, workload);
				if (promote) {
					if (promoteProduction)
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
		return this.view(row as typeof deployments.$inferSelect, project, promoteProduction);
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
		const environment = this.environmentOf(row);
		const production = isProduction ?? project.productionDeploymentId === row.id;
		// A deployment that serves production uses the project host; otherwise the environment host.
		const host = production
			? `${project.slug}.${this.contentDomain()}`
			: this.ctx.environments.hostFor(project, environment);
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
			environmentId: row.environmentId,
			environmentSlug: environment.slug,
			environmentName: environment.name,
			host,
			previewUrl: contentUrl(this.ctx.config.platformOrigin, row.previewHost),
			productionUrl: contentUrl(this.ctx.config.platformOrigin, host),
			isProduction: production,
			pinned: row.pinned,
			message: row.message,
			createdAt: new Date(row.createdAt).toISOString(),
			activatedAt: row.activatedAt ? new Date(row.activatedAt).toISOString() : null,
		};
	}

	private environmentOf(row: Pick<typeof deployments.$inferSelect, 'environmentId'>): EnvironmentLike {
		if (!row.environmentId) return { slug: 'production', isProduction: true, name: 'Production' };
		const stored = this.ctx.db.select().from(environments).where(eq(environments.id, row.environmentId)).get();
		return stored ?? { slug: 'production', isProduction: true, name: 'Production' };
	}

	/** `undefined`/`production` resolves to the built-in production environment. */
	private resolveEnvironment(project: ProjectRow, slug?: string): EnvironmentRow {
		const production = this.ctx.environments.ensureProduction(project);
		if (!slug || slug === production.slug) return production;
		return this.ctx.environments.requireRow(project, slug);
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

	/** One deployment with its snapshot, provenance and the hosts serving it (the detail page). */
	detail(principal: Principal, project: ProjectRow, idOrShort: string): DeploymentDetailView {
		const view = this.get(principal, project, idOrShort);
		const row = this.ctx.db.select().from(deployments).where(eq(deployments.id, view.id)).get()!;

		const serving: DeploymentHostView[] = this.ctx.db
			.select()
			.from(environments)
			.where(and(eq(environments.projectId, project.id), eq(environments.deploymentId, row.id)))
			.all()
			.map((environment) => {
				const host = this.ctx.environments.hostFor(project, environment);
				return {
					host,
					url: contentUrl(this.ctx.config.platformOrigin, host),
					environmentSlug: environment.slug,
					environmentName: environment.name,
					isProduction: environment.isProduction,
				};
			});
		// Legacy projects keep the production pointer on the project row only.
		if (view.isProduction && !serving.some((item) => item.isProduction)) {
			const host = `${project.slug}.${this.contentDomain()}`;
			serving.unshift({
				host,
				url: contentUrl(this.ctx.config.platformOrigin, host),
				environmentSlug: 'production',
				environmentName: 'Production',
				isProduction: true,
			});
		}

		const node = row.nodeId
			? (this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, row.nodeId)).get() ?? {
					id: row.nodeId,
					name: row.nodeId,
				})
			: null;

		let creator: { name: string | null; email: string | null } | null = null;
		try {
			creator = this.ctx.sqlite
				.query<{ name: string | null; email: string | null }, [string]>('SELECT name, email FROM user WHERE id = ?')
				.get(row.createdBy);
		} catch {
			// Auth tables live outside the core schema; a bare test database has none.
		}

		const parsedSpec = row.workloadJson
			? workloadSpecSchema.safeParse(parseJson<unknown>(row.workloadJson, null))
			: null;
		const spec = parsedSpec?.success
			? {
					command: parsedSpec.data.command ?? null,
					image: parsedSpec.data.image ?? null,
					port: parsedSpec.data.port,
					memoryMb: parsedSpec.data.memoryMb,
					cpus: parsedSpec.data.cpus,
					replicas: parsedSpec.data.replicas,
					ingress: parsedSpec.data.ingress,
					healthPath: parsedSpec.data.healthPath,
				}
			: null;

		const snapshot = this.ctx.db
			.select()
			.from(configSnapshots)
			.where(eq(configSnapshots.id, row.configSnapshotId))
			.get();
		const site = parseSnapshot(snapshot?.siteConfigJson);
		const env = parseJson<Record<string, unknown>>(snapshot?.envJson, {});
		const secretRefs = parseJson<Array<{ name?: unknown }>>(snapshot?.secretRefsJson, []);
		// The runtime spec carries its own env/secret refs; prefer whichever the deploy recorded.
		const envNames = new Set([
			...Object.keys(env),
			...(parsedSpec?.success ? Object.keys(parsedSpec.data.env) : []),
		]);
		const secretNames = new Set([
			...secretRefs.map((ref) => (typeof ref.name === 'string' ? ref.name : '')).filter(Boolean),
			...(parsedSpec?.success ? parsedSpec.data.secrets.map((ref) => ref.name) : []),
		]);

		let build: BuildView | null = null;
		if (hasPermission(principal, 'build:read')) {
			const buildRow = this.ctx.db
				.select({ id: builds.id })
				.from(builds)
				.where(and(eq(builds.projectId, project.id), eq(builds.deploymentId, row.id)))
				.orderBy(desc(builds.createdAt))
				.get();
			if (buildRow) build = this.ctx.builds.get(principal, project, buildRow.id);
		}

		return {
			...view,
			previewHost: row.previewHost,
			serving,
			node,
			createdBy: { id: row.createdBy, name: creator?.name ?? null, email: creator?.email ?? null },
			promotedAt: row.promotedAt ? new Date(row.promotedAt).toISOString() : null,
			spec,
			config: {
				envNames: [...envNames].sort(),
				secretNames: [...secretNames].sort(),
				redirects: site.redirects.length,
				headerRules: site.headers.length,
				spa: site.config.spa,
				cleanUrls: site.config.cleanUrls,
			},
			build,
		};
	}

	/**
	 * Point an environment at an existing deployment. Production is byte-for-byte the v1 behaviour:
	 * `promotedAt` records production history so rollback can walk it. Non-production environments
	 * only move their own pointer and never touch the project's production pointer.
	 */
	async promote(
		principal: Principal,
		project: ProjectRow,
		idOrShort: string,
		environmentSlug?: string,
	): Promise<DeploymentView> {
		requirePermission(principal, 'deployment:promote');
		const row = this.requireRow(project, idOrShort);
		if (row.status !== 'active') throw new ConflictError('Only active deployments can be promoted.');
		const environment = this.resolveEnvironment(project, environmentSlug);
		const now = this.ctx.now();
		await this.ctx.audit.wrap(
			{
				principal,
				action: 'deployment.promote',
				resource: 'deployment',
				resourceId: row.id,
				args: { project: project.slug, environment: environment.slug },
			},
			() => {
				if (!environment.isProduction) {
					this.ctx.environments.setDeployment(environment, row.id);
					this.ctx.projects.bump(project.orgId);
					return;
				}
				this.ctx.db.update(deployments).set({ promotedAt: now }).where(eq(deployments.id, row.id)).run();
				this.setProduction(project, row.id, now);
			},
		);
		this.retention(project);
		return environment.isProduction
			? this.view({ ...row, promotedAt: now }, { ...project, productionDeploymentId: row.id })
			: this.view(row, project);
	}

	/**
	 * Move production back to the deployment that was live before the current one (promotion
	 * history, never a preview that was never promoted). The target keeps its original
	 * `promotedAt`, so repeated rollbacks keep walking back instead of toggling between two.
	 */
	async rollback(principal: Principal, project: ProjectRow, environmentSlug?: string): Promise<DeploymentView> {
		requirePermission(principal, 'deployment:rollback');
		const environment = this.resolveEnvironment(project, environmentSlug);
		if (!environment.isProduction) return this.rollbackEnvironment(principal, project, environment);
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
	 * Non-production rollback: environments have no `promotedAt` history (that column is production
	 * only, D13), so walk the deployments created in that environment instead.
	 */
	private async rollbackEnvironment(
		principal: Principal,
		project: ProjectRow,
		environment: EnvironmentRow,
	): Promise<DeploymentView> {
		const previous = this.previousInEnvironment(project, environment);
		if (!previous)
			throw new ConflictError(
				`No earlier deployment in the ${environment.name} environment to roll back to. Promote a specific deployment instead.`,
			);
		await this.ctx.audit.wrap(
			{
				principal,
				action: 'deployment.rollback',
				resource: 'deployment',
				resourceId: previous.id,
				args: { project: project.slug, environment: environment.slug, from: environment.deploymentId },
			},
			() => {
				this.ctx.environments.setDeployment(environment, previous.id);
				this.ctx.projects.bump(project.orgId);
			},
		);
		this.retention(project);
		return this.view(previous, project);
	}

	/** Most recent active deployment in `environment` older than its current pointer. */
	private previousInEnvironment(project: ProjectRow, environment: EnvironmentRow) {
		const current = environment.deploymentId
			? this.ctx.db.select().from(deployments).where(eq(deployments.id, environment.deploymentId)).get()
			: undefined;
		const filters = [
			eq(deployments.projectId, project.id),
			eq(deployments.status, 'active'),
			eq(deployments.environmentId, environment.id),
		];
		if (current) {
			filters.push(ne(deployments.id, current.id));
			filters.push(lte(deployments.createdAt, current.createdAt));
		}
		return this.ctx.db
			.select()
			.from(deployments)
			.where(and(...filters))
			.orderBy(desc(deployments.createdAt))
			.get();
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
				// Any environment pointing at the deleted deployment falls back, or stops serving,
				// rather than routing to a deleted release. Production moved above.
				for (const environment of this.ctx.environments.rows(project.id)) {
					if (environment.isProduction || environment.deploymentId !== row.id) continue;
					this.ctx.environments.setDeployment(
						environment,
						this.previousInEnvironment(project, environment)?.id ?? null,
					);
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
		const keep = this.ctx.quota.retention(project.orgId, project.id);
		if (keep < 0) return;
		const rows = this.ctx.db
			.select()
			.from(deployments)
			.where(and(eq(deployments.projectId, project.id), eq(deployments.status, 'active')))
			.orderBy(desc(deployments.createdAt))
			.all();
		// Every environment pointer protects its deployment from retention, not just production.
		const environmentPointers = new Set(
			this.ctx.environments
				.rows(project.id)
				.map((environment) => environment.deploymentId)
				.filter((id): id is string => Boolean(id)),
		);
		let unpinned = 0;
		const remove: string[] = [];
		for (const row of rows) {
			const isProduction = row.id === project.productionDeploymentId;
			if (row.pinned || isProduction || environmentPointers.has(row.id)) continue;
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

	/**
	 * Prune: delete one release row when no surviving deployment references it and it is older than
	 * `createdBefore` (a release row is inserted before its deployment), then its object once no
	 * release in any org uses the key. Returns the bytes freed, or null when the release was kept.
	 */
	async deleteReleaseIfUnused(releaseId: string, createdBefore: number): Promise<number | null> {
		const row = this.ctx.db.select().from(releases).where(eq(releases.id, releaseId)).get();
		if (!row) return null;
		const removed = this.ctx.sqlite.run(
			`DELETE FROM releases WHERE id = ? AND created_at < ?
			 AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.release_id = ? AND d.status != 'deleted')`,
			[releaseId, createdBefore, releaseId],
		);
		if (removed.changes === 0) return null;
		const shared = this.ctx.db.select({ id: releases.id }).from(releases).where(eq(releases.objectKey, row.objectKey)).get();
		if (!shared) await this.deleteTrackedObject(row.objectKey);
		return shared ? 0 : row.sizeBytes;
	}

	/**
	 * Prune (platform scope): delete a stored object that no release or live upload references.
	 * Re-checks the rows immediately before deleting. Returns whether it was deleted.
	 */
	async deleteObjectIfUnreferenced(key: string): Promise<boolean> {
		if (key.startsWith('releases/')) {
			if (this.ctx.db.select({ id: releases.id }).from(releases).where(eq(releases.objectKey, key)).get()) return false;
		} else if (key.startsWith('uploads/')) {
			const live = this.ctx.sqlite
				.query<{ id: string }, [string]>("SELECT id FROM upload_sessions WHERE object_key = ? AND status = 'pending' LIMIT 1")
				.get(key);
			if (live) return false;
		} else return false;
		await this.deleteTrackedObject(key);
		return true;
	}

	/** Delete an object while letting a concurrent re-upload wait for it (`objectDeleteSettled`). */
	private async deleteTrackedObject(key: string): Promise<void> {
		const deletion = this.ctx.objectStore.delete(key);
		this.objectDeletes.set(key, deletion);
		try {
			await deletion;
		} finally {
			if (this.objectDeletes.get(key) === deletion) this.objectDeletes.delete(key);
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
