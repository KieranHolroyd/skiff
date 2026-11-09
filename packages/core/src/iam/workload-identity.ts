/**
 * Workload identity (docs/IAM.md I18, §7.4).
 *
 * Every process or container workload runs as a service account. This service creates the account
 * on first use (no bindings by default, so it has no permissions until an operator grants some)
 * and mints the short-lived ES256 JWT the agent delivers to the workload.
 *
 * The issuer is the platform origin and the key comes from the shared ring's `workload` purpose
 * (`iam/keys.ts`). Tokens last one hour; the agent refreshes them at 50% of their lifetime, because
 * the agent — not this service — owns the delivery loop.
 *
 * Registry login and storage STS are deliberately deferred: both become consumers of this token
 * (the registry realm accepts it, RustFS via `AssumeRoleWithWebIdentity` if S3 passes) rather than
 * a second credential format.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { projects } from '@yoal/db';
import type { WorkloadRuntime } from '@yoal/contracts';
import {
	SLUG_MAX,
	SLUG_PATTERN,
	WORKLOAD_IDENTITY_AUDIENCE,
	WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
	workloadSpecSchema,
	type WorkloadIdentityActivation,
	type WorkloadIdentityResponse,
} from '@yoal/contracts';
import type { CoreContext } from '../context.ts';
import { CoreError, NotFoundError, ValidationError } from '../errors.ts';
import type { ProjectRow } from '../projects.ts';
import { newId, parseJson } from '../util.ts';

interface ServiceAccountRow {
	id: string;
	org_id: string;
	name: string;
	description: string;
	owner_group_id: string | null;
	disabled_at: number | null;
	created_by: string;
	created_at: number;
}

interface WorkloadRow {
	id: string;
	org_id: string;
	project_id: string;
	deployment_id: string;
	runtime_name: string | null;
	spec_json: string;
}

/** The fields the control plane and the agent need from one minted token. */
export interface MintedWorkloadToken {
	token: string;
	audience: string;
	expiresIn: number;
	serviceAccount: string;
	serviceAccountId: string;
	workloadId: string;
	orgId: string;
	projectId: string;
	environment: string;
}

/**
 * The default service account name: `wl-<project>-<env>` (IAM.md §7.4). Project slugs reach 40
 * characters and environment slugs reach 30, so the project half is truncated to fit the same slug
 * limit service accounts use. The result is deterministic for a given project and environment.
 */
export function workloadServiceAccountName(projectSlug: string, environment: string): string {
	const head = `wl-${slugPart(projectSlug, 'project')}`;
	const suffix = `-${slugPart(environment, 'production').slice(0, 30)}`;
	const room = SLUG_MAX - suffix.length;
	let name = `${head.slice(0, Math.max(1, room)).replace(/-+$/g, '')}${suffix}`;
	if (name.length > SLUG_MAX) name = name.slice(0, SLUG_MAX).replace(/-+$/g, '');
	return name;
}

function slugPart(value: string, fallback: string): string {
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || fallback;
}

function validateServiceAccountName(name: string): string {
	if (name.length < 3 || name.length > SLUG_MAX || !SLUG_PATTERN.test(name))
		throw new ValidationError(
			'A workload identity service account name uses 3–40 lowercase letters, digits and single hyphens.',
		);
	return name;
}

export class WorkloadIdentityService {
	constructor(private readonly ctx: CoreContext) {}

	/**
	 * Ensure the workload's service account exists and return it. The default name is
	 * `wl-<project>-<env>`; `override` is `identity.serviceAccount` from the workload spec. An
	 * account is created with no bindings, so it starts with no permissions.
	 */
	ensure(
		orgId: string,
		projectId: string,
		environment: string,
		override?: string | null,
	): ServiceAccountRow {
		const project = this.project(orgId, projectId);
		const overrideName =
			override === undefined ? this.specOverride(project) : override;
		const name = overrideName
			? validateServiceAccountName(overrideName.trim())
			: workloadServiceAccountName(project.slug, environment);
		const existing = this.byName(orgId, name);
		if (existing) return existing;

		const id = newId('sa_');
		const now = this.ctx.now();
		try {
			this.ctx.sqlite.run(
				`INSERT INTO service_accounts
				   (id, org_id, name, description, owner_group_id, disabled_at, created_by, created_at)
				 VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
				[
					id,
					orgId,
					name,
					`Workload identity for ${project.slug} (${environment})`,
					'system:workload-identity',
					now,
				],
			);
		} catch (error) {
			// A concurrent deploy may have created it between the lookup and the insert.
			const raced = this.byName(orgId, name);
			if (raced) return raced;
			throw error;
		}
		this.ctx.audit.record({
			action: 'service_account.create',
			resource: 'service_account',
			resourceId: id,
			orgId,
			args: { name, projectId, environment, workloadIdentity: true },
			result: 'ok',
		});
		return {
			id,
			org_id: orgId,
			name,
			description: `Workload identity for ${project.slug} (${environment})`,
			owner_group_id: null,
			disabled_at: null,
			created_by: 'system:workload-identity',
			created_at: now,
		};
	}

	/**
	 * Mint a one-hour token for a workload. `audience` is `yoal` for Yoal's API and is passed
	 * through unchanged for cloud federation (`sts.amazonaws.com`, …). Refresh at 50% of `expiresIn`
	 * is the caller's job; the agent owns that loop for delivered tokens.
	 */
	async mint(
		workloadId: string,
		audience: string = WORKLOAD_IDENTITY_AUDIENCE,
		options: { serviceAccount?: string | null } = {},
	): Promise<MintedWorkloadToken> {
		const workload = this.workload(workloadId);
		const project = this.project(workload.org_id, workload.project_id);
		const environment = this.environmentFor(project, workload.deployment_id);
		const parsed = workloadSpecSchema.safeParse(parseJson<unknown>(workload.spec_json, null));
		if (!parsed.success) throw new ValidationError('The workload spec is invalid.');
		if (!workloadGetsIdentity(parsed.data))
			throw new ValidationError('Only process and container app workloads get a workload identity.');
		const serviceAccount = this.ensure(
			project.orgId,
			project.id,
			environment,
			options.serviceAccount ?? parsed.data.identity?.serviceAccount ?? null,
		);
		if (serviceAccount.disabled_at !== null)
			throw new CoreError('forbidden', 'The workload identity service account is disabled.', 403);

		const requested = audience?.trim() || WORKLOAD_IDENTITY_AUDIENCE;
		if (requested.length > 512 || /[\u0000-\u001f\u007f]/.test(requested))
			throw new ValidationError('The token audience must be 1–512 printable characters.');

		const token = await this.ctx.signingKeys.sign(
			'workload',
			{
				sub: serviceAccount.id,
				aud: requested,
				org_id: project.orgId,
				project_id: project.id,
				environment,
				// RFC 8693 §4.1 `act`: the workload the service account is acting for.
				act: { sub: `wl:${project.slug}/${environment}`, name: serviceAccount.name },
			},
			WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
		);
		return {
			token,
			audience: requested,
			expiresIn: WORKLOAD_IDENTITY_TOKEN_TTL_SECONDS,
			serviceAccount: serviceAccount.name,
			serviceAccountId: serviceAccount.id,
			workloadId,
			orgId: project.orgId,
			projectId: project.id,
			environment,
		};
	}

	/** The activation payload for a process/container workload. */
	async activation(
		workloadId: string,
		audience: string = WORKLOAD_IDENTITY_AUDIENCE,
	): Promise<WorkloadIdentityActivation> {
		const minted = await this.mint(workloadId, audience);
		return {
			serviceAccount: minted.serviceAccount,
			serviceAccountId: minted.serviceAccountId,
			audience: minted.audience,
			token: minted.token,
			expiresIn: minted.expiresIn,
		};
	}

	/** The metadata endpoint shape, used by the agent's control-plane fetch. */
	async response(workloadId: string, audience: string): Promise<WorkloadIdentityResponse> {
		const minted = await this.mint(workloadId, audience);
		return {
			access_token: minted.token,
			expires_in: minted.expiresIn,
			token_type: 'Bearer',
		};
	}

	// ---------------------------------------------------------------- internals

	private project(orgId: string, projectId: string): ProjectRow {
		const row = this.ctx.db
			.select()
			.from(projects)
			.where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
			.get();
		if (!row) throw new NotFoundError('Project');
		return row as ProjectRow;
	}

	private workload(workloadId: string): WorkloadRow {
		const row = this.ctx.sqlite
			.query<WorkloadRow, [string]>(
				`SELECT id, org_id, project_id, deployment_id, runtime_name, spec_json
				 FROM workloads WHERE id = ?`,
			)
			.get(workloadId);
		if (!row) throw new NotFoundError('Workload');
		return row;
	}

	private environmentFor(project: ProjectRow, deploymentId: string): string {
		return this.ctx.environments.forDeployment(project, deploymentId).slug;
	}

	private byName(orgId: string, name: string): ServiceAccountRow | null {
		return (
			this.ctx.sqlite
				.query<ServiceAccountRow, [string, string]>(
					'SELECT * FROM service_accounts WHERE org_id = ? AND name = ?',
				)
				.get(orgId, name) ?? null
		);
	}

	/** `identity.serviceAccount` from the project's saved workload spec, when it has one. */
	private specOverride(project: ProjectRow): string | null {
		const parsed = workloadSpecSchema.safeParse(parseJson<unknown>(project.workloadJson, null));
		return parsed.success ? (parsed.data.identity?.serviceAccount ?? null) : null;
	}
}

/** True when a spec is an app workload that gets an identity (not a function or CI runner). */
export function workloadGetsIdentity(spec: { runtime: WorkloadRuntime; runner?: unknown }): boolean {
	return (spec.runtime === 'process' || spec.runtime === 'container') && !spec.runner;
}
