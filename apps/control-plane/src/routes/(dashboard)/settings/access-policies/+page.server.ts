import { fail } from '@sveltejs/kit';
import type { AccessPolicy, AccessPolicyScope, AccessServiceToken } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { formOptionalString, formString, failStatus, toFormFailure } from '../../_lib/errors.js';
import { parseRuleLines } from './_lib/rules.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Yoal Access (IAM.md I25, §11.1). Deliberately compact: the policy list, its
 * ordered rules, and one form that turns Yoal Access on for a project or environment. A rule line
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

export interface PolicyWithTokens extends AccessPolicy {
	serviceTokens: AccessServiceToken[];
}

export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	let denied = false;
	let policies: PolicyWithTokens[] = [];
	let projects: ProjectOption[] = [];
	try {
		policies = core.accessPolicies.list(principal).map((policy) => {
			let serviceTokens: AccessServiceToken[] = [];
			try {
				serviceTokens = core.accessPolicies.listServiceTokens(principal, policy.id);
			} catch {
				// The policy is visible; a missing token list should not hide it.
			}
			return { ...policy, serviceTokens };
		});
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

	/**
	 * Mint a named machine token: the raw `yoal_svc_…` value is returned once, and only its SHA-256
	 * is stored. Revoking the row later rotates the policy version, so cookies issued under the old
	 * policy stop verifying. Creating a token does not sign anyone out.
	 */
	serviceToken: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const created = core.accessPolicies.createServiceToken(principal, formString(data, 'id'), {
				name: formString(data, 'name'),
				header: formOptionalString(data, 'header') || 'X-Yoal-Access-Token',
			});
			return {
				success: 'Machine token created. Copy it now: it is shown once.',
				serviceToken: created.secret,
				serviceTokenHeader: created.token.header,
				serviceTokenName: created.token.name,
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	/**
	 * Revoke a named machine token by id. A legacy `serviceToken` rule is still revoked by `idx`
	 * through the rules editor, so older policy JSON keeps working.
	 */
	revokeServiceToken: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const policyId = formString(data, 'id');
			const tokenId = formOptionalString(data, 'tokenId');
			if (tokenId) {
				core.accessPolicies.revokeServiceToken(principal, policyId, tokenId);
				return { success: 'Machine token revoked. Its header pair stops working within seconds.' };
			}
			const policy = core.accessPolicies.get(principal, policyId);
			const idx = Number(formString(data, 'idx'));
			if (!Number.isInteger(idx)) throw new Error('Choose a service token to revoke.');
			const target = policy.rules.find((rule) => rule.idx === idx);
			if (!target || target.matcher.type !== 'serviceToken')
				throw new Error('Choose a service token to revoke.');
			const rules = policy.rules.filter((rule) => rule.idx !== idx);
			if (rules.length === policy.rules.length) throw new Error('Choose a service token to revoke.');
			core.accessPolicies.update(principal, policy.id, { rules });
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
		return { success: 'Service token revoked. Its header pair stops working within seconds.' };
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
				? 'Yoal Access is on for that host. Agents converge within seconds.'
				: 'Yoal Access is off for that host; the site stays behind platform login.',
		};
	},
};

