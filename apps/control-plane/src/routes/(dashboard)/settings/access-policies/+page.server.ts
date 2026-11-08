import { fail } from '@sveltejs/kit';
import type { AccessPolicy, AccessPolicyScope } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { formOptionalString, formString, failStatus, toFormFailure } from '../../_lib/errors.js';
import { parseRuleLines } from './_lib/rules.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Access policies (IAM.md I25, §11.1). Deliberately compact: the policy list, its
 * ordered rules, and one form that turns Skiff Access on for a project or environment. A rule line
 * is `allow|deny <matcher> …`, e.g. `allow domain example.com` or `deny cidr 10.0.0.0/8`.
 */

interface ProjectOption {
	id: string;
	slug: string;
	name: string;
	productionAccess: string;
	previewAccess: string;
	productionAccessPolicyId: string | null;
	previewAccessPolicyId: string | null;
	environments: Array<{ id: string; slug: string; name: string; access: string; accessPolicyId: string | null }>;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	let denied = false;
	let policies: AccessPolicy[] = [];
	let projects: ProjectOption[] = [];
	try {
		policies = core.accessPolicies.list(principal);
	} catch {
		denied = true;
	}
	if (!denied) {
		for (const project of core.projects.list(principal)) {
			const row = core.projects.requireRow(principal, project.slug);
			let environments: ProjectOption['environments'] = [];
			try {
				environments = core.environments.list(principal, row).map((environment) => ({
					id: environment.id,
					slug: environment.slug,
					name: environment.name,
					access: environment.access,
					accessPolicyId: environment.accessPolicyId,
				}));
			} catch {
				// The project is still assignable even if its environments are not visible.
			}
			projects.push({
				id: project.id,
				slug: project.slug,
				name: project.name,
				productionAccess: project.productionAccess,
				previewAccess: project.previewAccess,
				productionAccessPolicyId: project.productionAccessPolicyId,
				previewAccessPolicyId: project.previewAccessPolicyId,
				environments,
			});
		}
	}
	return {
		denied,
		policies,
		projects,
		focusProject: url.searchParams.get('project'),
	};
};

function parseScope(value: string): AccessPolicyScope {
	if (value === 'org') return { type: 'org' };
	const [kind, id, projectId] = value.split(':');
	if (kind === 'project' && id) return { type: 'project', id };
	if (kind === 'env' && id && projectId) return { type: 'environment', id, projectId };
	throw new Error('Choose where the policy applies.');
}

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.accessPolicies.create(principal, {
				name: formString(data, 'name'),
				description: formOptionalString(data, 'description') ?? '',
				scope: parseScope(formString(data, 'scope')),
				enabled: true,
				rules: parseRuleLines(formString(data, 'rules')),
			});
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: 'Access policy created.' };
	},

	rules: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.accessPolicies.update(principal, formString(data, 'id'), {
				rules: parseRuleLines(formString(data, 'rules')),
			});
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: 'Policy rules saved, in order.' };
	},

	toggle: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.accessPolicies.update(principal, formString(data, 'id'), {
				enabled: formString(data, 'enabled') === 'true',
			});
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: 'Policy updated.' };
	},

	remove: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			core.accessPolicies.remove(principal, formString(data, 'id'));
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: 'Policy deleted.' };
	},

	assign: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const slug = formString(data, 'project');
		const target = formString(data, 'target');
		const policyId = formString(data, 'policyId') || null;
		try {
			const project = core.projects.requireRow(principal, slug);
			if (target === 'production' || target === 'previews') {
				core.accessPolicies.assign(principal, project, { scope: target, policyId });
			} else {
				const environmentId = target.startsWith('env:') ? target.slice(4) : '';
				if (!environmentId) throw new Error('Choose a project, production, previews or an environment.');
				core.accessPolicies.assign(principal, project, {
					scope: 'environment',
					environmentId,
					policyId,
				});
			}
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return {
			success: policyId
				? 'Skiff Access is on for that host. Agents converge within seconds.'
				: 'Skiff Access is off for that host; the site stays behind platform login.',
		};
	},
};

