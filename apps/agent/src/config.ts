import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Agent runtime configuration. Everything comes from the process environment so the compiled
 * binary can be dropped into a systemd unit with an EnvironmentFile (DESIGN §11).
 *
 * `skiff-agent join` writes `${dataDir}/node.json`; when the node id/token/control URL are not in
 * the environment, this loader falls back to that file so the unit only needs `SKIFF_DATA_DIR`.
 */

export interface AgentConfig {
	/** Control-plane origin, no trailing slash. */
	controlUrl: string;
	/** Bearer token issued by `skiff-agent join`. */
	nodeToken: string;
	/** Stable id of this node (`nod_…`). */
	nodeId: string;
	/** Root for cached state, releases and site symlinks. */
	dataDir: string;
	agentVersion: string;
	/** Caddy admin API socket. Caddy is never reachable over TCP (D7). */
	caddyAdminSocket: string;
	/** Public listeners Caddy should bind. */
	caddyListen: string[];
	/** Unix socket the agent serves forward_auth / metrics on. */
	agentSocket: string;
	/** Optional Caddy JSON access log to aggregate into telemetry. */
	caddyAccessLog: string | null;
	/** Host-only site session cookie name. */
	cookieName: string;
	/** Dev-only: emit non-Secure cookies and http return URLs. */
	insecureHttp: boolean;
	/** Terminate TLS in Caddy with ACME (DNS-01 when a Cloudflare token is present). */
	tls: boolean;
	/** ACME account email; required for TLS in production. */
	acmeEmail: string | null;
	/** Optional ACME directory override (e.g. Let's Encrypt staging). */
	acmeCa: string | null;
	/** Cloudflare API token used by Caddy's DNS-01 challenge provider. */
	cloudflareApiToken: string | null;
	/** Overrides the content domain from desired state. */
	contentDomain: string | null;
	/** Platform dashboard/API/MCP host served by Caddy (e.g. control.kieran.dev). */
	platformHost: string | null;
	/** Control-plane upstream, usually a unix socket. */
	platformUpstream: string;
	/**
	 * Where to read served TLS certificates for the expiry alert (DESIGN §8), or null when this
	 * node doesn't terminate TLS. Defaults to loopback on the first non-:80 Caddy listen port.
	 */
	certProbe: { host: string; port: number } | null;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

type Env = Record<string, string | undefined>;

interface NodeFile {
	controlUrl: string;
	nodeId: string;
	token: string;
}

function required(env: Env, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
	return value;
}

function optional(env: Env, name: string, fallback: string): string {
	const value = env[name]?.trim();
	return value ? value : fallback;
}

function optionalValue(env: Env, name: string): string | null {
	const value = env[name]?.trim();
	return value ? value : null;
}

function parseBooleanValue(value: string | undefined): boolean | undefined {
	if (value === undefined || value.trim() === '') return undefined;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	throw new ConfigError(`Invalid boolean value "${value}"`);
}

function parseBoolean(env: Env, name: string): boolean {
	return parseBooleanValue(env[name]) ?? false;
}

function parseListen(value: string): string[] {
	const listen = value
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (listen.length === 0) throw new ConfigError('SKIFF_CADDY_LISTEN must contain at least one address');
	for (const address of listen) {
		// Caddy accepts `:443`, `127.0.0.1:8080`, `unix/…`. Reject obvious typos early.
		if (!address.includes(':') && !address.startsWith('unix/'))
			throw new ConfigError(`Invalid Caddy listen address "${address}"`);
	}
	return listen;
}

/** `SKIFF_CERT_PROBE_ADDR` (`host:port`, or `off`), else loopback on the TLS listen port. */
export function parseCertProbe(
	value: string | undefined,
	listen: string[],
	tls: boolean,
): { host: string; port: number } | null {
	const raw = value?.trim();
	if (raw === 'off' || raw === '0' || raw === 'false') return null;
	const parse = (address: string) => {
		const index = address.lastIndexOf(':');
		if (index === -1) return null;
		const port = Number(address.slice(index + 1));
		if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
		const host = address.slice(0, index).replace(/^\[|\]$/g, '');
		return { host: host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host, port };
	};
	if (raw) {
		const probe = parse(raw);
		if (!probe) throw new ConfigError(`Invalid SKIFF_CERT_PROBE_ADDR "${raw}" (expected host:port or off)`);
		return probe;
	}
	if (!tls) return null;
	const address = listen.find((entry) => !entry.startsWith('unix/') && !entry.endsWith(':80'));
	return address ? parse(address) : null;
}

function parseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`SKIFF_CONTROL_URL is not a valid URL: ${value}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new ConfigError('SKIFF_CONTROL_URL must be http or https');
	return value.replace(/\/+$/, '');
}

function parseContentDomain(value: string | undefined): string | null {
	if (!value?.trim()) return null;
	const domain = value
		.trim()
		.toLowerCase()
		.replace(/^\.+/, '')
		.replace(/\.+$/, '');
	if (!domain || domain.includes('..') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain))
		throw new ConfigError(`Invalid content domain "${value}"`);
	return domain;
}

/** Read `${dataDir}/node.json` written by `skiff-agent join`. */
function readNodeFile(path: string): NodeFile | null {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (isNotFound(error)) return null;
		throw new ConfigError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new ConfigError(`${path} is not valid JSON`);
	}
	if (typeof value !== 'object' || value === null) throw new ConfigError(`${path} has an invalid shape`);
	const record = value as Record<string, unknown>;
	if (
		typeof record.controlUrl !== 'string' ||
		typeof record.nodeId !== 'string' ||
		typeof record.token !== 'string' ||
		!record.controlUrl ||
		!record.nodeId ||
		!record.token
	)
		throw new ConfigError(`${path} is missing controlUrl, nodeId or token`);
	return { controlUrl: record.controlUrl, nodeId: record.nodeId, token: record.token };
}

function readSecretFile(path: string | null): string | null {
	if (!path) return null;
	try {
		const value = readFileSync(path, 'utf8').trim();
		return value || null;
	} catch (error) {
		throw new ConfigError(
			`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export function loadConfig(env: Env = process.env): AgentConfig {
	const dataDir = optional(env, 'SKIFF_DATA_DIR', '/var/lib/skiff-agent').replace(/\/+$/, '') || '/';
	const envControlUrl = env.SKIFF_CONTROL_URL?.trim();
	const envNodeToken = env.SKIFF_NODE_TOKEN?.trim();
	const envNodeId = env.SKIFF_NODE_ID?.trim();

	// Only touch disk when at least one credential is missing, so a fully configured environment
	// does not depend on the node file at all.
	const nodeFile =
		envControlUrl && envNodeToken && envNodeId
			? null
			: readNodeFile(join(dataDir, 'node.json'));

	const controlUrl = parseUrl(envControlUrl || nodeFile?.controlUrl || required(env, 'SKIFF_CONTROL_URL'));
	const nodeToken = envNodeToken || nodeFile?.token || required(env, 'SKIFF_NODE_TOKEN');
	const nodeId = envNodeId || nodeFile?.nodeId || required(env, 'SKIFF_NODE_ID');

	const insecureHttp = parseBoolean(env, 'SKIFF_AGENT_INSECURE_HTTP');
	if (insecureHttp && env.NODE_ENV === 'production')
		throw new ConfigError('SKIFF_AGENT_INSECURE_HTTP must not be enabled in production');

	const acmeEmail = optionalValue(env, 'SKIFF_ACME_EMAIL');
	const tls = parseBooleanValue(env.SKIFF_TLS) ?? acmeEmail !== null;
	if (tls && env.NODE_ENV === 'production' && !acmeEmail)
		throw new ConfigError('SKIFF_ACME_EMAIL is required when SKIFF_TLS is enabled in production');

	const caddyAccessLog = env.SKIFF_CADDY_ACCESS_LOG?.trim();
	const caddyListen = parseListen(optional(env, 'SKIFF_CADDY_LISTEN', ':443,:80'));
	const cookieName = optional(env, 'SKIFF_SITE_COOKIE_COOKIE_NAME', '__skiff_s');
	if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(cookieName))
		throw new ConfigError('SKIFF_SITE_COOKIE_COOKIE_NAME is not a valid cookie name');

	return {
		controlUrl,
		nodeToken,
		nodeId,
		dataDir,
		agentVersion: optional(env, 'SKIFF_AGENT_VERSION', '0.1.0'),
		caddyAdminSocket: optional(env, 'SKIFF_CADDY_ADMIN_SOCKET', '/var/lib/caddy/admin.sock'),
		caddyListen,
		agentSocket: optional(env, 'SKIFF_AGENT_SOCKET', '/run/skiff-agent/agent.sock'),
		caddyAccessLog: caddyAccessLog ? caddyAccessLog : null,
		cookieName,
		insecureHttp,
		tls,
		acmeEmail,
		acmeCa: optionalValue(env, 'SKIFF_ACME_CA'),
		cloudflareApiToken:
			optionalValue(env, 'SKIFF_CLOUDFLARE_API_TOKEN') ??
			readSecretFile(optionalValue(env, 'SKIFF_CLOUDFLARE_API_TOKEN_FILE')),
		contentDomain: parseContentDomain(env.SKIFF_CONTENT_DOMAIN),
		platformHost: parseContentDomain(env.SKIFF_PLATFORM_HOST),
		platformUpstream: optional(env, 'SKIFF_PLATFORM_UPSTREAM', 'unix//run/skiff/control.sock'),
		certProbe: parseCertProbe(env.SKIFF_CERT_PROBE_ADDR, caddyListen, tls),
	};
}

function isNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
