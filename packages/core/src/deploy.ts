import { and, eq, isNull } from 'drizzle-orm';
import { projects } from '@skiff/db';
import {
	requirePermission,
	type DeployFiles,
	type DeploySite,
	type InlineFile,
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
				})
			: await this.ctx.uploads.finalize(principal, project, input.uploadId!, { promote: input.promote });
		return { ...view, projectCreated, hint: hintFor(input.files, input.spa) };
	}

	async deployFiles(principal: Principal, input: DeployFiles): Promise<DeploymentView> {
		const project = this.ctx.projects.requireRow(principal, input.project);
		return this.ctx.uploads.deployInline(principal, project, input.files, {
			promote: input.promote,
			message: input.message,
		});
	}
}

/** Suggest SPA mode when the build looks like one, never enable it silently (DESIGN §4.1). */
function hintFor(files: InlineFile[] | undefined, spa: boolean | undefined): string | undefined {
	if (!files || spa) return undefined;
	const paths = new Set(files.map((file) => file.path.replace(/^\.\//, '')));
	if (!paths.has('index.html')) return undefined;
	const htmlFiles = [...paths].filter((path) => path.endsWith('.html'));
	if (htmlFiles.length === 1)
		return 'This looks like a single-page app. Set `skiff.json` with { "spa": true } to route unknown paths to index.html.';
	return undefined;
}

export const _notFound = NotFoundError;
