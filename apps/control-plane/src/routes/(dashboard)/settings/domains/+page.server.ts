import { existsSync } from 'node:fs';
import { fail, isActionFailure } from '@sveltejs/kit';
import {
	cloudflareTokenCreateUrl,
	domainSettingsFromEnv,
	isIpv4,
	isTemporaryContentDomain,
	platformOriginFor,
	temporaryContentDomain,
	validCloudflareToken,
	validateDomainSettings,
	type DomainSettings
} from '@yoal/contracts';
import { interfaceAddresses, probeDomains, primaryAddress, serverAddresses, type DnsProbe } from '#lib/server/dns-probe.js';
import { enforceOwnerSecondFactor, userHasTotp } from '#lib/server/second-factor.js';
import { configState, queueConfig, requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Domains (D105): the dashboard host, the content domain and HTTPS. The values come
 * from this process's environment (yoal.env as of the last restart); a change goes to the root
 * helper, which rewrites yoal.env and the edge agent's agent.env, restarts both and reverts if the
 * new address does not answer.
 */

const env = { get: (key: string) => process.env[key] };

function current(): DomainSettings {
	return domainSettingsFromEnv(env);
}

function cloudflareTokenSaved(): boolean {
	const file = process.env.YOAL_CLOUDFLARE_TOKEN_FILE;
	return Boolean(process.env.YOAL_CLOUDFLARE_API_TOKEN) || Boolean(file && existsSync(file));
}

/** Addresses from the interfaces alone (no DNS), for hints on page load. */
function localAddresses(platformHost: string): Set<string> {
	const known = new Set<string>();
	if (isIpv4(platformHost)) known.add(platformHost);
	for (const address of interfaceAddresses('IPv4')) known.add(address);
	return known;
}

export const load: PageServerLoad = ({ locals }) => {
	requireOwnerPage(locals);
	const settings = current();
	const address = primaryAddress(localAddresses(settings.platformHost));
	return {
		...configState(),
		current: {
			...settings,
			origin: platformOriginFor(settings),
			ipOnly: isIpv4(settings.platformHost),
			temporaryContent: isTemporaryContentDomain(settings.contentDomain)
		},
		cloudflareTokenSaved: cloudflareTokenSaved(),
		/** Cloudflare token form pre-filled with Zone Read + DNS Edit. */
		cloudflareTokenUrl: cloudflareTokenCreateUrl({
			name: isTemporaryContentDomain(settings.contentDomain) ? 'Yoal DNS' : `Yoal DNS (${settings.contentDomain})`
		}),
		/** Changing the dashboard host breaks passkeys (they are bound to it), so owners need TOTP first. */
		needsAuthenticator: enforceOwnerSecondFactor && !userHasTotp(locals.user!.id),
		serverAddress: address,
		temporaryDomain: address && isIpv4(address) ? temporaryContentDomain(address) : null
	};
};

function readForm(data: FormData) {
	const text = (key: string) => String(data.get(key) ?? '').trim();
	return {
		platformHost: text('platformHost'),
		contentDomain: text('contentDomain'),
		tls: data.get('tls') === 'on',
		acmeEmail: text('acmeEmail'),
		cloudflareToken: text('cloudflareToken'),
		confirmDns: data.get('confirmDns') === 'on'
	};
}

type Values = ReturnType<typeof readForm>;

/** Echo the form back without the token. */
function echo(values: Values) {
	const { cloudflareToken: _token, ...rest } = values;
	return rest;
}

function validate(values: Values) {
	if (values.cloudflareToken && !validCloudflareToken(values.cloudflareToken))
		return { ok: false as const, field: 'cloudflareToken', message: 'That doesn’t look like a Cloudflare API token.' };
	return validateDomainSettings(values, cloudflareTokenSaved() || Boolean(values.cloudflareToken));
}

async function dnsFor(settings: DomainSettings): Promise<{ platform: DnsProbe | null; content: DnsProbe; address: string | null }> {
	const known = await serverAddresses(current().platformHost);
	const result = await probeDomains(settings, known);
	return { ...result, address: primaryAddress(known) };
}

export const actions: Actions = {
	/** Look the proposed names up in public DNS, without changing anything. */
	check: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const values = readForm(await request.formData());
		const settings = validateDomainSettings(values, true);
		if (!settings.ok)
			return fail(400, { values: echo(values), fieldErrors: { [settings.field]: settings.message }, message: settings.message });
		return { values: echo(values), dns: await dnsFor(settings.value), checked: true };
	},

	save: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const values = readForm(await request.formData());
		const settings = validate(values);
		if (!settings.ok)
			return fail(400, { values: echo(values), fieldErrors: { [settings.field]: settings.message }, message: settings.message });
		const next = settings.value;
		const before = current();
		const hostChanges = next.platformHost !== before.platformHost || next.tls !== before.tls;

		if (hostChanges && enforceOwnerSecondFactor && !userHasTotp(locals.user!.id))
			return fail(400, {
				values: echo(values),
				message:
					'Set up an authenticator app first (Settings → Account). Passkeys only work on the address they were created on, so after the dashboard moves you would have no second factor to sign in with.'
			});

		const unchanged =
			!hostChanges && next.contentDomain === before.contentDomain && next.acmeEmail === before.acmeEmail && !values.cloudflareToken;
		if (unchanged) return fail(400, { values: echo(values), message: 'Nothing changed; these are the current domains.' });

		// The helper proves the new name works on this host; DNS is what decides whether anyone can
		// reach it. A dashboard name that doesn't resolve would leave you locked out.
		const dns = await dnsFor(next);
		if (dns.platform?.status === 'missing')
			return fail(400, {
				values: echo(values),
				dns,
				message: `${next.platformHost} does not resolve yet. Create an A record pointing at ${dns.address ?? 'this server'} first; otherwise nobody could reach the dashboard after the move.`
			});
		const doubtful =
			dns.platform?.status === 'elsewhere' || (dns.content.status !== 'here' && !isTemporaryContentDomain(next.contentDomain));
		if (doubtful && !values.confirmDns)
			return fail(400, {
				values: echo(values),
				dns,
				needsConfirm: true,
				message:
					dns.platform?.status === 'elsewhere'
						? `${next.platformHost} resolves to ${dns.platform.addresses.join(', ')}, not this server. That is fine behind a proxy (for example Cloudflare); confirm to continue.`
						: `*.${next.contentDomain} does not point at this server yet, so sites won’t load until it does. Confirm to continue anyway.`
			});

		const result = queueConfig(
			locals,
			{ action: 'domains', ...next, ...(values.cloudflareToken ? { cloudflareToken: values.cloudflareToken } : {}) },
			`Moving Yoal to ${platformOriginFor(next)}.`
		);
		if (isActionFailure(result)) return result;
		return { ...result, newOrigin: platformOriginFor(next), hostChanges };
	}
};
