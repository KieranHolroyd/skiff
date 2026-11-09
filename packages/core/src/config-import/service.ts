import {
	CONFIG_EXPORT_VERSION,
	configExportSections,
	configImportRequestSchema,
	type ConfigImportRequest,
	type ConfigImportView,
	type Principal,
} from '@yoal/contracts';
import { ValidationError } from '../errors.ts';
import { ImportContext, obj, str, type Doc, type Sources } from './context.ts';
import { ImportPlan, runPlan, viewOf } from './engine.ts';
import { planIdentityEarly, planIdentityLate } from './identity.ts';
import { planIntegrations } from './integrations.ts';
import { planProjectSettings, planProjects, planSecrets, planServices } from './stack.ts';

/**
 * Config import (docs/OPERATIONS.md §14): recreate a config export on this instance. `plan` reads
 * only; `apply` builds the same plan and runs it. Create-only and safe to repeat: whatever exists
 * under the same name is left as it is, and a second run only does what is still missing.
 *
 * Every step goes through the normal service call with the caller's principal, so permissions,
 * quotas, feature flags and per-resource audit rows are exactly what the same clicks would do.
 */
export class ConfigImportService {
	constructor(private readonly core: Sources) {}

	async plan(principal: Principal, raw: unknown): Promise<ConfigImportView> {
		const { ctx, source } = this.build(principal, raw);
		return viewOf(ctx.plan, 'plan', source);
	}

	async apply(principal: Principal, raw: unknown): Promise<ConfigImportView> {
		const { ctx, source } = this.build(principal, raw);
		await runPlan(ctx.plan);
		const view = viewOf(ctx.plan, 'apply', source);
		this.core.audit.record({
			principal,
			action: 'config.import',
			resource: 'org',
			resourceId: principal.orgId,
			args: { source, summary: view.summary, failed: view.steps.filter((step) => step.status === 'failed').map((step) => step.key) },
			result: view.summary.failed > 0 ? 'error' : 'ok',
			...(view.summary.failed > 0 ? { error: `${view.summary.failed} step(s) failed` } : {}),
		});
		return view;
	}

	private build(principal: Principal, raw: unknown) {
		const input: ConfigImportRequest = configImportRequestSchema.parse(raw);
		const doc = parseDocument(input.document);
		const known = new Set<string>([...configExportSections, 'members']);
		const plan = new ImportPlan();
		for (const section of [...(input.only ?? []), ...(input.skip ?? [])])
			if (!known.has(section)) plan.warnings.push(`"${section}" is not an export section; it was ignored.`);
		const ctx = new ImportContext(this.core, principal, doc, plan, {
			only: input.only?.length ? new Set(input.only) : null,
			skip: new Set(input.skip ?? []),
			projects: input.projects?.length ? new Set(input.projects) : null,
			secrets: input.secrets ?? {},
		});
		if (ctx.options.projects)
			for (const slug of ctx.options.projects)
				if (!ctx.projects().some((project) => project.slug === slug)) plan.warnings.push(`Project "${slug}" is not in the file.`);

		// Order matters: a step only waits for steps added before it.
		planSecrets(ctx, 'org');
		planIdentityEarly(ctx);
		planProjects(ctx);
		planSecrets(ctx, 'projects');
		planServices(ctx);
		planProjectSettings(ctx);
		planIdentityLate(ctx);
		planIntegrations(ctx);

		const header = obj(doc);
		const source = {
			platform: str(obj(header.platform).url),
			org: str(obj(header.org).name) ?? str(obj(header.org).slug),
			exportedAt: str(header.exportedAt),
		};
		return { ctx, source };
	}
}

/** The export as an object: JSON when it starts with `{`, else YAML. */
export function parseDocument(document: string | Record<string, unknown>): Doc {
	let doc: unknown = document;
	if (typeof document === 'string') {
		const text = document.trim();
		try {
			doc = JSON.parse(text);
		} catch (jsonError) {
			// Not JSON: YAML (flow-style YAML also starts with `{`, so try it either way).
			try {
				doc = Bun.YAML.parse(text);
			} catch (yamlError) {
				const error = text.startsWith('{') ? jsonError : yamlError;
				throw new ValidationError(`The file is not valid ${text.startsWith('{') ? 'JSON' : 'YAML'}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	const root = obj(doc);
	if (root.apiVersion !== CONFIG_EXPORT_VERSION)
		throw new ValidationError(
			root.apiVersion
				? `This file is ${String(root.apiVersion)}; this platform imports ${CONFIG_EXPORT_VERSION}.`
				: `This is not a Yoal config export (no apiVersion: ${CONFIG_EXPORT_VERSION}). Create one with \`yoal export\`.`,
		);
	return root;
}
