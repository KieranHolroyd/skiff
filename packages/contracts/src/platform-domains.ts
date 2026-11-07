/**
 * Platform domains (D105): the dashboard host and the content domain sites are served under, and
 * whether they use HTTPS. One set of rules for the installer, the dashboard (Settings → Domains)
 * and the root helper that applies a change, so all three agree on what is valid and on exactly
 * which env keys a change writes.
 *
 * Domains are optional. Without them the dashboard is served at `http://<server-ip>` and sites at a
 * temporary wildcard address, `*.<ip-with-dashes>.sslip.io`, which public DNS resolves back to the
 * server's IP with no records to create. Either can be replaced later.
 */

/** Public wildcard DNS that resolves `anything.1-2-3-4.sslip.io` to 1.2.3.4. */
export const TEMPORARY_DOMAIN_SUFFIX = 'sslip.io';

/** Files the edge agent and Caddy read for DNS-01 (Cloudflare). */
export const CLOUDFLARE_TOKEN_FILE = '/etc/skiff/cloudflare.token';
/** The control plane's unix socket; the edge agent talks to it directly (no hairpin through Caddy). */
export const CONTROL_SOCKET = '/run/skiff/control.sock';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIpv4(value: string): boolean {
	return IPV4.test(value);
}

/** A DNS name with at least two labels (no IPs, no `localhost`). */
export function isDomainName(value: string): boolean {
	return DOMAIN.test(value) && !isIpv4(value);
}

/** `1.2.3.4` → `1-2-3-4.sslip.io`. */
export function temporaryContentDomain(ipv4: string): string {
	if (!isIpv4(ipv4)) throw new Error(`${ipv4} is not an IPv4 address`);
	return `${ipv4.replaceAll('.', '-')}.${TEMPORARY_DOMAIN_SUFFIX}`;
}

export function isTemporaryContentDomain(domain: string): boolean {
	return domain === TEMPORARY_DOMAIN_SUFFIX || domain.endsWith(`.${TEMPORARY_DOMAIN_SUFFIX}`);
}

export interface DomainSettings {
	/** Dashboard/API/MCP host: a domain, or the server's IPv4 address. */
	platformHost: string;
	/** Sites are served at `<slug>.<contentDomain>`. */
	contentDomain: string;
	/** HTTPS through Let's Encrypt. Needs domains (not an IP or a temporary domain) and DNS-01. */
	tls: boolean;
	/** Let's Encrypt account email; required with `tls`. */
	acmeEmail: string;
}

export type DomainSettingsField = keyof DomainSettings | 'cloudflareToken';

/**
 * Normalise and validate. `hasCloudflareToken` says whether a DNS-01 token is (or will be)
 * available: the wildcard `*.<contentDomain>` certificate can only be issued over DNS-01.
 */
export function validateDomainSettings(
	raw: { platformHost?: unknown; contentDomain?: unknown; tls?: unknown; acmeEmail?: unknown },
	hasCloudflareToken: boolean,
): { ok: true; value: DomainSettings } | { ok: false; field: DomainSettingsField; message: string } {
	const platformHost = typeof raw.platformHost === 'string' ? raw.platformHost.trim().toLowerCase().replace(/\.$/, '') : '';
	const contentDomain = typeof raw.contentDomain === 'string' ? raw.contentDomain.trim().toLowerCase().replace(/\.$/, '') : '';
	const tls = raw.tls === true;
	const acmeEmail = tls && typeof raw.acmeEmail === 'string' ? raw.acmeEmail.trim() : '';

	if (!platformHost) return { ok: false, field: 'platformHost', message: 'Enter a domain or the server’s IP address.' };
	if (!isDomainName(platformHost) && !isIpv4(platformHost))
		return { ok: false, field: 'platformHost', message: 'Use a domain like control.example.com, or an IPv4 address (no port or scheme).' };
	if (!contentDomain) return { ok: false, field: 'contentDomain', message: 'Enter a content domain.' };
	if (!isDomainName(contentDomain))
		return { ok: false, field: 'contentDomain', message: 'Use a domain like example.com (sites become <name>.example.com).' };
	if (platformHost === contentDomain)
		return { ok: false, field: 'contentDomain', message: 'Use a different domain from the dashboard.' };

	if (tls) {
		if (isIpv4(platformHost))
			return { ok: false, field: 'tls', message: 'HTTPS needs a domain for the dashboard; certificates are not issued for IP addresses.' };
		if (isTemporaryContentDomain(contentDomain) || isTemporaryContentDomain(platformHost))
			return { ok: false, field: 'tls', message: 'HTTPS needs your own domains; the temporary sslip.io address only works over HTTP.' };
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail))
			return { ok: false, field: 'acmeEmail', message: 'Let’s Encrypt needs a contact email.' };
		if (!hasCloudflareToken)
			return {
				ok: false,
				field: 'cloudflareToken',
				message: 'The wildcard certificate for sites needs a Cloudflare DNS token (Zone → DNS → Edit on the content domain).',
			};
	}
	return { ok: true, value: { platformHost, contentDomain, tls, acmeEmail } };
}

export function platformOriginFor(settings: Pick<DomainSettings, 'platformHost' | 'tls'>): string {
	return `${settings.tls ? 'https' : 'http'}://${settings.platformHost}`;
}

/** Read the current settings back from the control plane's env (`/etc/skiff/skiff.env`). */
export function domainSettingsFromEnv(env: { get(key: string): string | undefined }): DomainSettings {
	const origin = env.get('SKIFF_PLATFORM_ORIGIN') ?? '';
	let platformHost = '';
	let tls = false;
	try {
		const url = new URL(origin);
		platformHost = url.host;
		tls = url.protocol === 'https:';
	} catch {
		// Leave empty: validation reports it.
	}
	return {
		platformHost,
		contentDomain: env.get('SKIFF_CONTENT_DOMAIN') ?? '',
		tls,
		acmeEmail: tls ? (env.get('SKIFF_ACME_EMAIL') ?? '') : '',
	};
}

/** Env changes (`null` removes) for a set of files. */
export type EnvChanges = Record<string, string | null>;

/** `/etc/skiff/skiff.env` (control plane; the agent also loads it first). */
export function controlPlaneEnvChanges(settings: DomainSettings, tokenFile: string | null): EnvChanges {
	return {
		SKIFF_PLATFORM_ORIGIN: platformOriginFor(settings),
		SKIFF_CONTENT_DOMAIN: settings.contentDomain,
		SKIFF_ACME_EMAIL: settings.tls ? settings.acmeEmail : null,
		// The installer's name for the token file, kept so re-runs remember it.
		SKIFF_CLOUDFLARE_TOKEN_FILE: tokenFile,
	};
}

/** `/etc/skiff/agent.env` on the control-plane host (it overrides skiff.env for the edge agent). */
export function edgeAgentEnvChanges(settings: DomainSettings, tokenFile: string | null): EnvChanges {
	return {
		SKIFF_CONTROL_URL: platformOriginFor(settings),
		SKIFF_CONTROL_SOCKET: CONTROL_SOCKET,
		SKIFF_CONTENT_DOMAIN: settings.contentDomain,
		SKIFF_PLATFORM_HOST: settings.platformHost,
		SKIFF_ACME_EMAIL: settings.tls ? settings.acmeEmail : null,
		SKIFF_TLS: settings.tls ? '1' : '0',
		SKIFF_CLOUDFLARE_API_TOKEN_FILE: settings.tls ? tokenFile : null,
	};
}

/** Apply `changes` to an env map; returns the keys whose value changed. */
export function applyEnvChanges(env: Map<string, string>, changes: EnvChanges): string[] {
	const changed: string[] = [];
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) {
			if (env.delete(key)) changed.push(key);
		} else if (env.get(key) !== value) {
			env.set(key, value);
			changed.push(key);
		}
	}
	return changed;
}

/** Cloudflare API tokens are 40 URL-safe characters; accept a little slack, never whitespace. */
export function validCloudflareToken(token: string): boolean {
	return /^[A-Za-z0-9_-]{20,200}$/.test(token);
}

export interface CloudflareTokenPermission {
	/** Cloudflare's short permission-group key, e.g. `dns` or `zone`. */
	key: string;
	type: 'read' | 'edit';
}

/** What Skiff's DNS token needs: find the zone by name, then edit its records (DNS-01, app and email records). */
export const CLOUDFLARE_DNS_TOKEN_PERMISSIONS: readonly CloudflareTokenPermission[] = [
	{ key: 'zone', type: 'read' },
	{ key: 'dns', type: 'edit' },
];

export interface CloudflareTokenLinkOptions {
	/** Pre-filled token name. */
	name?: string;
	permissions?: readonly CloudflareTokenPermission[];
}

/**
 * Link to Cloudflare's "create API token" form with the name and permissions pre-filled
 * (Cloudflare "API token template URLs"). The user still picks the zone and confirms; the form
 * opens on all zones, so the UI should tell them to narrow it. Unknown keys are dropped by
 * Cloudflare without notice.
 */
export function cloudflareTokenCreateUrl(options: CloudflareTokenLinkOptions = {}): string {
	const permissions = options.permissions ?? CLOUDFLARE_DNS_TOKEN_PERMISSIONS;
	const params = new URLSearchParams({
		permissionGroupKeys: JSON.stringify(permissions.map(({ key, type }) => ({ key, type }))),
		accountId: '*',
		zoneId: 'all',
		name: options.name ?? 'Skiff DNS',
	});
	return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`;
}
