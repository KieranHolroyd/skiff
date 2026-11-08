import { error, fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { sso } from '#lib/server/sso.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → SSO (IAM.md I19, §8.3). OIDC providers and the email domains that route to them.
 * JIT provisioning, group mapping, enforcement, SAML and SCIM are shown as not yet built: this
 * slice stores configuration and proves domain ownership, and does not fake a sign-in flow.
 */

export const load: PageServerLoad = async ({ locals }) => {
	const principal = locals.principal!;
	const resource = { type: 'org' as const };
	if (!core.iam.can(principal, 'sso:read', resource))
		error(403, 'You need permission to read SSO settings.');

	const providers = sso.listProviders(principal);
	// Re-checks domains whose last check is a day old. Each lookup is bounded by the system resolver;
	// a failure is recorded as "not verified" rather than breaking the page.
	let domains = sso.listDomains(principal);
	try {
		domains = await sso.recheckDueDomains(principal);
	} catch {
		// Keep the stored state when DNS is unavailable.
	}

	return {
		providers,
		domains,
		canManage: core.iam.can(principal, 'sso:manage', resource)
	};
};

function scopes(data: FormData): string[] {
	const raw = formString(data, 'scopes');
	return (raw ? raw.split(/[\s,]+/) : ['openid', 'profile', 'email']).filter(Boolean);
}

function failure(cause: unknown) {
	return fail(failStatus(cause), toFormFailure(cause));
}

export const actions: Actions = {
	saveProvider: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'providerId');
		const clientSecret = formString(data, 'clientSecret');
		const discoveryUrl = formString(data, 'discoveryUrl');
		const input = {
			name: formString(data, 'name'),
			issuer: formString(data, 'issuer'),
			clientId: formString(data, 'clientId'),
			...(clientSecret ? { clientSecret } : {}),
			discoveryUrl: discoveryUrl || null,
			scopes: scopes(data),
			claims: {
				email: formString(data, 'claimEmail'),
				name: formString(data, 'claimName'),
				groups: formString(data, 'claimGroups')
			}
		};
		try {
			if (id) {
				await sso.updateProvider(principal, id, input);
				return { success: 'SSO provider saved.' };
			}
			if (!clientSecret)
				return fail(400, {
					message: 'The client secret is required for a new provider.',
					fieldErrors: { clientSecret: 'Required.' }
				});
			await sso.createProvider(principal, { ...input, clientSecret });
			return { success: 'SSO provider added. Verify an email domain to route sign-ins to it.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	toggleProvider: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'providerId');
		if (!id) return fail(400, { message: 'Missing provider id.' });
		try {
			const enabled = sso.providerEnabled(principal, id);
			await sso.updateProvider(principal, id, { enabled: !enabled });
			return { success: enabled ? 'Provider disabled.' : 'Provider enabled.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	removeProvider: async ({ request, locals }) => {
		const principal = locals.principal!;
		const id = formString(await request.formData(), 'providerId');
		if (!id) return fail(400, { message: 'Missing provider id.' });
		try {
			sso.removeProvider(principal, id);
			return { success: 'SSO provider removed.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	addDomain: async ({ request, locals }) => {
		const principal = locals.principal!;
		const domain = formString(await request.formData(), 'domain');
		try {
			const added = await sso.addDomain(principal, domain);
			return {
				success: added.verified
					? `${added.domain} is verified.`
					: `${added.domain} added. Publish the TXT record, then verify.`
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	verifyDomain: async ({ request, locals }) => {
		const principal = locals.principal!;
		const domain = formString(await request.formData(), 'domain');
		try {
			const checked = await sso.verifyDomain(principal, domain);
			return {
				success: checked.verified
					? `${checked.domain} is verified.`
					: `${checked.domain} is not verified yet: no ${checked.txtRecordValue} TXT record was found.`
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	removeDomain: async ({ request, locals }) => {
		const principal = locals.principal!;
		const domain = formString(await request.formData(), 'domain');
		try {
			sso.removeDomain(principal, domain);
			return { success: `${domain} removed.` };
		} catch (cause) {
			return failure(cause);
		}
	}
};
