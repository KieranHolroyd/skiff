import { and, desc, eq, gt, inArray, isNull, isNotNull, lte } from 'drizzle-orm';
import { projects, slugRedirects } from '@yoal/db';
import {
	checkSlug,
	deriveSlug,
	contentUrl,
	deployLevelFor,
	suggestSlugs,
	type Principal,
	type ProjectCreate,
	type ProjectUpdate,
	limits,
	placementSpecSchema,
} from '@yoal/contracts';
import { featureEnabled } from './config.ts';
import { effectiveAccessMode } from './access.ts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { effectiveRuntime, storedRuntime, type TierRuntime } from './runtime-tier.ts';
import { hashPassword } from './util.ts';

export interface ProjectRow {
	id: string;
	orgId: string;
	slug: string;
	name: string;
	runtime: 'static' | 'process' | 'container';
	/** Effective tier including `function` (D110); null on rows created before migration 0039. */
	runtimeName?: TierRuntime | null;
	placement: string;
	/** Persisted constraint spec (CLUSTERING §3.4); null keeps the shorthand. */
	placementJson?: string | null;
	productionDeploymentId: string | null;
	productionAccess: 'public' | 'password' | 'platform';
	previewAccess: 'public' | 'password' | 'platform';
	/** Yoal Access policy for each project scope (IAM.md I25); presence means effective `access`. */
	productionAccessPolicyId?: string | null;
	previewAccessPolicyId?: string | null;
	/** Legacy shared hash (pre-0054); never read. Use the per-scope hashes. */
	accessSecretHash: string | null;
	/** scrypt hash for production in `password` mode; each scope has its own (0054). */
	productionPasswordHash?: string | null;
	/** scrypt hash for previews in `password` mode. */
	previewPasswordHash?: string | null;
	/** Visitor-session epoch mixed into the site key; "sign out everyone" bumps it. */
	siteSessionEpoch?: number;
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
	/** Product-facing deploy level: 1 static, 2 process/function, 3 container, 4 compose. */
	level: import('@yoal/contracts').DeployLevel;
	placement: string;
	placementSpec: import('@yoal/contracts').PlacementSpec | null;
	productionDeploymentId: string | null;
	productionUrl: string;
	previewPattern: string;
	productionAccess: string;
	previewAccess: string;
	/** The policies behind an `access` mode, when assigned. */
	productionAccessPolicyId: string | null;
	previewAccessPolicyId: string | null;
	/** Whether production has a password stored (the hash itself is never returned). */
	productionPasswordSet: boolean;
	/** Whether previews have a password stored. */
	previewPasswordSet: boolean;
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
	// User pools are org resources; the attachment is project-owned (IAM.md I28).
	'user_pool_attachments',
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
			runtime: effectiveRuntime(row),
			level: deployLevelFor(effectiveRuntime(row)),
			placement: row.placement,
			placementSpec: parsePlacementSpec(row.placementJson),
			productionDeploymentId: row.productionDeploymentId,
			productionUrl: contentUrl(this.ctx.config.platformOrigin, productionHost),
			previewPattern: contentUrl(this.ctx.config.platformOrigin, `${row.slug}--<id>.${this.contentDomain}`),
			productionAccess: effectiveAccessMode(row.productionAccess, row.productionAccessPolicyId),
			previewAccess: effectiveAccessMode(row.previewAccess, row.previewAccessPolicyId),
			productionAccessPolicyId: row.productionAccessPolicyId ?? null,
			previewAccessPolicyId: row.previewAccessPolicyId ?? null,
			productionPasswordSet: Boolean(row.productionPasswordHash),
			previewPasswordSet: Boolean(row.previewPasswordHash),
			createdAt: new Date(row.createdAt).toISOString(),
			deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
			purgeAt: row.purgeAt ? new Date(row.purgeAt).toISOString() : null,
		};
	}

	async create(principal: Principal, input: ProjectCreate): Promise<ProjectView> {
		this.ctx.iam.require(principal, 'project:create', { type: 'org' });
		// Functions is on by default (D110), but a platform can disable the tier with
		// YOAL_FEATURE_FUNCTIONS=0; refuse a project it could never run.
		if (input.runtime === 'function' && !featureEnabled(this.ctx.config, 'FUNCTIONS'))
			throw new ValidationError('Functions are not enabled on this platform (YOAL_FEATURE_FUNCTIONS).');
		if (input.runtime === 'compose' && !featureEnabled(this.ctx.config, 'COMPOSE'))
			throw new ValidationError('Compose stacks are not enabled on this platform (YOAL_FEATURE_COMPOSE).');
		const name = input.name?.trim() || input.slug || 'Untitled project';
		const slug = input.slug ?? this.deriveSlug(name);
		const taken = this.takenSlugs();
		const check = checkSlug(slug, taken);
		if (!check.ok) {
			const suggestions = check.problem === 'taken' || check.problem === 'reserved' ? suggestSlugs(slug, taken) : [];
			throw new ConflictError(check.reason ?? 'Invalid slug', suggestions);
		}
		this.ctx.quota.assertCanCreateProject(principal.orgId);
		const wantsPassword = input.productionAccess === 'password' || input.previewAccess === 'password';
		if (wantsPassword && !input.password)
			throw new ValidationError('A password is required for password mode.');
		if (input.productionAccess === 'access' && !input.productionAccessPolicyId)
			throw new ValidationError('Choose a Yoal Access policy for production.');
		if (input.previewAccess === 'access' && !input.previewAccessPolicyId)
			throw new ValidationError('Choose a Yoal Access policy for previews.');
		const passwordHash = wantsPassword && input.password ? hashPassword(input.password) : null;
		const now = this.ctx.now();
		const row: ProjectRow = {
			id: `prj_${crypto.randomUUID().replace(/-/g, '')}`,
			orgId: principal.orgId,
			slug,
			name,
			runtime: storedRuntime(input.runtime),
			runtimeName: input.runtime,
			placement: input.placement,
			placementJson: input.placementSpec ? JSON.stringify(input.placementSpec) : null,
			productionDeploymentId: null,
			productionAccess: input.productionAccess === 'access' ? 'platform' : input.productionAccess,
			previewAccess: input.previewAccess === 'access' ? 'platform' : input.previewAccess,
			productionAccessPolicyId:
				input.productionAccess === 'access' ? (input.productionAccessPolicyId ?? null) : null,
			previewAccessPolicyId:
				input.previewAccess === 'access' ? (input.previewAccessPolicyId ?? null) : null,
			accessSecretHash: null,
			productionPasswordHash: input.productionAccess === 'password' ? passwordHash : null,
			previewPasswordHash: input.previewAccess === 'password' ? passwordHash : null,
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
				this.ctx.appErrors.onProjectCreated(row);
				this.bump(principal.orgId);
			},
		);
		return this.view(row);
	}

	async get(principal: Principal, slug: string, options: { includeDeleted?: boolean } = {}): Promise<ProjectView> {
		const row = this.requireRow(principal, slug, options);
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: row.id });
		return this.view(row);
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
		// A guest sees only the projects they hold a binding on (IAM.md §6.3). Filtering before the
		// query keeps ordering and pagination correct once a caller adds a limit.
		const scope = this.ctx.iam.scopeFilter(principal, 'project:read');
		if (scope !== 'all' && scope.size === 0) return [];
		const rows = this.ctx.db
			.select()
			.from(projects)
			.where(
				and(
					eq(projects.orgId, principal.orgId),
					options.onlyDeleted
						? isNotNull(projects.deletedAt)
						: options.includeDeleted
							? undefined
							: isNull(projects.deletedAt),
					scope === 'all' ? undefined : inArray(projects.id, [...scope]),
				),
			)
			.orderBy(desc(projects.createdAt))
			.all() as ProjectRow[];
		return rows.map((row) => this.view(row));
	}

	async update(principal: Principal, slug: string, input: ProjectUpdate & { slug?: string }): Promise<ProjectView> {
		const row = this.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: row.id });
		const now = this.ctx.now();
		const patch: Partial<ProjectRow> = { updatedAt: now };
		if (input.name !== undefined) patch.name = input.name.trim();
		if (input.placement !== undefined) patch.placement = input.placement;
		if (input.placementSpec !== undefined)
			patch.placementJson = input.placementSpec ? JSON.stringify(input.placementSpec) : null;
		if (input.productionAccess !== undefined) {
			const policyId =
				input.productionAccess === 'access'
					? (input.productionAccessPolicyId ?? row.productionAccessPolicyId ?? null)
					: null;
			if (input.productionAccess === 'access' && !policyId)
				throw new ValidationError('Choose a Yoal Access policy for production.');
			patch.productionAccess = input.productionAccess === 'access' ? 'platform' : input.productionAccess;
			patch.productionAccessPolicyId = policyId;
			Object.assign(patch, scopePasswordPatch(row, 'production', input.productionAccess));
		} else if (input.productionAccessPolicyId !== undefined) {
			patch.productionAccessPolicyId = input.productionAccessPolicyId;
		}
		if (input.previewAccess !== undefined) {
			const policyId =
				input.previewAccess === 'access'
					? (input.previewAccessPolicyId ?? row.previewAccessPolicyId ?? null)
					: null;
			if (input.previewAccess === 'access' && !policyId)
				throw new ValidationError('Choose a Yoal Access policy for previews.');
			patch.previewAccess = input.previewAccess === 'access' ? 'platform' : input.previewAccess;
			patch.previewAccessPolicyId = policyId;
			Object.assign(patch, scopePasswordPatch(row, 'previews', input.previewAccess));
		} else if (input.previewAccessPolicyId !== undefined) {
			patch.previewAccessPolicyId = input.previewAccessPolicyId;
		}

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
		input: {
			scope: 'production' | 'previews';
			mode: 'public' | 'password' | 'platform' | 'access';
			password?: string;
			policyId?: string;
		},
	): Promise<ProjectView> {
		const row = this.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: row.id });
		if (input.mode === 'access' && !input.policyId)
			throw new ValidationError('Choose a Yoal Access policy.');
		const storedMode = input.mode === 'access' ? 'platform' : input.mode;
		// Each scope keeps its own password: changing one scope never touches the other's.
		const patch: Partial<ProjectRow> = {
			updatedAt: this.ctx.now(),
			...scopePasswordPatch(row, input.scope, input.mode, input.password),
		};
		if (input.scope === 'production') {
			patch.productionAccess = storedMode;
			patch.productionAccessPolicyId = input.mode === 'access' ? (input.policyId ?? null) : null;
		} else {
			patch.previewAccess = storedMode;
			patch.previewAccessPolicyId = input.mode === 'access' ? (input.policyId ?? null) : null;
		}
		await this.ctx.audit.wrap(
			{ principal, action: 'project.set_access', resource: 'project', resourceId: row.id, args: { scope: input.scope, mode: input.mode, policyId: input.policyId } },
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
		const row = this.requireRow(principal, slug);
		this.ctx.iam.require(principal, 'project:delete', { type: 'project', id: row.id });
		const now = this.ctx.now();
		await this.ctx.audit.wrap(
			{ principal, action: 'project.delete', resource: 'project', resourceId: row.id, args: { slug }, operationId: options.operationId },
			() => {
				this.ctx.db
					.update(projects)
					// Keep the production pointer so a restore brings the site straight back (D29);
					// desired state and site access already skip deleted projects.
					.set({ deletedAt: now, purgeAt: now + this.ctx.policies.trashMs(), updatedAt: now })
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
		const row = this.requireRow(principal, slug, { includeDeleted: true });
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: row.id });
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
		const row = this.requireRow(principal, slug, { includeDeleted: true });
		this.ctx.iam.require(principal, 'project:delete', { type: 'project', id: row.id });
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
			// App errors (docs/APP-ERRORS.md) key hourly counts by issue, not project.
			this.ctx.sqlite.run('DELETE FROM app_error_events WHERE project_id = ?', [row.id]);
			this.ctx.sqlite.run(
				'DELETE FROM app_error_hourly WHERE issue_id IN (SELECT id FROM app_error_issues WHERE project_id = ?)',
				[row.id],
			);
			for (const table of ['app_error_issues', 'app_error_keys', 'app_error_projects', 'app_error_usage'])
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

function parsePlacementSpec(raw: string | null | undefined): import('@yoal/contracts').PlacementSpec | null {
	if (!raw) return null;
	try {
		return requirePlacementSpec(raw);
	} catch {
		return null;
	}
}

function requirePlacementSpec(raw: string): import('@yoal/contracts').PlacementSpec {
	const parsed = JSON.parse(raw) as unknown;
	return placementSpecSchema.parse(parsed);
}

/**
 * The password-hash change for one access scope. Password mode needs a password: a new one is
 * hashed, and omitting it keeps the scope's current hash only when the scope is already in password
 * mode with one stored. Any other mode clears that scope's hash and leaves the other scope alone.
 */
export function scopePasswordPatch(
	row: ProjectRow,
	scope: 'production' | 'previews',
	mode: ProjectRow['productionAccess'] | 'access',
	password?: string,
): Pick<Partial<ProjectRow>, 'productionPasswordHash' | 'previewPasswordHash'> {
	const field = scope === 'production' ? 'productionPasswordHash' : 'previewPasswordHash';
	if (mode !== 'password') return { [field]: null };
	if (password) return { [field]: hashPassword(password) };
	const currentMode = scope === 'production' ? row.productionAccess : row.previewAccess;
	if (currentMode === 'password' && row[field]) return {};
	throw new ValidationError(
		`A password is required to put ${scope === 'production' ? 'production' : 'previews'} in password mode.`,
	);
}
