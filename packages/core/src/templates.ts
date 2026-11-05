import * as z from 'zod';
import {
	buildAppTemplate,
	getAppTemplate,
	listAppTemplates,
	requirePermission,
	templateSecretSuffix,
	type AppTemplateView,
	type Principal,
	type TemplatePlan,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import type { DeploymentView } from './deployments.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import type { ProjectView } from './projects.ts';

export interface TemplateResult {
	project: ProjectView;
	deployment: DeploymentView;
	/** Names of the secrets the template created on the project (values are never returned). */
	secrets: string[];
}

/** The release a template deployment carries instead of uploaded files (D92). */
export const TEMPLATE_MANIFEST_PATH = 'skiff-template.json';

/**
 * First-party app templates (plan 21, D92). `instantiate` runs the template's pure plan through
 * the normal services — project, secrets, workload spec, deployment — so every permission check,
 * quota and audit entry is the one a hand-built project would get. A failure after the project
 * exists purges it again, so a bad template run never leaves a half-made project or a stray
 * credential behind.
 */
export class TemplateService {
	constructor(private readonly ctx: CoreContext) {}

	list(principal: Principal): AppTemplateView[] {
		requirePermission(principal, 'project:read');
		return listAppTemplates();
	}

	get(principal: Principal, id: string): AppTemplateView {
		requirePermission(principal, 'project:read');
		const template = getAppTemplate(id);
		if (!template) throw new NotFoundError(`Template "${id}"`);
		return template;
	}

	async instantiate(principal: Principal, id: string, values: Record<string, unknown>): Promise<TemplateResult> {
		requirePermission(principal, 'project:create');
		requirePermission(principal, 'project:update');
		requirePermission(principal, 'deployment:create');
		const draft = this.build(id, values);
		if (draft.secrets.length > 0) requirePermission(principal, 'secret:create');
		const missing = draft.requiredSecrets.filter((name) => !this.ctx.secrets.getValue(principal.orgId, name));
		if (missing.length > 0)
			throw new ValidationError(
				`Secret ${missing.join(', ')} does not exist. Create it first or paste the credential instead.`,
				missing.map((name) => `Secret ${name} does not exist.`),
			);

		const view = await this.ctx.projects.create(principal, {
			name: draft.project.name,
			...(draft.project.slug ? { slug: draft.project.slug } : {}),
			runtime: draft.project.runtime,
			placement: draft.project.placement,
			// Workers have no route; keep any preview URL off the public internet regardless.
			productionAccess: 'platform',
			previewAccess: 'platform',
		});
		const created = this.ctx.projects.requireById(principal, view.id);
		try {
			const plan = this.build(id, values, templateSecretSuffix(created.slug));
			for (const secret of plan.secrets)
				await this.ctx.secrets.set(principal, { name: secret.name, value: secret.value, projectId: created.id });
			this.ctx.workloads.setSpec(principal, this.ctx.projects.requireById(principal, created.id), plan.spec);
			const manifest = new TextEncoder().encode(`${JSON.stringify(plan.manifest, null, '\t')}\n`);
			const deployment = await this.ctx.deployments.deployEntries(
				principal,
				this.ctx.projects.requireById(principal, created.id),
				[{ path: TEMPLATE_MANIFEST_PATH, data: manifest }],
				{ promote: true, message: `Created from the ${getAppTemplate(id)?.name ?? id} template` },
			);
			this.ctx.audit.record({
				principal,
				action: 'template.instantiate',
				resource: 'project',
				resourceId: created.id,
				args: { template: id, project: created.slug, secrets: plan.secrets.map((secret) => secret.name) },
				result: 'ok',
			});
			return {
				project: await this.ctx.projects.get(principal, created.slug),
				deployment,
				secrets: plan.secrets.map((secret) => secret.name),
			};
		} catch (error) {
			// Purge, not trash: the project never ran, and its slug and secrets should be free again.
			await this.ctx.projects.purgeRow(this.ctx.projects.requireById(principal, created.id, { includeDeleted: true }));
			throw error;
		}
	}

	private build(id: string, values: Record<string, unknown>, secretSuffix?: string): TemplatePlan {
		if (!getAppTemplate(id)) throw new NotFoundError(`Template "${id}"`);
		try {
			return buildAppTemplate(id, values, secretSuffix ? { secretSuffix } : {})!;
		} catch (error) {
			if (error instanceof z.ZodError) {
				const issues = error.issues.map((issue) => `${issue.path.join('.') || 'values'}: ${issue.message}`);
				throw new ValidationError(issues[0] ?? 'The template values are invalid.', issues);
			}
			throw error;
		}
	}
}
