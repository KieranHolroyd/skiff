import { error, fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { platformOrigin } from '#lib/server/config.js';
import { sqlite } from '#lib/server/db.js';
import { userHasSecondFactor } from '#lib/server/second-factor.js';
import { reserveSsoProviderId, sso, ssoCallbackUrl, ssoSamlAcs, ssoSamlMetadata } from '#lib/server/sso.js';
import { ssoPreset } from '#lib/sso-presets.js';
import { ssoDefaultRole } from '#lib/server/sso-provision.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → SSO (IAM.md I19/I20/I21, §8.3–§8.5). OIDC providers, the email domains that route to
 * them, group mapping, SCIM bearer tokens and the org authentication policy (required SSO/2FA,
 * methods, session limits, IP allowlist, break-glass owners). SAML is still not built.
 *
 * Adding a provider starts from a preset (`#lib/sso-presets.ts`, D180) or a custom OIDC issuer.
 * The provider id is reserved at load time so the dialog can show the exact redirect URI to
 * register at the IdP before the provider exists.
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

	const owners = sqlite
		.query<{ id: string; email: string; name: string }, [string]>(
			`SELECT u.id, u.email, u.name
			 FROM member m JOIN user u ON u.id = m.userId
			 WHERE m.organizationId = ? AND m.role = 'owner'
			 ORDER BY u.email COLLATE NOCASE`
		)
		.all(principal.orgId)
		.map((owner) => ({ ...owner, hasSecondFactor: userHasSecondFactor(owner.id) }));

	const reservedProviderId = reserveSsoProviderId();
	return {
		providers,
		reservedProviderId,
		reservedCallbackUrl: ssoCallbackUrl(reservedProviderId),
		reservedAcsUrl: ssoSamlAcs(reservedProviderId),
		reservedSpMetadataUrl: ssoSamlMetadata(reservedProviderId),
		domains,
		owners,
		policy: core.authPolicy.get(principal),
		defaultSsoRole: ssoDefaultRole,
		scimTokens: core.scim.list(principal),
		scimEndpoint: `${platformOrigin}/api/auth/scim/v2`,
		groupMappings: sso.listGroupMappings(principal),
		// SCIM groups are authoritative from the directory, so they are not mapping targets.
		groups: core.iam.listGroups(principal.orgId).filter((group) => group.source !== 'scim'),
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
		const protocol: 'oidc' | 'saml' =
			formString(data, 'protocol') === 'saml' ? 'saml' : 'oidc';
		const clientSecret = formString(data, 'clientSecret');
		const discoveryUrl = formString(data, 'discoveryUrl');
		// A preset's own fields arrive as `preset.<key>`; the server resolves the issuer from them
		// again rather than trusting the dialog's preview.
		const preset = ssoPreset(formString(data, 'preset'));
		const presetInput = preset
			? {
					preset: {
						id: preset.id,
						values: Object.fromEntries(
							preset.fields.map((field) => [field.key, formString(data, `preset.${field.key}`)])
						)
					}
				}
			: { issuer: formString(data, 'issuer'), discoveryUrl: discoveryUrl || null };
		const saml = {
			metadataUrl: formString(data, 'samlMetadataUrl') || null,
			entityId: formString(data, 'samlEntityId'),
			entryPoint: formString(data, 'samlEntryPoint'),
			cert: formString(data, 'samlCert'),
			spEntityId: formString(data, 'samlSpEntityId'),
			audience: formString(data, 'samlAudience'),
			wantAssertionsSigned: formBoolean(data, 'samlWantAssertionsSigned'),
			identifierFormat: formString(data, 'samlIdentifierFormat')
		};
		const input = {
			name: formString(data, 'name'),
			protocol,
			...(protocol === 'oidc' ? presetInput : { issuer: formString(data, 'samlEntityId') }),
			clientId: formString(data, 'clientId'),
			...(clientSecret ? { clientSecret } : {}),
			...(protocol === 'oidc' ? { scopes: scopes(data) } : {}),
			claims: {
				email: formString(data, 'claimEmail'),
				name: formString(data, 'claimName'),
				groups: formString(data, 'claimGroups')
			},
			...(protocol === 'saml' ? { saml } : {})
		};
		try {
			if (id) {
				await sso.updateProvider(principal, id, input);
				return { success: 'SSO provider saved.' };
			}
			if (protocol === 'oidc' && !clientSecret)
				return fail(400, {
					message: 'The client secret is required for a new provider.',
					fieldErrors: { clientSecret: 'Required.' }
				});
			const reservedId = formString(data, 'reservedProviderId');
			await sso.createProvider(
				principal,
				protocol === 'oidc' ? { ...input, clientSecret } : input,
				reservedId || undefined
			);
			return {
				success:
					protocol === 'saml'
						? 'SAML provider added. Give the IdP the SP metadata or ACS URL shown above.'
						: 'SSO provider added. Verify an email domain to route sign-ins to it.'
			};
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
	},

	savePolicy: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const requireSso = formBoolean(data, 'requireSso');
		const require2fa = formBoolean(data, 'require2fa');
		const methods = data
			.getAll('methods')
			.filter((value): value is string => typeof value === 'string');
		const breakGlassUserIds = data
			.getAll('breakGlass')
			.filter((value): value is string => typeof value === 'string');

		const hours = formString(data, 'sessionMaxAgeHours');
		const minutes = formString(data, 'idleTimeoutMinutes');
		const sessionMaxAge = hours ? Number(hours) * 3600 : null;
		const idleTimeout = minutes ? Number(minutes) * 60 : null;
		if (hours && (sessionMaxAge === null || !Number.isInteger(sessionMaxAge) || sessionMaxAge <= 0))
			return fail(400, { message: 'Session maximum age must be a whole number of hours.' });
		if (minutes && (idleTimeout === null || !Number.isInteger(idleTimeout) || idleTimeout <= 0))
			return fail(400, { message: 'Idle timeout must be a whole number of minutes.' });

		// Preflight before turning enforcement on (IAM.md §8.3): without an enabled IdP, a verified
		// domain and a break-glass owner who can actually prove a factor, everyone could be locked out.
		if (requireSso) {
			if (!sso.listProviders(principal).some((provider) => provider.enabled))
				return fail(400, {
					message: 'Add and enable an identity provider before requiring SSO.'
				});
			if (!sso.listDomains(principal).some((domain) => domain.verified))
				return fail(400, {
					message: 'Verify at least one email domain before requiring SSO.'
				});
			const owners = sqlite
				.query<{ id: string }, [string]>(
					"SELECT u.id FROM member m JOIN user u ON u.id = m.userId WHERE m.organizationId = ? AND m.role = 'owner'"
				)
				.all(principal.orgId);
			const ownerIds = new Set(owners.map((owner) => owner.id));
			const usable = breakGlassUserIds.some((id) => ownerIds.has(id) && userHasSecondFactor(id));
			if (!usable)
				return fail(400, {
					message:
						'Choose at least one break-glass owner who has a passkey or authenticator app. Otherwise an IdP outage locks everyone out.'
				});
		}

		try {
			core.authPolicy.update(principal, {
				requireSso,
				require2fa,
				allowedMethods: methods as Parameters<typeof core.authPolicy.update>[1]['allowedMethods'],
				sessionMaxAge,
				idleTimeout,
				ipAllowlist: formString(data, 'ipAllowlist')
					.split(/[\s,]+/)
					.map((value) => value.trim())
					.filter(Boolean),
				breakGlassUserIds
			});
			return { success: 'Authentication policy saved.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	createScimToken: async ({ locals }) => {
		const principal = locals.principal!;
		try {
			const { token } = core.scim.create(principal);
			return {
				success: 'SCIM token created. Copy it now: it is not shown again.',
				scimToken: token
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	rotateScimToken: async ({ locals }) => {
		const principal = locals.principal!;
		try {
			const { token } = core.scim.rotate(principal);
			return {
				success: 'SCIM token rotated. The previous token stops working immediately.',
				scimToken: token
			};
		} catch (cause) {
			return failure(cause);
		}
	},

	revokeScimToken: async ({ request, locals }) => {
		const principal = locals.principal!;
		const id = formString(await request.formData(), 'tokenId');
		if (!id) return fail(400, { message: 'Missing token id.' });
		try {
			core.scim.revoke(principal, id);
			return { success: 'SCIM token revoked.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	saveGroupMapping: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			sso.saveGroupMapping(principal, {
				providerId: formString(data, 'providerId'),
				claimValue: formString(data, 'claimValue'),
				groupId: formString(data, 'groupId')
			});
			return { success: 'Group mapping saved.' };
		} catch (cause) {
			return failure(cause);
		}
	},

	removeGroupMapping: async ({ request, locals }) => {
		const principal = locals.principal!;
		const id = formString(await request.formData(), 'mappingId');
		if (!id) return fail(400, { message: 'Missing mapping id.' });
		try {
			sso.removeGroupMapping(principal, id);
			return { success: 'Group mapping removed.' };
		} catch (cause) {
			return failure(cause);
		}
	}
};
