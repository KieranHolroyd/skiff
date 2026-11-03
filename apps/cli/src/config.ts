/**
 * Persistent CLI settings live in `~/.config/skiff/config.json` (or
 * `$SKIFF_CONFIG_DIR` / `$XDG_CONFIG_HOME/skiff/config.json`), mode 0600.
 *
 * The file holds both credentials (`token`) and non-secret settings (`url`,
 * `contentDomain`). Logging out removes only the token, so the control-plane
 * URL and the domain deployed sites use survive across logins. `SKIFF_URL`,
 * `SKIFF_TOKEN` and `SKIFF_CONTENT_DOMAIN` override stored values, which keeps
 * CI and agent use stateless.
 */
import { chmod, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigError } from './errors.ts';

export const CONFIG_ENV_DIR = 'SKIFF_CONFIG_DIR';
export const URL_ENV = 'SKIFF_URL';
export const TOKEN_ENV = 'SKIFF_TOKEN';
export const CONTENT_DOMAIN_ENV = 'SKIFF_CONTENT_DOMAIN';

export type ConfigKey = 'url' | 'contentDomain' | 'token';

export interface ConfigKeyInfo {
	/** Canonical key name used in the config file and `skif config` output. */
	key: ConfigKey;
	description: string;
	secret: boolean;
	env?: string;
}

export const CONFIG_KEYS: Record<ConfigKey, ConfigKeyInfo> = {
	url: {
		key: 'url',
		description: 'Control-plane URL, e.g. https://control.kieran.dev',
		secret: false,
		env: URL_ENV,
	},
	contentDomain: {
		key: 'contentDomain',
		description: 'Domain deployed sites are served from, e.g. kierancloud.dev',
		secret: false,
		env: CONTENT_DOMAIN_ENV,
	},
	token: {
		key: 'token',
		description: 'API key. Prefer `skif login`, which verifies it.',
		secret: true,
		env: TOKEN_ENV,
	},
};

/** Friendly aliases so `skif config set content-domain …` works as expected. */
const KEY_ALIASES: Record<string, ConfigKey> = {
	url: 'url',
	'platform-url': 'url',
	platform: 'url',
	control: 'url',
	'control-url': 'url',
	controlurl: 'url',
	platformurl: 'url',
	'content-domain': 'contentDomain',
	contentdomain: 'contentDomain',
	content: 'contentDomain',
	domains: 'contentDomain',
	'sites-domain': 'contentDomain',
	'deployments-domain': 'contentDomain',
	token: 'token',
	'api-key': 'token',
	apikey: 'token',
};

export function canonicalConfigKey(raw: string): ConfigKey {
	const normalized = raw.trim().toLowerCase();
	const key = KEY_ALIASES[normalized];
	if (!key)
		throw new ConfigError(
			`Unknown setting "${raw}". Use one of: ${Object.keys(CONFIG_KEYS).join(', ')}.`,
		);
	return key;
}

export interface StoredConfig {
	version?: number;
	url?: string;
	token?: string;
	contentDomain?: string;
	savedAt?: string;
	updatedAt?: string;
}

/** What `login` writes: a URL plus a verified token, and any settings to keep. */
export interface Credentials {
	url: string;
	token: string;
	contentDomain?: string;
}

export interface ResolvedConfig {
	url: string;
	token: string;
	origin: string;
	/** Domain deployed sites use, when configured. */
	contentDomain?: string;
	source: {
		url: 'flag' | 'env' | 'config';
		token: 'flag' | 'env' | 'config';
		contentDomain: 'env' | 'config' | 'unset';
	};
	path: string;
}

export interface ConfigEntry {
	key: ConfigKey;
	value?: string;
	source: 'env' | 'config' | 'unset';
	secret: boolean;
	env?: string;
}

export interface ConfigReport {
	path: string;
	/** Whether a config file with at least one setting exists. */
	stored: boolean;
	entries: ConfigEntry[];
}

export interface SettingChange {
	path: string;
	key: ConfigKey;
	value?: string;
	changed: boolean;
}

export interface ClearCredentialsResult {
	path: string;
	removed: boolean;
	settingsKept: boolean;
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[CONFIG_ENV_DIR]?.trim();
	if (override) return override;
	const xdg = env.XDG_CONFIG_HOME?.trim();
	if (xdg) return join(xdg, 'skiff');
	return join(env.HOME?.trim() || homedir(), '.config', 'skiff');
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
	return join(configDirectory(env), 'config.json');
}

/** Accept `control.example.com` and default it to https (http for localhost). */
export function normalizePlatformUrl(raw: string): string {
	let value = raw.trim();
	if (!value) throw new ConfigError('A platform URL is required.');
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
		const host = value.split('/')[0]?.split(':')[0]?.toLowerCase() ?? '';
		const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
		value = `${local ? 'http' : 'https'}://${value}`;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError(`"${raw}" is not a valid URL.`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new ConfigError('The platform URL must use http or https.');
	if (!url.hostname) throw new ConfigError(`"${raw}" is not a valid URL.`);
	url.hash = '';
	url.search = '';
	return url.toString().replace(/\/+$/, '');
}

export function platformOrigin(url: string): string {
	return new URL(normalizePlatformUrl(url)).origin;
}

/**
 * Accept `kierancloud.dev`, `https://kierancloud.dev/` and `localhost`; reject
 * anything that is not a bare hostname (no paths, ports, wildcards or spaces).
 */
export function normalizeContentDomain(raw: string): string {
	let value = raw.trim().toLowerCase();
	if (!value) throw new ConfigError('A content domain is required.');
	if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
		try {
			value = new URL(value).hostname;
		} catch {
			throw new ConfigError(`"${raw}" is not a valid domain.`);
		}
	}
	value = value.replace(/\.$/, '');
	if (!value || /[\s/@:*\\]/.test(value))
		throw new ConfigError(
			`"${raw}" is not a valid domain. Use a bare hostname such as kierancloud.dev.`,
		);
	const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
	const labels = value.split('.');
	if (labels.length > 127 || value.length > 253 || !labels.every((part) => label.test(part)))
		throw new ConfigError(
			`"${raw}" is not a valid domain. Use a bare hostname such as kierancloud.dev.`,
		);
	return value;
}

export async function readStoredConfig(
	env: NodeJS.ProcessEnv = process.env,
): Promise<StoredConfig | null> {
	const path = configFile(env);
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if (isNotFound(error)) return null;
		throw new ConfigError(`Could not read ${path}: ${errorMessage(error)}`, { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ConfigError(`${path} is not valid JSON. Run \`skif logout --all\` and log in again.`);
	}
	if (!isRecord(parsed))
		throw new ConfigError(`${path} must contain a JSON object. Run \`skif logout --all\` and log in again.`);

	const url = optionalString(parsed.url, 'url', path);
	const token = optionalString(parsed.token, 'token', path);
	const contentDomain = optionalString(
		parsed.contentDomain ?? parsed.content_domain,
		'contentDomain',
		path,
	);

	if (!url && !token && !contentDomain) return null;
	return {
		version: typeof parsed.version === 'number' ? parsed.version : undefined,
		url: url === undefined ? undefined : normalizePlatformUrl(url),
		token,
		contentDomain: contentDomain === undefined ? undefined : normalizeContentDomain(contentDomain),
		savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
		updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
	};
}

/** Write credentials/settings, preserving other stored settings. */
export async function saveConfig(
	config: Credentials,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const current = await readStoredConfig(env);
	const token = config.token.trim();
	if (!token) throw new ConfigError('An API key is required.');
	const now = new Date().toISOString();
	const stored: StoredConfig = {
		version: 1,
		url: normalizePlatformUrl(config.url),
		token,
		contentDomain:
			config.contentDomain === undefined
				? current?.contentDomain
				: normalizeContentDomain(config.contentDomain),
		savedAt: now,
		updatedAt: now,
	};
	return writeStoredConfig(stored, env);
}

/** Remove the API key but keep the URL and domains, so the next login remembers them. */
export async function clearCredentials(
	env: NodeJS.ProcessEnv = process.env,
): Promise<ClearCredentialsResult> {
	const path = configFile(env);
	const current = await readStoredConfig(env);
	if (!current) return { path, removed: false, settingsKept: false };

	const removed = current.token !== undefined;
	delete current.token;
	delete current.savedAt;

	const settingsKept = current.url !== undefined || current.contentDomain !== undefined;
	if (!settingsKept) {
		await deleteConfig(env);
		return { path, removed, settingsKept };
	}
	current.version = 1;
	current.updatedAt = new Date().toISOString();
	await writeStoredConfig(current, env);
	return { path, removed, settingsKept };
}

/** Delete the whole config file, including non-secret settings. */
export async function deleteConfig(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	const path = configFile(env);
	try {
		const info = await stat(path);
		if (info.isDirectory()) throw new ConfigError(`${path} is a directory, refusing to delete it.`);
	} catch (error) {
		if (isNotFound(error)) return false;
		if (error instanceof ConfigError) throw error;
		throw new ConfigError(`Could not inspect ${path}: ${errorMessage(error)}`, { cause: error });
	}
	try {
		await rm(path, { force: true });
	} catch (error) {
		throw new ConfigError(`Could not delete ${path}: ${errorMessage(error)}`, { cause: error });
	}
	// Best effort: remove the directory if it is now empty.
	await rmdir(dirname(path)).catch(() => undefined);
	return true;
}

export async function setStoredConfigValue(
	key: ConfigKey,
	value: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SettingChange> {
	const path = configFile(env);
	const current = (await readStoredConfig(env)) ?? {};
	const raw = value.trim();
	if (!raw) throw new ConfigError(`A value is required for "${key}".`);

	let storedValue: string;
	switch (key) {
		case 'url':
			storedValue = normalizePlatformUrl(raw);
			break;
		case 'contentDomain':
			storedValue = normalizeContentDomain(raw);
			break;
		case 'token':
			storedValue = raw;
			current.savedAt = new Date().toISOString();
			break;
	}

	current[key] = storedValue;
	current.version = 1;
	current.updatedAt = new Date().toISOString();
	await writeStoredConfig(current, env);
	return { path, key, value: storedValue, changed: true };
}

export async function unsetStoredConfigValue(
	key: ConfigKey,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SettingChange> {
	const path = configFile(env);
	const current = await readStoredConfig(env);
	if (!current) return { path, key, changed: false };

	const existed = current[key] !== undefined;
	delete current[key];
	if (key === 'token') delete current.savedAt;

	if (!current.url && !current.token && !current.contentDomain) {
		await deleteConfig(env);
		return { path, key, changed: existed };
	}
	current.version = 1;
	current.updatedAt = new Date().toISOString();
	await writeStoredConfig(current, env);
	return { path, key, changed: existed };
}

/** Effective settings plus where each value came from. Used by `skif config list`. */
export async function describeConfig(
	env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigReport> {
	const stored = await readStoredConfig(env);
	const entries: ConfigEntry[] = [];
	for (const info of Object.values(CONFIG_KEYS)) {
		const envValue = info.env ? trimmed(env[info.env]) : undefined;
		const configValue = stored?.[info.key];
		entries.push({
			key: info.key,
			value: envValue ?? configValue,
			source: envValue !== undefined ? 'env' : configValue !== undefined ? 'config' : 'unset',
			secret: info.secret,
			env: info.env,
		});
	}
	return { path: configFile(env), stored: stored !== null, entries };
}

export async function resolveConfig(
	overrides: { url?: string; token?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
	const stored = overrides.url && overrides.token ? null : await readStoredConfig(env);

	const envUrl = trimmed(env[URL_ENV]);
	const envToken = trimmed(env[TOKEN_ENV]);
	const envContentDomain = trimmed(env[CONTENT_DOMAIN_ENV]);
	const urlValue = overrides.url ?? envUrl ?? stored?.url;
	const tokenValue = overrides.token ?? envToken ?? stored?.token;
	const contentDomainValue = envContentDomain ?? stored?.contentDomain;

	const source = {
		url: overrides.url ? ('flag' as const) : envUrl ? ('env' as const) : ('config' as const),
		token: overrides.token ? ('flag' as const) : envToken ? ('env' as const) : ('config' as const),
		contentDomain: envContentDomain ? ('env' as const) : stored?.contentDomain ? ('config' as const) : ('unset' as const),
	};

	if (!urlValue)
		throw new ConfigError(
			'Not logged in: no platform URL. Run `skif login`, or set SKIFF_URL and SKIFF_TOKEN.',
		);
	if (!tokenValue)
		throw new ConfigError('Not logged in: no API key. Run `skif login`, or set SKIFF_TOKEN.');

	return {
		url: normalizePlatformUrl(urlValue),
		token: tokenValue,
		origin: platformOrigin(urlValue),
		contentDomain: contentDomainValue
			? normalizeContentDomain(contentDomainValue)
			: undefined,
		source,
		path: configFile(env),
	};
}

async function writeStoredConfig(
	stored: StoredConfig,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const dir = configDirectory(env);
	const path = configFile(env);
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		// `chmod` also repairs a directory or file left with loose permissions.
		await chmod(dir, 0o700).catch(() => undefined);
		const temp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
		await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
		await chmod(temp, 0o600).catch(() => undefined);
		await rename(temp, path);
		await chmod(path, 0o600).catch(() => undefined);
	} catch (error) {
		throw new ConfigError(`Could not write ${path}: ${errorMessage(error)}`, { cause: error });
	}
	return path;
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string')
		throw new ConfigError(`${path} has a non-string "${field}". Run \`skif config unset ${field}\`.`);
	const trimmedValue = value.trim();
	if (!trimmedValue)
		throw new ConfigError(
			`${path} has an empty "${field}". Run \`skif config unset ${field}\` or log in again.`,
		);
	return trimmedValue;
}

function trimmed(value: string | undefined): string | undefined {
	const result = value?.trim();
	return result ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
