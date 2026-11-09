import { and, asc, eq, ne } from 'drizzle-orm';
import { environments, deployments } from '@yoal/db';
import {
	environmentCreateSchema,
	type EnvironmentCreateInput,
	type EnvironmentUpdateInput,
	type EnvironmentView,
	type Principal,
} from '@yoal/contracts';
import type { CoreContext } from './context.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { hashPassword, newId } from './util.ts';
import { effectiveAccessMode } from './access.ts';
import type { ProjectRow } from './projects.ts';
import type { DeploymentView } from './deployments.ts';

export type EnvironmentRow = typeof environments.$inferSelect;

/**
 * Named environments (D13, v2). `production` is created lazily for every project and keeps the
 * bare `<slug>.<contentDomain>` host. Other environments are single-label subdomains so the
 * wildcard certificate still covers them (D14): `<slug>--<env>.<contentDomain>`.
 */
export class EnvironmentService {
	constructor(private readonly ctx: CoreContext) {}

	get contentDomain(): string {
		return this.ctx.config.contentDomain;
	}

	hostFor(project: Pick<ProjectRow, 'slug'>, environment: Pick<EnvironmentRow, 'slug' | 'isProduction'> | null): string {
		if (!environment || environment.isProduction) return `${project.slug}.${this.contentDomain}`;
		return `${project.slug}--${environment.slug}.${this.contentDomain}`;
	}

	view(
		project: Pick<ProjectRow, 'slug'> &
			Partial<Pick<ProjectRow, 'productionPasswordHash' | 'productionAccessPolicyId'>>,
		row: EnvironmentRow,
	): EnvironmentView {
		const policyId = row.isProduction
			? (project.productionAccessPolicyId ?? null)
			: (row.accessPolicyId ?? null);
		return {
			id: row.id,
			projectId: row.projectId,
			projectSlug: project.slug,
			name: row.name,
			slug: row.slug,
			isProduction: row.isProduction,
			access: effectiveAccessMode(row.access, policyId),
			accessPolicyId: policyId,
			passwordSet: row.isProduction ? Boolean(project.productionPasswordHash) : Boolean(row.passwordHash),
			host: this.hostFor(project, row),
			deploymentId: row.deploymentId,
			createdAt: new Date(row.createdAt).toISOString(),
		};
	}

	rows(projectId: string): EnvironmentRow[] {
		return this.ctx.db
			.select()
			.from(environments)
			.where(eq(environments.projectId, projectId))
			.orderBy(asc(environments.createdAt))
			.all();
	}

	/** Idempotent: deployment and desired-state paths call this without a separate migration step. */
	ensureProduction(project: ProjectRow): EnvironmentRow {
		const existing = this.ctx.db
			.select()
			.from(environments)
			.where(and(eq(environments.projectId, project.id), eq(environments.isProduction, true)))
			.get();
		if (existing) return existing;
		const now = this.ctx.now();
		const row: EnvironmentRow = {
			id: newId('env_'),
			orgId: project.orgId,
			projectId: project.id,
			name: 'Production',
			slug: 'production',
			isProduction: true,
			access: project.productionAccess,
			accessPolicyId: project.productionAccessPolicyId ?? null,
			// Production follows the project's production password; this column stays unused.
			passwordHash: null,
			deploymentId: project.productionDeploymentId,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(environments).values(row).run();
		return row;
	}

	/** Environment a deployment belongs to; legacy v1 rows have none, so they read as production. */
	forDeployment(project: ProjectRow, deploymentId: string): EnvironmentRow {
		const deployment = this.ctx.db
			.select({ environmentId: deployments.environmentId })
			.from(deployments)
			.where(eq(deployments.id, deploymentId))
			.get();
		const byId = deployment?.environmentId
			? this.ctx.db.select().from(environments).where(eq(environments.id, deployment.environmentId)).get()
			: undefined;
		return byId ?? this.ensureProduction(project);
	}

	list(principal: Principal, project: ProjectRow): EnvironmentView[] {
		this.ctx.iam.require(principal, 'project:read', { type: 'project', id: project.id });
		this.ensureProduction(project);
		return this.rows(project.id).map((row) => this.view(project, row));
	}

	create(principal: Principal, project: ProjectRow, input: EnvironmentCreateInput): EnvironmentView {
		this.ctx.iam.require(principal, 'project:update', { type: 'project', id: project.id });
		this.ensureProduction(project);
		const parsed = environmentCreateSchema.parse(input);
		const slug = parsed.slug ?? slugify(parsed.name);
		if (!slug) throw new ValidationError('Environment names need at least one letter or digit.');
		if (slug === 'production') throw new ConflictError('The production environment is built in.');
		const clash = this.rows(project.id).find((row) => row.slug === slug);
		if (clash) throw new ConflictError(`An environment named "${slug}" already exists.`);
		const access = parsed.access ?? effectiveAccessMode(project.previewAccess, project.previewAccessPolicyId);
		if (access === 'access' && !parsed.policyId && !project.previewAccessPolicyId)
			throw new ValidationError('Choose a Yoal Access policy for this environment.');
		const policyId =
			access === 'access'
				? (parsed.policyId ?? project.previewAccessPolicyId ?? null)
				: null;
		let passwordHash: string | null = null;
		if (access === 'password') {
			if (parsed.password) passwordHash = hashPassword(parsed.password);
			// An environment that inherits password-protected previews inherits their password too.
			else if (!parsed.access && project.previewPasswordHash) passwordHash = project.previewPasswordHash;
			else throw new ValidationError('A password is required for password mode.');
		}
		const now = this.ctx.now();
		const row: EnvironmentRow = {
			id: newId('env_'),
			orgId: project.orgId,
			projectId: project.id,
			name: parsed.name,
			slug,
			isProduction: false,
			access: access === 'access' ? 'platform' : access,
			accessPolicyId: policyId,
			passwordHash,
			deploymentId: null,
			createdAt: now,
			updatedAt: now,
		};
		this.ctx.db.insert(environments).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'environment.create',
			resource: 'environment',
			resourceId: row.id,
			args: { project: project.slug, slug, name: parsed.name },
			result: 'ok',
		});
		this.ctx.projects.bump(project.orgId);
		return this.view(project, row);
	}

	update(principal: Principal, project: ProjectRow, slug: string, input: EnvironmentUpdateInput): EnvironmentView {
		const row = this.requireRow(project, slug);
		this.ctx.iam.require(principal, 'project:update', {
			type: 'environment',
			id: row.id,
			projectId: project.id,
		});
		if (row.isProduction) throw new ConflictError('The production environment cannot be renamed.');
		const access =
			input.access ?? effectiveAccessMode(row.access, row.accessPolicyId ?? null);
		const policyId =
			access === 'access'
				? (input.policyId !== undefined ? input.policyId : (row.accessPolicyId ?? null))
				: null;
		if (access === 'access' && !policyId)
			throw new ValidationError('Choose a Yoal Access policy for this environment.');
		// The environment's own password; other scopes are never touched.
		let passwordHash = row.passwordHash;
		if (access !== 'password') passwordHash = null;
		else if (input.password) passwordHash = hashPassword(input.password);
		else if (row.access !== 'password' || !row.passwordHash)
			throw new ValidationError('A password is required for password mode.');
		const next = {
			...row,
			name: input.name ?? row.name,
			access: access === 'access' ? 'platform' : access,
			accessPolicyId: policyId,
			passwordHash,
		};
		this.ctx.db
			.update(environments)
			.set({
				name: next.name,
				access: access === 'access' ? 'platform' : access,
				accessPolicyId: policyId,
				passwordHash,
				updatedAt: this.ctx.now(),
			})
			.where(eq(environments.id, row.id))
			.run();
		if (input.access !== undefined || input.password || input.policyId !== undefined)
			this.ctx.audit.record({
				principal,
				action: 'environment.set_access',
				resource: 'environment',
				resourceId: row.id,
				args: { project: project.slug, slug, mode: access, policyId, passwordChanged: Boolean(input.password) },
				result: 'ok',
			});
		this.ctx.projects.bump(project.orgId);
		return this.view(project, next);
	}

	remove(principal: Principal, project: ProjectRow, slug: string): void {
		const row = this.requireRow(project, slug);
		this.ctx.iam.require(principal, 'project:update', {
			type: 'environment',
			id: row.id,
			projectId: project.id,
		});
		if (row.isProduction) throw new ConflictError('The production environment cannot be deleted.');
		const used = this.ctx.db
			.select({ id: deployments.id })
			.from(deployments)
			.where(and(eq(deployments.environmentId, row.id), ne(deployments.status, 'deleted')))
			.limit(1)
			.get();
		if (used)
			throw new ConflictError('Delete the deployments in this environment before removing it.');
		this.ctx.db.delete(environments).where(eq(environments.id, row.id)).run();
		this.ctx.audit.record({
			principal,
			action: 'environment.delete',
			resource: 'environment',
			resourceId: row.id,
			args: { project: project.slug, slug },
			result: 'ok',
		});
		this.ctx.projects.bump(project.orgId);
	}

	/**
	 * Point this environment at a deployment. Delegates to the deployment service so permissions,
	 * production history and retention stay in one place.
	 */
	promote(
		principal: Principal,
		project: ProjectRow,
		slug: string,
		deploymentId: string,
	): Promise<DeploymentView> {
		const row = this.requireRow(project, slug);
		this.ctx.iam.require(principal, 'deployment:promote', {
			type: 'environment',
			id: row.id,
			projectId: project.id,
		});
		return this.ctx.deployments.promote(principal, project, deploymentId, slug);
	}

	/** Walk back this environment's pointer (production uses promotion history). */
	rollback(principal: Principal, project: ProjectRow, slug: string): Promise<DeploymentView> {
		const row = this.requireRow(project, slug);
		this.ctx.iam.require(principal, 'deployment:rollback', {
			type: 'environment',
			id: row.id,
			projectId: project.id,
		});
		return this.ctx.deployments.rollback(principal, project, slug);
	}

	/** Move an environment's pointer; production mirrors `projects.productionDeploymentId`. */
	setDeployment(row: EnvironmentRow, deploymentId: string | null): void {
		this.ctx.db
			.update(environments)
			.set({ deploymentId, updatedAt: this.ctx.now() })
			.where(eq(environments.id, row.id))
			.run();
	}

	requireRow(project: ProjectRow, slug: string): EnvironmentRow {
		const row = this.ctx.db
			.select()
			.from(environments)
			.where(and(eq(environments.projectId, project.id), eq(environments.slug, slug)))
			.get();
		if (!row) throw new NotFoundError('Environment');
		return row;
	}
}

function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 30)
		.replace(/-+$/g, '');
}
