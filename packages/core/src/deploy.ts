import { and, eq, isNull } from 'drizzle-orm';
import { deployments, projects, releases } from '@skiff/db';
import { parseManifest } from './artifact.ts';
import {
	requirePermission,
	type DeployFiles,
	type DeploySite,
	type Principal,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import type { DeploymentView } from './deployments.ts';
import type { ProjectRow } from './projects.ts';

export interface DeployResult extends DeploymentView {
	projectCreated: boolean;
	hint?: string;
}

/**
 * `deploy_site` / `deploy_files` orchestration (DESIGN §6.3): create the project if missing,
 * then deploy. `promote` defaults to true.
 */
export class DeployService {
	constructor(private readonly ctx: CoreContext) {}

	async deploySite(principal: Principal, input: DeploySite): Promise<DeployResult> {
		if (!input.files && !input.uploadId) throw new ValidationError('Provide `files` or an `uploadId`.');
		if (input.files && input.uploadId) throw new ValidationError('Provide either `files` or `uploadId`, not both.');
		let project = this.ctx.db
			.select()
			.from(projects)
			.where(and(eq(projects.orgId, principal.orgId), eq(projects.slug, input.name), isNull(projects.deletedAt)))
			.get() as ProjectRow | undefined;
		let projectCreated = false;
		if (!project) {
			requirePermission(principal, 'project:create');
			const view = await this.ctx.projects.create(principal, {
				name: input.name,
				slug: input.name,
				runtime: 'static',
				placement: 'edge',
				productionAccess: 'public',
				previewAccess: 'platform',
			});
			project = this.ctx.projects.requireById(principal, view.id);
			projectCreated = true;
		}
		const view = input.files
			? await this.ctx.uploads.deployInline(principal, project, input.files, {
					promote: input.promote,
					environment: input.environment,
				})
			: await this.ctx.uploads.finalize(principal, project, input.uploadId!, {
					promote: input.promote,
					environment: input.environment,
				});
		return { ...view, projectCreated, hint: input.spa === false ? undefined : this.spaHint(view.id) };
	}

	private spaHint(deploymentId: string): string | undefined {
		const row = this.ctx.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
		if (!row) return undefined;
		if (this.ctx.deployments.configFor(row).config.spa) return undefined;
		const release = this.ctx.db.select({ manifestJson: releases.manifestJson }).from(releases).where(eq(releases.id, row.releaseId)).get();
		const paths = parseManifest(release?.manifestJson ?? '[]').map((file) => file.path);
		return looksLikeSpa(paths) ? SPA_HINT : undefined;
	}

	async deployFiles(principal: Principal, input: DeployFiles): Promise<DeploymentView> {
		const project = this.ctx.projects.requireRow(principal, input.project);
		return this.ctx.uploads.deployInline(principal, project, input.files, {
			promote: input.promote,
			message: input.message,
			environment: input.environment,
		});
	}
}

/**
 * Suggest SPA mode when the build looks like one, never enable it silently (DESIGN §4.1). Works
 * for inline and uploaded deploys alike because it reads the stored release manifest.
 */
function looksLikeSpa(paths: string[]): boolean {
	if (!paths.includes('index.html')) return false;
	return paths.filter((path) => path.endsWith('.html')).length === 1;
}

const SPA_HINT =
	'This looks like a single-page app. Set `skiff.json` with { "spa": true } to route unknown paths to index.html.';

export const _notFound = NotFoundError;
