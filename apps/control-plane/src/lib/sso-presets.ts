/**
 * Ready-made OIDC set-ups for the larger identity providers (IAM.md §8.3, D180).
 *
 * A preset turns the one or two values an admin can copy from their IdP (a tenant id, an Okta
 * domain, a Keycloak realm) into everything Settings → SSO otherwise asks for: the exact issuer,
 * the discovery URL, the scopes that IdP accepts and the claims it puts the email, name and groups
 * in. It also carries the console steps to create the client, so nobody has to know that Entra
 * needs an optional `email` claim or that Okta's custom authorization servers reject `groups`.
 *
 * The module is pure and shared: the dialog previews the issuer with it as you type, and the form
 * action and `POST /api/v1/sso/providers` resolve the preset again on the server, so the preview is
 * never what gets trusted. The resolved issuer is still checked against the IdP's discovery
 * document at save time (`sso.ts`), which is what catches a wrong tenant id.
 *
 * Issuers are written exactly as each IdP publishes them, trailing slash included (Auth0,
 * JumpCloud, authentik): Better Auth compares an ID token's `iss` to the stored issuer byte for
 * byte.
 */

export type SsoPresetId =
	| 'entra'
	| 'google'
	| 'okta'
	| 'auth0'
	| 'onelogin'
	| 'jumpcloud'
	| 'pingone'
	| 'keycloak'
	| 'authentik'
	| 'gitlab'
	| 'gitea'
	| 'forgejo';

export interface SsoPresetClaims {
	email: string;
	name: string;
	groups: string;
}

export interface SsoPresetField {
	key: string;
	label: string;
	placeholder: string;
	description: string;
	/** Present for a choice rather than a text box; the first option is the default. */
	options?: readonly { value: string; label: string }[];
	/** Blank is allowed (it then means the documented default). */
	optional?: boolean;
}

/** What a preset resolves to: the same fields the custom OIDC form takes. */
export interface SsoPresetConfig {
	issuer: string;
	discoveryUrl: string | null;
	scopes: string[];
	claims: SsoPresetClaims;
}

export interface SsoPreset {
	id: SsoPresetId;
	/** Product name, also the default provider name. */
	name: string;
	/** One line for the picker. */
	summary: string;
	fields: readonly SsoPresetField[];
	/** Numbered steps at the IdP, in its own wording. The redirect URI is shown beside them. */
	steps: readonly string[];
	/** How (or whether) groups reach Skiff from this IdP. */
	groups: string;
	/** Where the steps start, when it can be worked out from the values. */
	consoleUrl(values: SsoPresetValues): string | null;
	/** Build the configuration, or throw `SsoPresetError` naming the field that is wrong. */
	resolve(values: SsoPresetValues): SsoPresetConfig;
	/** The values that would produce this issuer, so an existing provider reopens in its preset. */
	match(issuer: string): SsoPresetValues | null;
}

export type SsoPresetValues = Readonly<Record<string, string>>;

/** A preset value that cannot produce an issuer. `field` is the key to highlight. */
export class SsoPresetError extends Error {
	constructor(
		message: string,
		readonly field: string | null = null
	) {
		super(message);
		this.name = 'SsoPresetError';
	}
}

const BASE_SCOPES = ['openid', 'profile', 'email'];
const STANDARD_CLAIMS: SsoPresetClaims = { email: 'email', name: 'name', groups: 'groups' };
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HOST = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+(?::\d{1,5})?$/;
/** Okta's own hostnames; a custom domain is accepted too but cannot be mapped to its admin URL. */
const OKTA_HOST = /^([a-z0-9-]+?)(-admin)?\.(okta|oktapreview|okta-emea|okta-gov|okta-mil)\.com$/;

function value(values: SsoPresetValues, key: string): string {
	return (values[key] ?? '').trim();
}

function required(values: SsoPresetValues, key: string, label: string): string {
	const raw = value(values, key);
	if (!raw) throw new SsoPresetError(`Enter the ${label}.`, key);
	return raw;
}

/** Parse something an admin pasted (a bare host, a URL, a URL with a path) as a URL. */
function looseUrl(raw: string): URL | null {
	const text = raw.trim();
	if (!text) return null;
	try {
		return new URL(text.includes('://') ? text : `https://${text}`);
	} catch {
		return null;
	}
}

/** The lowercased host (with any port) of a pasted host or URL, or null when it is not one. */
function hostOf(raw: string): string | null {
	const url = looseUrl(raw);
	if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
	const host = url.host.toLowerCase();
	return HOST.test(host) || url.hostname === 'localhost' ? host : null;
}

/**
 * The origin plus any base path of a self-hosted server (Keycloak behind `/auth`, authentik behind
 * a sub-path), without a trailing slash. The scheme the admin typed is kept, so a loopback test
 * server on http still works; `sso.ts` refuses http anywhere else.
 */
function baseOf(raw: string): string | null {
	const url = looseUrl(raw);
	if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
	const host = url.host.toLowerCase();
	if (!HOST.test(host) && url.hostname !== 'localhost') return null;
	return `${url.protocol}//${host}${url.pathname.replace(/\/+$/, '')}`;
}

function guid(raw: string): string | null {
	return raw.match(GUID)?.[0].toLowerCase() ?? null;
}

function slugOf(raw: string, pattern: RegExp): string | null {
	const text = raw.trim();
	return pattern.test(text) ? text : null;
}

function issuerUrl(issuer: string): URL | null {
	try {
		return new URL(issuer);
	} catch {
		return null;
	}
}

const entra: SsoPreset = {
	id: 'entra',
	name: 'Microsoft Entra ID',
	summary: 'Azure AD / Microsoft 365 work accounts.',
	fields: [
		{
			key: 'tenantId',
			label: 'Directory (tenant) ID',
			placeholder: '00000000-0000-0000-0000-000000000000',
			description:
				'On the app registration’s Overview page. A tenant domain such as contoso.onmicrosoft.com will not work: Entra issues tokens under the id.'
		}
	],
	steps: [
		'In the Microsoft Entra admin center, open Identity → Applications → App registrations and choose New registration.',
		'Name it Skiff, choose “Accounts in this organizational directory only”, and add a Web redirect URI with the value shown here.',
		'Under Certificates & secrets, create a client secret and copy its Value (not the Secret ID).',
		'Under Token configuration, add an optional claim of type ID: email. To map groups later, also choose Add groups claim → Security groups.',
		'Copy the Application (client) ID and the Directory (tenant) ID from the Overview page.'
	],
	groups:
		'Entra sends group object ids in `groups` once “Add groups claim” is set. Users in more than 200 groups get an overage claim instead.',
	consoleUrl: () =>
		'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
	resolve(values) {
		const raw = required(values, 'tenantId', 'directory (tenant) ID');
		const tenant = guid(raw);
		if (!tenant)
			throw new SsoPresetError(
				'The tenant ID is a GUID like 72f988bf-86f1-41af-91ab-2d7cd011db47, from the app’s Overview page.',
				'tenantId'
			);
		const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
		return {
			issuer,
			discoveryUrl: `${issuer}/.well-known/openid-configuration`,
			scopes: [...BASE_SCOPES],
			claims: { ...STANDARD_CLAIMS }
		};
	},
	match(issuer) {
		const found = issuer.match(/^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0\/?$/i);
		return found ? { tenantId: found[1]!.toLowerCase() } : null;
	}
};

const google: SsoPreset = {
	id: 'google',
	name: 'Google Workspace',
	summary: 'Google accounts on your Workspace domain.',
	fields: [],
	steps: [
		'In Google Cloud console, pick (or create) a project in your Workspace organisation.',
		'Under APIs & Services → OAuth consent screen (Google Auth Platform → Audience), set the user type to Internal so only your Workspace accounts can sign in.',
		'Under Credentials, choose Create credentials → OAuth client ID → Web application.',
		'Add the redirect URI shown here under Authorized redirect URIs, then create the client.',
		'Copy the client ID and client secret.'
	],
	groups:
		'Google does not put groups in ID tokens, so group mapping will not apply. Roles come from the default SSO role instead.',
	consoleUrl: () => 'https://console.cloud.google.com/apis/credentials',
	resolve: () => ({
		issuer: 'https://accounts.google.com',
		discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
		scopes: [...BASE_SCOPES],
		claims: { ...STANDARD_CLAIMS }
	}),
	match: (issuer) => (/^https:\/\/accounts\.google\.com\/?$/.test(issuer) ? {} : null)
};

/** Okta: `acme.okta.com`, `acme-admin.okta.com`, a custom domain, or a pasted issuer URL. */
function oktaParts(values: SsoPresetValues): { host: string; server: string } {
	const raw = required(values, 'domain', 'Okta domain');
	const url = looseUrl(raw);
	let host = hostOf(raw);
	if (!host || !url) throw new SsoPresetError('Enter your Okta domain, for example acme.okta.com.', 'domain');
	const okta = host.match(OKTA_HOST);
	if (okta) host = `${okta[1]}.${okta[3]}.com`; // the admin console host is not the issuer
	const pasted = url.pathname.match(/^\/oauth2\/([^/]+)/)?.[1];
	const server = value(values, 'authServer') || pasted || '';
	if (server && !/^[A-Za-z0-9_-]{1,64}$/.test(server))
		throw new SsoPresetError('The authorization server id is a short id such as default.', 'authServer');
	return { host, server };
}

const okta: SsoPreset = {
	id: 'okta',
	name: 'Okta',
	summary: 'Okta Workforce Identity.',
	fields: [
		{
			key: 'domain',
			label: 'Okta domain',
			placeholder: 'acme.okta.com',
			description:
				'Your org’s Okta URL or custom domain. Pasting the admin console URL works too.'
		},
		{
			key: 'authServer',
			label: 'Authorization server',
			placeholder: 'Org authorization server',
			description:
				'Leave blank for the org authorization server, which can send groups. Enter an id such as default only if you use a custom one.',
			optional: true
		}
	],
	steps: [
		'In the Okta Admin Console, open Applications → Applications and choose Create App Integration.',
		'Choose OIDC – OpenID Connect, then Web Application.',
		'Name it Skiff, keep the Authorization Code grant, and set the Sign-in redirect URI to the value shown here.',
		'Under Assignments, give access to the people or groups who should use Skiff.',
		'To map groups later, on the Sign On tab edit OpenID Connect ID Token and set Groups claim filter to groups, Matches regex, .*',
		'Copy the client ID and client secret from the General tab.'
	],
	groups:
		'With the org authorization server and a groups claim filter, Okta sends group names in `groups`.',
	consoleUrl(values) {
		try {
			const { host } = oktaParts(values);
			const okta = host.match(OKTA_HOST);
			return okta ? `https://${okta[1]}-admin.${okta[3]}.com/admin/apps/active` : null;
		} catch {
			return null;
		}
	},
	resolve(values) {
		const { host, server } = oktaParts(values);
		const issuer = server ? `https://${host}/oauth2/${server}` : `https://${host}`;
		return {
			issuer,
			discoveryUrl: `${issuer}/.well-known/openid-configuration`,
			// Only the org authorization server knows the `groups` scope; a custom server rejects it.
			scopes: server ? [...BASE_SCOPES] : [...BASE_SCOPES, 'groups'],
			claims: { ...STANDARD_CLAIMS }
		};
	},
	match(issuer) {
		const url = issuerUrl(issuer);
		if (!url || url.protocol !== 'https:' || !OKTA_HOST.test(url.host)) return null;
		const server = url.pathname.match(/^\/oauth2\/([^/]+)\/?$/)?.[1];
		if (!server && url.pathname.replace(/\/+$/, '') !== '') return null;
		return { domain: url.host, authServer: server ?? '' };
	}
};

const auth0: SsoPreset = {
	id: 'auth0',
	name: 'Auth0',
	summary: 'An Auth0 tenant or its custom domain.',
	fields: [
		{
			key: 'domain',
			label: 'Auth0 domain',
			placeholder: 'acme.us.auth0.com',
			description:
				'The Domain on the application’s Settings tab, or your custom domain if sign-ins use it.'
		}
	],
	steps: [
		'In the Auth0 Dashboard, open Applications → Applications and choose Create Application.',
		'Name it Skiff and choose Regular Web Applications.',
		'On the Settings tab, add the redirect URI shown here to Allowed Callback URLs and save.',
		'Copy the Domain, Client ID and Client Secret from the same tab.'
	],
	groups:
		'Auth0 has no groups claim of its own. A post-login Action can add one; set the groups claim below to its name (for example https://skiff/groups).',
	consoleUrl: () => 'https://manage.auth0.com/',
	resolve(values) {
		const host = hostOf(required(values, 'domain', 'Auth0 domain'));
		if (!host) throw new SsoPresetError('Enter the Auth0 domain, for example acme.us.auth0.com.', 'domain');
		// Auth0 publishes its issuer with a trailing slash, and its tokens carry it.
		const issuer = `https://${host}/`;
		return {
			issuer,
			discoveryUrl: `https://${host}/.well-known/openid-configuration`,
			scopes: [...BASE_SCOPES],
			claims: { ...STANDARD_CLAIMS }
		};
	},
	match(issuer) {
		const url = issuerUrl(issuer);
		if (!url || url.protocol !== 'https:' || !/\.auth0\.com$/.test(url.host) || url.pathname !== '/')
			return null;
		return { domain: url.host };
	}
};

const onelogin: SsoPreset = {
	id: 'onelogin',
	name: 'OneLogin',
	summary: 'OneLogin by One Identity.',
	fields: [
		{
			key: 'subdomain',
			label: 'OneLogin subdomain',
			placeholder: 'acme',
			description: 'The part before .onelogin.com in your admin URL.'
		}
	],
	steps: [
		'In OneLogin Administration, open Applications → Applications and choose Add App.',
		'Search for “OpenId Connect (OIDC)”, pick it and name it Skiff.',
		'On the Configuration tab, add the redirect URI shown here to Redirect URI’s.',
		'On the SSO tab, set Application Type to Web and Token Endpoint Authentication Method to Basic, then copy the Client ID and Client Secret.',
		'Under Access (or Users), grant the app to the roles or users who should sign in.'
	],
	groups:
		'OneLogin sends the user’s groups in `groups` when the Groups parameter is configured on the app.',
	consoleUrl(values) {
		const sub = value(values, 'subdomain').match(/^([a-z0-9-]+)/i)?.[1];
		return sub ? `https://${sub.toLowerCase()}.onelogin.com/apps` : null;
	},
	resolve(values) {
		const raw = required(values, 'subdomain', 'OneLogin subdomain').toLowerCase();
		const host = hostOf(raw);
		const sub = host?.endsWith('.onelogin.com')
			? host.slice(0, -'.onelogin.com'.length)
			: slugOf(raw, /^[a-z0-9-]{1,63}$/);
		if (!sub || sub.includes('.'))
			throw new SsoPresetError('Enter just the subdomain, for example acme for acme.onelogin.com.', 'subdomain');
		const issuer = `https://${sub}.onelogin.com/oidc/2`;
		return {
			issuer,
			discoveryUrl: `${issuer}/.well-known/openid-configuration`,
			scopes: [...BASE_SCOPES, 'groups'],
			claims: { ...STANDARD_CLAIMS }
		};
	},
	match(issuer) {
		const found = issuer.match(/^https:\/\/([a-z0-9-]+)\.onelogin\.com\/oidc\/2\/?$/);
		return found ? { subdomain: found[1]! } : null;
	}
};

const jumpcloud: SsoPreset = {
	id: 'jumpcloud',
	name: 'JumpCloud',
	summary: 'JumpCloud SSO applications.',
	fields: [],
	steps: [
		'In the JumpCloud Admin Portal, open SSO Applications and choose Add New Application → Custom Application.',
		'Choose Manage Single Sign-On (SSO) → Configure SSO with OIDC, and name it Skiff.',
		'On the SSO tab, add the redirect URI shown here to Redirect URIs, set Client Authentication Type to Client Secret Basic, and set the Login URL to this dashboard’s address.',
		'Under Attribute Mapping, keep the email and profile scopes. To map groups later, include the group attribute and name it groups.',
		'Activate the app, copy the Client ID and Client Secret it shows once, and bind it to user groups on the User Groups tab.'
	],
	groups: 'JumpCloud sends group names when the group attribute is included; name it `groups`.',
	consoleUrl: () => 'https://console.jumpcloud.com/#/sso',
	resolve: () => ({
		issuer: 'https://oauth.id.jumpcloud.com/',
		discoveryUrl: 'https://oauth.id.jumpcloud.com/.well-known/openid-configuration',
		scopes: [...BASE_SCOPES],
		claims: { ...STANDARD_CLAIMS }
	}),
	match: (issuer) => (/^https:\/\/oauth\.id\.jumpcloud\.com\/?$/.test(issuer) ? {} : null)
};

const PINGONE_REGIONS = [
	{ value: 'com', label: 'North America (auth.pingone.com)' },
	{ value: 'eu', label: 'Europe (auth.pingone.eu)' },
	{ value: 'ca', label: 'Canada (auth.pingone.ca)' },
	{ value: 'asia', label: 'Asia-Pacific (auth.pingone.asia)' },
	{ value: 'com.au', label: 'Australia (auth.pingone.com.au)' }
] as const;

function pingoneParts(values: SsoPresetValues): { region: string; env: string } {
	const raw = required(values, 'environmentId', 'environment ID');
	const env = guid(raw);
	if (!env)
		throw new SsoPresetError(
			'The environment ID is a GUID, shown under Environment → Properties.',
			'environmentId'
		);
	// A pasted issuer or console URL carries its region; it wins over the select.
	const pastedRegion = hostOf(raw)?.match(/^(?:auth|console|apps)\.pingone\.(.+)$/)?.[1];
	const region = pastedRegion || value(values, 'region') || 'com';
	if (!PINGONE_REGIONS.some((option) => option.value === region))
		throw new SsoPresetError('Choose the region your PingOne environment is in.', 'region');
	return { region, env };
}

const pingone: SsoPreset = {
	id: 'pingone',
	name: 'PingOne',
	summary: 'Ping Identity’s PingOne cloud.',
	fields: [
		{
			key: 'region',
			label: 'Region',
			placeholder: '',
			description: 'Where the environment is hosted: the domain in your PingOne console URL.',
			options: PINGONE_REGIONS
		},
		{
			key: 'environmentId',
			label: 'Environment ID',
			placeholder: '00000000-0000-0000-0000-000000000000',
			description: 'Under Environment → Properties, or in the console URL.'
		}
	],
	steps: [
		'In the PingOne admin console, open Applications → Applications and add an application of type OIDC Web App named Skiff.',
		'On the Configuration tab, add the redirect URI shown here to Redirect URIs and set Token Endpoint Authentication Method to Client Secret Basic.',
		'On the Resources tab, allow the openid, profile and email scopes.',
		'To map groups later, on Attribute Mappings add groups mapped to Group Names.',
		'Turn the application on, then copy the Client ID and Client Secret from the Configuration tab.'
	],
	groups: 'PingOne sends group names in `groups` once that attribute mapping is added.',
	consoleUrl(values) {
		try {
			const { region, env } = pingoneParts(values);
			return `https://console.pingone.${region}/?env=${env}`;
		} catch {
			return null;
		}
	},
	resolve(values) {
		const { region, env } = pingoneParts(values);
		const issuer = `https://auth.pingone.${region}/${env}/as`;
		return {
			issuer,
			discoveryUrl: `${issuer}/.well-known/openid-configuration`,
			scopes: [...BASE_SCOPES],
			claims: { ...STANDARD_CLAIMS }
		};
	},
	match(issuer) {
		const found = issuer.match(/^https:\/\/auth\.pingone\.([a-z.]+)\/([0-9a-f-]{36})\/as\/?$/i);
		return found ? { region: found[1]!.toLowerCase(), environmentId: found[2]!.toLowerCase() } : null;
	}
};

function keycloakParts(values: SsoPresetValues): { base: string; realm: string } {
	const raw = required(values, 'serverUrl', 'Keycloak URL');
	const pasted = raw.match(/^(.*?)\/realms\/([^/?#]+)/);
	const base = baseOf(pasted ? pasted[1]! : raw);
	if (!base) throw new SsoPresetError('Enter the Keycloak URL, for example https://sso.example.com.', 'serverUrl');
	const realm = value(values, 'realm') || (pasted ? decodeURIComponent(pasted[2]!) : '');
	if (!realm) throw new SsoPresetError('Enter the realm name.', 'realm');
	if (realm.length > 100 || /[/?#]/.test(realm))
		throw new SsoPresetError('The realm is its name as shown in the realm list, without slashes.', 'realm');
	return { base, realm };
}

const keycloak: SsoPreset = {
	id: 'keycloak',
	name: 'Keycloak',
	summary: 'Keycloak or Red Hat build of Keycloak.',
	fields: [
		{
			key: 'serverUrl',
			label: 'Keycloak URL',
			placeholder: 'https://sso.example.com',
			description:
				'The server’s address. Include /auth for Keycloak 16 and older. Pasting a realm URL fills the realm too.'
		},
		{
			key: 'realm',
			label: 'Realm',
			placeholder: 'acme',
			description: 'The realm your users are in, not master unless you mean it.'
		}
	],
	steps: [
		'In the Keycloak admin console, switch to your realm and open Clients → Create client.',
		'Keep OpenID Connect, set the client ID to skiff, and turn Client authentication on with the Standard flow.',
		'Add the redirect URI shown here to Valid redirect URIs and save.',
		'Copy the client secret from the Credentials tab.',
		'To map groups later, open Client scopes → skiff-dedicated → Add mapper → By configuration → Group Membership, with Token Claim Name groups and Full group path off.'
	],
	groups: 'Keycloak sends group names in `groups` once a Group Membership mapper is added.',
	consoleUrl(values) {
		try {
			const { base, realm } = keycloakParts(values);
			return `${base}/admin/master/console/#/${encodeURIComponent(realm)}/clients`;
		} catch {
			return null;
		}
	},
	resolve(values) {
		const { base, realm } = keycloakParts(values);
		const issuer = `${base}/realms/${encodeURIComponent(realm)}`;
		return {
			issuer,
			discoveryUrl: `${issuer}/.well-known/openid-configuration`,
			scopes: [...BASE_SCOPES],
			claims: { ...STANDARD_CLAIMS }
		};
	},
	match(issuer) {
		const found = issuer.match(/^(https?:\/\/.+?)\/realms\/([^/]+)\/?$/);
		return found ? { serverUrl: found[1]!, realm: decodeURIComponent(found[2]!) } : null;
	}
};

function authentikParts(values: SsoPresetValues): { base: string; slug: string } {
	const raw = required(values, 'serverUrl', 'authentik URL');
	const pasted = raw.match(/^(.*?)\/application\/o\/([^/?#]+)/);
	const base = baseOf(pasted ? pasted[1]! : raw);
	if (!base)
		throw new SsoPresetError('Enter the authentik URL, for example https://auth.example.com.', 'serverUrl');
	const slug = value(values, 'slug') || (pasted ? pasted[2]! : '');
	if (!slug) throw new SsoPresetError('Enter the application slug.', 'slug');
	if (!/^[a-z0-9_-]{1,100}$/.test(slug))
		throw new SsoPresetError('The slug is lowercase letters, numbers, hyphens and underscores.', 'slug');
	return { base, slug };
}

const authentik: SsoPreset = {
	id: 'authentik',
	name: 'authentik',
	summary: 'Self-hosted authentik.',
	fields: [
		{
			key: 'serverUrl',
			label: 'authentik URL',
			placeholder: 'https://auth.example.com',
			description: 'The server’s address. Pasting the provider’s OpenID Configuration Issuer fills the slug too.'
		},
		{
			key: 'slug',
			label: 'Application slug',
			placeholder: 'skiff',
			description: 'The slug of the application you create for Skiff.'
		}
	],
	steps: [
		'In the authentik admin interface, open Applications → Applications and choose Create with Provider (or Create with Wizard).',
		'Name the application Skiff with slug skiff, and pick OAuth2/OpenID Provider.',
		'Set Client type to Confidential and add the redirect URI shown here as a Strict redirect URI.',
		'Finish, then copy the Client ID and Client Secret from the provider.',
		'Bind the application to the users or groups who should sign in, if it should not be open to everyone.'
	],
	groups: 'authentik’s default profile scope already sends group names in `groups`.',
	consoleUrl(values) {
		try {
			return `${authentikParts(values).base}/if/admin/#/core/applications`;
		} catch {
			return null;
		}
	},
	resolve(values) {
		const { base, slug } = authentikParts(values);
		// authentik's issuer ends in a slash and its tokens carry it.
		const issuer = `${base}/application/o/${slug}/`;
		return {
			issuer,
			discoveryUrl: `${issuer}.well-known/openid-configuration`,
			scopes: [...BASE_SCOPES],
			claims: { ...STANDARD_CLAIMS }
		};
	},
	match(issuer) {
		const found = issuer.match(/^(https?:\/\/.+?)\/application\/o\/([a-z0-9_-]+)\/?$/);
		return found ? { serverUrl: found[1]!, slug: found[2]! } : null;
	}
};

/**
 * GitLab, Gitea and Forgejo are OpenID Connect providers too (docs/FORGES.md §8). GitLab publishes
 * its issuer without a trailing slash; Gitea and Forgejo publish their `ROOT_URL`, which has one.
 */
function forgePreset(id: 'gitlab' | 'gitea' | 'forgejo'): SsoPreset {
	const name = id === 'gitlab' ? 'GitLab' : id === 'gitea' ? 'Gitea' : 'Forgejo';
	const example = id === 'gitlab' ? 'https://gitlab.com' : id === 'forgejo' ? 'https://codeberg.org' : 'https://gitea.example.com';
	const trailing = id === 'gitlab' ? '' : '/';
	const base = (values: SsoPresetValues) => {
		const found = baseOf(required(values, 'serverUrl', `${name} URL`));
		if (!found) throw new SsoPresetError(`Enter the ${name} URL, for example ${example}.`, 'serverUrl');
		return found;
	};
	return {
		id,
		name,
		summary: id === 'gitlab' ? 'gitlab.com or a self-managed GitLab.' : `${id === 'forgejo' ? 'Codeberg or a self-hosted Forgejo' : 'A self-hosted Gitea'}.`,
		fields: [{ key: 'serverUrl', label: `${name} URL`, placeholder: example, description: `The instance’s address${id === 'gitlab' ? '' : ' (its ROOT_URL)'}.` }],
		steps:
			id === 'gitlab'
				? [
						'In GitLab, open your group (or Admin → Applications on a self-managed instance) → Settings → Applications → Add new application.',
						'Name it Skiff, paste the redirect URI shown here, keep Confidential on and tick the openid, profile and email scopes.',
						'Save, then copy the Application ID (client id) and Secret.'
					]
				: [
						`In ${name}, open Settings → Applications (or Site administration → Integrations → Applications for an instance-wide app).`,
						'Create an OAuth2 application named Skiff with the redirect URI shown here, keeping Confidential client on.',
						'Copy the client ID and client secret.'
					],
		groups:
			id === 'gitlab'
				? 'GitLab sends the user’s groups in `groups` on the userinfo endpoint.'
				: `${name} sends organisation and team names in \`groups\` when the groups scope is requested.`,
		consoleUrl(values) {
			try {
				return `${base(values)}${id === 'gitlab' ? '/-/user_settings/applications' : '/user/settings/applications'}`;
			} catch {
				return null;
			}
		},
		resolve(values) {
			const root = base(values);
			return {
				issuer: `${root}${trailing}`,
				discoveryUrl: `${root}/.well-known/openid-configuration`,
				scopes: id === 'gitlab' ? [...BASE_SCOPES] : [...BASE_SCOPES, 'groups'],
				claims: { ...STANDARD_CLAIMS }
			};
		},
		match(issuer) {
			// Any issuer could be a forge, so only the well-known hosts (and hosts named after the
			// product) reopen in this preset; the rest reopen as custom OIDC.
			if (id === 'gitlab' ? issuer.endsWith('/') : !issuer.endsWith('/')) return null;
			const url = issuerUrl(issuer);
			if (!url || (url.pathname !== '/' && url.pathname !== '')) return null;
			const host = url.hostname;
			const known =
				id === 'gitlab'
					? host === 'gitlab.com' || host.startsWith('gitlab.')
					: id === 'forgejo'
						? host === 'codeberg.org' || host.startsWith('forgejo.')
						: host === 'gitea.com' || host.startsWith('gitea.');
			return known ? { serverUrl: `${url.protocol}//${url.host}` } : null;
		}
	};
}

const gitlabPreset = forgePreset('gitlab');
const giteaPreset = forgePreset('gitea');
const forgejoPreset = forgePreset('forgejo');

/** Most-used first; the picker shows them in this order, then "Other OpenID Connect". */
export const SSO_PRESETS: readonly SsoPreset[] = [
	entra,
	google,
	okta,
	auth0,
	onelogin,
	jumpcloud,
	pingone,
	keycloak,
	authentik,
	gitlabPreset,
	forgejoPreset,
	giteaPreset
];

export const SSO_PRESET_IDS = SSO_PRESETS.map((preset) => preset.id) as [SsoPresetId, ...SsoPresetId[]];

export function ssoPreset(id: string): SsoPreset | null {
	return SSO_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Resolve a preset by id. Throws `SsoPresetError` for an unknown id or a bad value. */
export function resolveSsoPreset(id: string, values: SsoPresetValues = {}): SsoPresetConfig {
	const preset = ssoPreset(id);
	if (!preset) throw new SsoPresetError(`There is no ${id} preset.`);
	return preset.resolve(values);
}

/**
 * Which preset an existing issuer came from, with the values that rebuild it. An Okta or Auth0
 * custom domain is not recognisable from the issuer alone and reads as a custom provider.
 */
export function detectSsoPreset(issuer: string): { preset: SsoPreset; values: SsoPresetValues } | null {
	for (const preset of SSO_PRESETS) {
		const values = preset.match(issuer);
		if (values) return { preset, values };
	}
	return null;
}

/** The preset catalogue without its functions, for `GET /api/v1/sso/presets` and agents. */
export function describeSsoPresets() {
	return SSO_PRESETS.map((preset) => ({
		id: preset.id,
		name: preset.name,
		summary: preset.summary,
		fields: preset.fields.map((field) => ({
			key: field.key,
			label: field.label,
			description: field.description,
			optional: field.optional === true || field.options !== undefined,
			...(field.options ? { options: field.options.map((option) => option.value) } : {})
		})),
		steps: preset.steps,
		groups: preset.groups
	}));
}
