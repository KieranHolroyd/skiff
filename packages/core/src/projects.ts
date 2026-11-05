import { and, desc, eq, gt, isNull, isNotNull, lte } from 'drizzle-orm';
import { projects, slugRedirects } from '@skiff/db';
import {
	checkSlug,
	deriveSlug,
	contentUrl,
	requirePermission,
	suggestSlugs,
	type Principal,
	type ProjectCreate,
	type ProjectUpdate,
	limits,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { hashPassword } from './util.ts';

export interface ProjectRow {
	id: string;
	orgId: string;
	slug: string;
	name: string;
	runtime: 'static' | 'process' | 'container';
	placement: string;
	productionDeploymentId: string | null;
	productionAccess: 'public' | 'password' | 'platform';
	previewAccess: 'public' | 'password' | 'platform';
	accessSecretHash: string | null;
	workloadJson: string | null;
	createdBy: string;
	deletedAt: number | null;
	purgeAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ProjectView {
	id: string;
	slug: string;
	name: string;
	runtime: string;
	placement: string;
	productionDeploymentId: string | null;
	productionUrl: string;
	previewPattern: string;
	productionAccess: string;
	previewAccess: string;
	createdAt: string;
	deletedAt: string | null;
	/** When a trashed project is permanently deleted. */
	purgeAt: string | null;
}

/**
 * Tables whose rows belong to exactly one project and go with it on a hard delete. Share links,
 * redemptions and domains need extra handling and are cleaned up separately.
 */
export const projectOwnedTables = [
	'workloads',
	'environments',
	'builds',
	'git_sources',
	'log_events',
	'secrets',
	'deployments',
	'upload_sessions',
	'slug_redirects',
	'database_attachments',
	'storage_attachments',
	'app_volume_attachments',
	'app_volumes',
	'github_runner_registrations',
] as const;

export class ProjectService {
	constructor(private readonly ctx: CoreContext) {}

	private get contentDomain(): string {
		return this.ctx.config.contentDomain;
	}

	/** Live project slugs plus rename redirects still inside their 30-day window (D32). */
	private takenSlugs(): string[] {
		const slugs = this.ctx.db.select({ slug: projects.slug }).from(projects).all().map((row) => row.slug);
		const redirects = this.ctx.db
			.select({ slug: slugRedirects.fromSlug })
			.from(slugRedirects)
			.where(gt(slugRedirects.expiresAt, this.ctx.now()))
			.all()
			.map((row) => row.slug);
		return [...slugs, ...redirects];
	}

	deriveSlug(name: string): string {
		return deriveSlug(name);
	}

	view(row: ProjectRow): ProjectView {
		const productionHost = `${row.slug}.${this.contentDomain}`;
		return {
			id: row.id,
			slug: row.slug,
			name: row.name,
			runtime: row.runtime,
			placement: row.placement,
			productionDeploymentId: row.productionDeploymentId,
			productionUrl: contentUrl(this.ctx.config.platformOrigin, productionHost),
			previewPattern: contentUrl(this.ctx.config.platformOrigin, `${row.slug}--<id>.${this.contentDomain}`),
			productionAccess: row.productionAccess,
			previewAccess: row.previewAccess,
			createdAt: new Date(row.createdAt).toISOString(),
			deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
			purgeAt: row.purgeAt ? new Date(row.purgeAt).toISOString() : null,
		};
	}

	async create(principal: Principal, input: ProjectCreate): Promise<ProjectView> {
		requirePermission(principal, 'project:create');
		const name = input.name?.trim() || input.slug || 'Untitled project';
		const slug = input.slug ?? this.deriveSlug(name);
		const taken = this.takenSlugs();
		const check = checkSlug(slug, taken);
		if (!check.ok) {
			const suggestions = check.problem === 'taken' || check.problem === 'reserved' ? suggestSlugs(slug, taken) : [];
			throw new ConflictError(check.reason ?? 'Invalid slug', suggestions);
		}
		this.ctx.quota.assertCanCreateProject(principal.orgId);
		const now = this.ctx.now();
		const row: ProjectRow = {
			id: `prj_${crypto.randomUUID().replace(/-/g, '')}`,
			orgId: principal.orgId,
			slug,
			name,
			runtime: input.runtime,
			placement: input.placement,
			productionDeploymentId: null,
			productionAccess: input.productionAccess,
			previewAccess: input.previewAccess,
			accessSecretHash: null,
			workloadJson: null,
			createdBy: principal.userId,
			deletedAt: null,
			purgeAt: null,
			createdAt: now,
			updatedAt: now,
		};
		await this.ctx.audit.wrap(
			{ principal, action: 'project.create', resource: 'project', resourceId: row.id, args: { slug, name } },
			() => {
				this.ctx.db.insert(projects).values(row).run();
				this.ctx.environments.ensureProduction(row);
				this.bump(principal.orgId);
			},
		);
		return this.view(row);
	}

	async get(principal: Principal, slug: string, options: { includeDeleted?: boolean } = {}): Promise<ProjectView> {
		requirePermission(principal, 'project:read');
		return this.view(this.requireRow(principal, slug, options));
	}

	/** Internal lookup that skips permission checks (other services re-check the action they need). */
	requireRow(principal: Principal, slug: string, options: { includeDeleted?: boolean } = {}): ProjectRow {
		const row = this.ctx.db
			.select()
			.from(projects)
			.where(and(eq(projects.orgId, principal.orgId), eq(projects.slug, slug)))
			.get() as ProjectRow | undefined;
		if (!row) throw new NotFoundError(`Project "${slug}"`);
		if (row.deletedAt && !options.includeDeleted) throw new NotFoundError(`Project "${slug}"`);
		return row;
	}

	requireById(principal: Principal, id: string, options: { includeDeleted?: boolean } = {}): ProjectRow {
		const row = this.ctx.db
			.select()
			.from(projects)
			.where(and(eq(projects.orgId, principal.orgId), eq(projects.id, id)))
			.get() as ProjectRow | undefined;
		if (!row) throw new NotFoundError('Project');
		if (row.deletedAt && !options.includeDeleted) throw new NotFoundError('Project');
		return row;
	}

	list(principal: Principal, options: { includeDeleted?: boolean; onlyDeleted?: boolean } = {}): ProjectView[] {
		requirePermission(principal, 'project:read');
		const rows = this.ctx.db
			.select()
			.from(projects)
			.where(
				options.onlyDeleted
					? and(eq(projects.orgId, principal.orgId), isNotNull(projects.deletedAt))
					: options.includeDeleted
						? eq(projects.orgId, principal.orgId)
						: and(eq(projects.orgId, principal.orgId), isNull(projects.deletedAt)),
			)
			.orderBy(desc(projects.createdAt))
			.all() as ProjectRow[];
		return rows.map((row) => this.view(row));
	}

	async update(principal: Principal, slug: string, input: ProjectUpdate & { slug?: string }): Promise<ProjectView> {
		requirePermission(principal, 'project:update');
		const row = this.requireRow(principal, slug);
		const now = this.ctx.now();
		const patch: Partial<ProjectRow> = { updatedAt: now };
		if (input.name !== undefined) patch.name = input.name.trim();
		if (input.placement !== undefined) patch.placement = input.placement;
		if (input.productionAccess !== undefined) patch.productionAccess = input.productionAccess;
		if (input.previewAccess !== undefined) patch.previewAccess = input.previewAccess;

		let newSlug = row.slug;
		if (input.slug && input.slug !== row.slug) {
			const taken = this.takenSlugs().filter((value) => value !== row.slug);
			const check = checkSlug(input.slug, taken);
			if (!check.ok) throw new ConflictError(check.reason ?? 'Invalid slug', suggestSlugs(input.slug, taken));
			newSlug = input.slug;
			patch.slug = newSlug;
		}
		await this.ctx.audit.wrap(
			{ principal, action: 'project.update', resource: 'project', resourceId: row.id, args: input },
			() => {
				this.ctx.db.update(projects).set(patch).where(eq(projects.id, row.id)).run();
				if (newSlug !== row.slug) {
					this.ctx.db
						.insert(slugRedirects)
						.values({
							id: `red_${crypto.randomUUID().replace(/-/g, '')}`,
							fromSlug: row.slug,
							projectId: row.id,
							orgId: row.orgId,
							expiresAt: now + limits.redirectDays * 86_400_000,
							createdAt: now,
						})
						.onConflictDoUpdate({ target: slugRedirects.fromSlug, set: { projectId: row.id, expiresAt: now + limits.redirectDays * 86_400_000 } })
						.run();
				}
				this.bump(principal.orgId);
			},
		);
		return this.view({ ...row, ...patch } as ProjectRow);
	}

	async setAccess(
		principal: Principal,
		slug: string,
		input: { scope: 'production' | 'previews'; mode: 'public' | 'password' | 'platform'; password?: string },
	): Promise<ProjectView> {
		requirePermission(principal, 'project:update');
		const row = this.requireRow(principal, slug);
		if (input.mode === 'password' && !input.password && !row.deletedAt)
			throw new ValidationError('A password is required for password mode.');
		const patch: Partial<ProjectRow> = { updatedAt: this.ctx.now() };
		if (input.scope === 'production') patch.productionAccess = input.mode;
		else patch.previewAccess = input.mode;
		if (input.mode === 'password' && input.password) patch.accessSecretHash = hashPassword(input.password);
		if (input.mode !== 'password') patch.accessSecretHash = null;
		await this.ctx.audit.wrap(
			{ principal, action: 'project.set_access', resource: 'project', resourceId: row.id, args: { scope: input.scope, mode: input.mode } },
			() => {
				this.ctx.db.update(projects).set(patch).where(eq(projects.id, row.id)).run();
				this.bump(principal.orgId);
			},
		);
		return this.view({ ...row, ...patch } as ProjectRow);
	}

	async setProductionDeployment(projectId: string, deploymentId: string | null): Promise<void> {
		this.ctx.db
			.update(projects)
			.set({ productionDeploymentId: deploymentId, updatedAt: this.ctx.now() })
			.where(eq(projects.id, projectId))
			.run();
		this.bump();
	}

	async softDelete(principal: Principal, slug: string, options: { operationId?: string } = {}): Promise<void> {
		requirePermission(principal, 'project:delete');
		const row = this.requireRow(principal, slug);
		const now = this.ctx.now();
		await this.ctx.audit.wrap(
			{ principal, action: 'project.delete', resource: 'project', resourceId: row.id, args: { slug }, operationId: options.operationId },
			() => {
				this.ctx.db
					.update(projects)
					// Keep the production pointer so a restore brings the site straight back (D29);
					// desired state and site access already skip deleted projects.
					.set({ deletedAt: now, purgeAt: now + limits.trashDays * 86_400_000, updatedAt: now })
					.where(eq(projects.id, row.id))
					.run();
				// A queued or running git build must not land a deployment in a deleted project.
				this.ctx.builds.cancelForProject(row.id);
				this.bump(principal.orgId);
			},
		);
		// The runner units stop with the project; take their registrations off GitHub too (plan 21).
		void this.ctx.githubRunners.deregisterProject(row, this.runnerOf(row)).catch(() => undefined);
	}

	private runnerOf(row: ProjectRow) {
		try {
			return this.ctx.workloads.projectSpec(row)?.runner;
		} catch {
			return undefined;
		}
	}

	async restore(principal: Principal, slug: string, options: { operationId?: string } = {}): Promise<ProjectView> {
		requirePermission(principal, 'project:update');
		const row = this.requireRow(principal, slug, { includeDeleted: true });
		if (!row.deletedAt) return this.view(row);
		// A restored project counts against the quota again, exactly like a new one.
		this.ctx.quota.assertCanCreateProject(principal.orgId);
		await this.ctx.audit.wrap(
			{ principal, action: 'project.restore', resource: 'project', resourceId: row.id, operationId: options.operationId },
			() => {
				this.ctx.db
					.update(projects)
					.set({ deletedAt: null, purgeAt: null, updatedAt: this.ctx.now() })
					.where(eq(projects.id, row.id))
					.run();
				this.bump(principal.orgId);
			},
		);
		return this.view({ ...row, deletedAt: null, purgeAt: null });
	}

	/** Hard delete after the 7-day trash window; frees the slug and its dependent rows. */
	async purgeExpired(): Promise<number> {
		const now = this.ctx.now();
		const expired = this.ctx.db
			.select()
			.from(projects)
			.where(and(isNotNull(projects.deletedAt), isNotNull(projects.purgeAt), lte(projects.purgeAt, now)))
			.all() as ProjectRow[];
		let purged = 0;
		for (const row of expired) {
			await this.purgeRow(row);
			purged++;
		}
		return purged;
	}

	/**
	 * Permanently delete a project that is already in the trash, without waiting for the window
	 * (bulk `project.purge`). Irreversible, so it only accepts trashed projects.
	 */
	async purgeNow(principal: Principal, slug: string, options: { operationId?: string } = {}): Promise<void> {
		requirePermission(principal, 'project:delete');
		const row = this.requireRow(principal, slug, { includeDeleted: true });
		if (!row.deletedAt) throw new ConflictError(`"${slug}" is not in the trash. Delete it first.`);
		await this.ctx.audit.wrap(
			{
				principal,
				action: 'project.purge',
				resource: 'project',
				resourceId: row.id,
				args: { slug },
				operationId: options.operationId,
			},
			() => this.purgeRow(row),
		);
	}

	/**
	 * The one cascade for a hard project delete (trash expiry and purge-now). Everything keyed by
	 * the project goes with it: a leftover workload keeps node memory reserved, leftover
	 * environments/builds point at deleted deployments, and domains must go through the domain
	 * service so their managed Cloudflare records are removed too (docs/OPERATIONS.md L1/L2).
	 */
	async purgeRow(row: ProjectRow): Promise<void> {
		// Builds that slipped past the soft-delete cancel must not outlive their project.
		this.ctx.builds.cancelForProject(row.id);
		// Outside the transaction: Cloudflare is a network call. A failure is audited by the domain
		// service and the row is still removed; prune reports any record it could not clean up.
		await this.ctx.domains.removeForProject(row);
		// Needs the project's credential secret, so it runs before the cascade deletes it.
		await this.ctx.githubRunners.deregisterProject(row, this.runnerOf(row)).catch(() => undefined);
		this.ctx.sqlite.transaction(() => {
			// Snapshot rows key on the volume, not the project; remove them before the volumes.
			this.ctx.sqlite.run(
				'DELETE FROM app_volume_snapshots WHERE volume_id IN (SELECT id FROM app_volumes WHERE project_id = ?)',
				[row.id],
			);
			for (const table of projectOwnedTables)
				this.ctx.sqlite.run(`DELETE FROM ${table} WHERE project_id = ?`, [row.id]);
			this.ctx.sqlite.run(
				'DELETE FROM share_redemptions WHERE share_link_id IN (SELECT id FROM share_links WHERE project_id = ?)',
				[row.id],
			);
			this.ctx.sqlite.run('DELETE FROM share_links WHERE project_id = ?', [row.id]);
			this.ctx.sqlite.run('DELETE FROM projects WHERE id = ?', [row.id]);
		})();
		this.bump();
		void this.ctx.deployments.gcReleases(row.orgId).catch(() => undefined);
	}

	/** Release old slugs whose 30-day redirect has lapsed (D32). Meant for the maintenance sweep. */
	pruneExpiredRedirects(): number {
		const expired = this.ctx.db
			.select({ id: slugRedirects.id })
			.from(slugRedirects)
			.where(lte(slugRedirects.expiresAt, this.ctx.now()))
			.all();
		if (!expired.length) return 0;
		this.ctx.db.delete(slugRedirects).where(lte(slugRedirects.expiresAt, this.ctx.now())).run();
		this.bump();
		return expired.length;
	}

	redirects(orgId: string): Array<{ from: string; to: string }> {
		const now = this.ctx.now();
		const rows = this.ctx.db
			.select({ fromSlug: slugRedirects.fromSlug, projectId: slugRedirects.projectId, local: slugRedirects.id })
			.from(slugRedirects)
			.where(and(eq(slugRedirects.orgId, orgId), gt(slugRedirects.expiresAt, now)))
			.all();
		const out: Array<{ from: string; to: string }> = [];
		for (const row of rows) {
			const project = this.ctx.db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, row.projectId)).get();
			if (project) out.push({ from: `${row.fromSlug}.${this.contentDomain}`, to: `${contentUrl(this.ctx.config.platformOrigin, `${project.slug}.${this.contentDomain}`)}{http.request.uri}` });
		}
		return out;
	}

	/** Bump the global desired-state watermark; agents converge on their next pull. */
	bump(_orgId?: string): void {
		const now = this.ctx.now();
		this.ctx.sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at',
			['state_version', '1', now],
		);
	}

	stateVersion(): number {
		const row = this.ctx.sqlite
			.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'state_version'")
			.get();
		return Number(row?.value ?? 1);
	}
}
