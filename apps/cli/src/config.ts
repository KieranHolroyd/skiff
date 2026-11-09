/**
 * Persistent CLI settings live in `~/.config/yoal/config.json` (or
 * `$YOAL_CONFIG_DIR` / `$XDG_CONFIG_HOME/yoal/config.json`), mode 0600.
 *
 * The file holds one or more **named profiles**, each with its own control-plane
 * URL, API key and content domain. That lets one machine deploy to several Yoal
 * installations (production, staging, a local dev server) without juggling env
 * vars. A profile is chosen by, in order: `--profile`, `$YOAL_PROFILE`, the
 * active profile saved by `yoal profile use`, or the only profile when exactly
 * one exists.
 *
 * Files written by older CLI versions have the settings at the top level. They
 * are read as a profile named `default` (and upgraded on the next write), so
 * existing logins keep working.
 *
 * `YOAL_URL`, `YOAL_TOKEN` and `YOAL_CONTENT_DOMAIN` still override the
 * selected profile, which keeps CI and agent use stateless.
 */
import { chmod, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigError } from './errors.ts';

export const CONFIG_ENV_DIR = 'YOAL_CONFIG_DIR';
export const URL_ENV = 'YOAL_URL';
export const TOKEN_ENV = 'YOAL_TOKEN';
export const CONTENT_DOMAIN_ENV = 'YOAL_CONTENT_DOMAIN';
export const PROFILE_ENV = 'YOAL_PROFILE';

/** Implicit profile name used for a legacy single-profile config file. */
export const DEFAULT_PROFILE = 'default';

const CONFIG_VERSION = 2;

export type ConfigKey = 'url' | 'contentDomain' | 'token';

export interface ConfigKeyInfo {
	/** Canonical key name used in the config file and `yoal config` output. */
	key: ConfigKey;
	description: string;
	secret: boolean;
	env?: string;
}

export const CONFIG_KEYS: Record<ConfigKey, ConfigKeyInfo> = {
	url: {
		key: 'url',
		description: 'Control-plane URL, e.g. https://control.example.com',
		secret: false,
		env: URL_ENV,
	},
	contentDomain: {
		key: 'contentDomain',
		description: 'Domain deployed sites are served from, e.g. examplecloud.com',
		secret: false,
		env: CONTENT_DOMAIN_ENV,
	},
	token: {
		key: 'token',
		description: 'API key. Prefer `yoal login`, which verifies it.',
		secret: true,
		env: TOKEN_ENV,
	},
};

/** Friendly aliases so `yoal config set content-domain …` works as expected. */
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

/** One profile's settings. `savedAt` tracks token writes; `updatedAt` any write. */
export interface StoredConfig {
	url?: string;
	token?: string;
	contentDomain?: string;
	savedAt?: string;
	updatedAt?: string;
}

/** On-disk shape of the version 2 config file. */
export interface StoredConfigFile {
	version?: number;
	activeProfile?: string;
	profiles: Record<string, StoredConfig>;
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
	/** Profile the settings came from, when one was selected. */
	profile?: string;
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
	/** Whether the selected profile exists in the config file. */
	stored: boolean;
	entries: ConfigEntry[];
	/** Profile whose settings are reported. */
	profile?: string;
	/** Profile saved as active, if any. */
	activeProfile?: string;
	/** Every configured profile name, sorted. */
	profiles: string[];
}

export interface SettingChange {
	path: string;
	key: ConfigKey;
	value?: string;
	changed: boolean;
	profile?: string;
}

export interface ClearCredentialsResult {
	path: string;
	removed: boolean;
	settingsKept: boolean;
	profile?: string;
}

export interface ProfileSummary extends StoredConfig {
	name: string;
	active: boolean;
	current: boolean;
}

export interface ProfileReport {
	path: string;
	activeProfile?: string;
	currentProfile?: string;
	profiles: ProfileSummary[];
}

export interface ProfileChange {
	path: string;
	name: string;
	previous?: string;
	activeProfile?: string;
	created?: boolean;
	changed: boolean;
}

export interface ProfileInput {
	url?: string;
	token?: string;
	contentDomain?: string;
}

/** `--profile` wins over `$YOAL_PROFILE` for the current process. */
let profileOverride: string | undefined;

export function setProfileOverride(profile: string | undefined): void {
	profileOverride = profile?.trim() ? normalizeProfileName(profile) : undefined;
}

export function getProfileOverride(): string | undefined {
	return profileOverride;
}

export function normalizeProfileName(raw: string): string {
	const value = raw.trim();
	if (!value) throw new ConfigError('A profile name is required.');
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
		throw new ConfigError(
			`"${raw}" is not a valid profile name. Use 1-64 letters, digits, dots, dashes or underscores.`,
		);
	return value;
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[CONFIG_ENV_DIR]?.trim();
	if (override) return override;
	const xdg = env.XDG_CONFIG_HOME?.trim();
	if (xdg) return join(xdg, 'yoal');
	return join(env.HOME?.trim() || homedir(), '.config', 'yoal');
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
 * Accept `examplecloud.com`, `https://examplecloud.com/` and `localhost`; reject
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
			`"${raw}" is not a valid domain. Use a bare hostname such as examplecloud.com.`,
		);
	const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
	const labels = value.split('.');
	if (labels.length > 127 || value.length > 253 || !labels.every((part) => label.test(part)))
		throw new ConfigError(
			`"${raw}" is not a valid domain. Use a bare hostname such as examplecloud.com.`,
		);
	return value;
}

/** Every profile name in the config file, sorted. */
export async function listProfileNames(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
	const state = await readConfigState(env);
	return [...state.profiles.keys()].sort();
}

/** The profile a read should use, or undefined when nothing is configured. */
export async function effectiveProfile(
	profile?: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	const state = await readConfigState(env);
	return resolveProfileForRead(state, profile, env);
}

/** The profile a write should use; falls back to `default` for a fresh config. */
export async function profileForWrite(
	profile?: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const state = await readConfigState(env);
	return resolveProfileForWrite(state, profile, env);
}

/** Return one profile's settings, or null when it does not exist. */
export async function readProfile(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<StoredConfig | null> {
	const state = await readConfigState(env);
	return state.profiles.get(normalizeProfileName(name)) ?? null;
}

export async function readStoredConfig(
	env: NodeJS.ProcessEnv = process.env,
	profile?: string,
): Promise<StoredConfig | null> {
	const state = await readConfigState(env);
	const name = resolveProfileForRead(state, profile, env);
	return name ? (state.profiles.get(name) ?? null) : null;
}

/** Add or replace a profile. The first profile (or `use`) becomes active. */
export async function addProfile(
	name: string,
	input: ProfileInput = {},
	options: { use?: boolean; force?: boolean } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<ProfileChange> {
	const state = await readConfigState(env);
	const profileName = normalizeProfileName(name);
	const existed = state.profiles.has(profileName);
	if (existed && !options.force)
		throw new ConfigError(
			`Profile "${profileName}" already exists. Remove it first or pass --force to replace it.`,
		);

	const token = input.token?.trim() || undefined;
	const now = new Date().toISOString();
	state.profiles.set(profileName, {
		url: input.url === undefined ? undefined : normalizePlatformUrl(input.url),
		token,
		contentDomain:
			input.contentDomain === undefined ? undefined : normalizeContentDomain(input.contentDomain),
		savedAt: token ? now : undefined,
		updatedAt: now,
	});
	if (options.use || !state.activeProfile) state.activeProfile = profileName;
	await writeConfigState(state, env);
	return {
		path: state.path,
		name: profileName,
		activeProfile: state.activeProfile,
		created: !existed,
		changed: true,
	};
}

/** Make `name` the profile commands use by default. */
export async function useProfile(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ProfileChange> {
	const state = await readConfigState(env);
	const profileName = normalizeProfileName(name);
	if (!state.profiles.has(profileName)) throw unknownProfile(state, profileName);
	const previous = state.activeProfile;
	state.activeProfile = profileName;
	await writeConfigState(state, env);
	return {
		path: state.path,
		name: profileName,
		previous,
		activeProfile: profileName,
		changed: previous !== profileName,
	};
}

/** Delete a profile. Removing the active one falls back to a sole remaining profile. */
export async function removeProfile(
	name: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ProfileChange> {
	const state = await readConfigState(env);
	const profileName = normalizeProfileName(name);
	if (!state.profiles.has(profileName)) throw unknownProfile(state, profileName);
	state.profiles.delete(profileName);
	if (state.activeProfile === profileName) state.activeProfile = fallbackActive(state);
	await writeConfigState(state, env);
	return {
		path: state.path,
		name: profileName,
		activeProfile: state.activeProfile,
		changed: true,
	};
}

/** Profile summaries for `yoal profile list`, sorted by name. */
export async function describeProfiles(
	env: NodeJS.ProcessEnv = process.env,
): Promise<ProfileReport> {
	const state = await readConfigState(env);
	const current = optionalEffectiveProfile(state, undefined, env);
	return {
		path: state.path,
		activeProfile: state.activeProfile,
		currentProfile: current,
		profiles: [...state.profiles.keys()].sort().map((name) => {
			const profile = state.profiles.get(name)!;
			return {
				name,
				...profile,
				active: name === state.activeProfile,
				current: name === current,
			};
		}),
	};
}

/** Write credentials/settings to the selected profile, preserving other settings. */
export async function saveConfig(
	config: Credentials,
	env: NodeJS.ProcessEnv = process.env,
	profile?: string,
): Promise<string> {
	const state = await readConfigState(env);
	const name = resolveProfileForWrite(state, profile, env);
	const token = config.token.trim();
	if (!token) throw new ConfigError('An API key is required.');
	const current = state.profiles.get(name) ?? {};
	const now = new Date().toISOString();
	state.profiles.set(name, {
		url: normalizePlatformUrl(config.url),
		token,
		contentDomain:
			config.contentDomain === undefined
				? current.contentDomain
				: normalizeContentDomain(config.contentDomain),
		savedAt: now,
		updatedAt: now,
	});
	if (!state.activeProfile) state.activeProfile = name;
	return writeConfigState(state, env);
}

/** Remove the selected profile's API key but keep its URL and domains. */
export async function clearCredentials(
	env: NodeJS.ProcessEnv = process.env,
	profile?: string,
): Promise<ClearCredentialsResult> {
	const state = await readConfigState(env);
	const path = state.path;
	const name = resolveProfileForRead(state, profile, env);
	const current = name ? state.profiles.get(name) : undefined;
	if (!name || !current) return { path, removed: false, settingsKept: false };

	const removed = current.token !== undefined;
	delete current.token;
	delete current.savedAt;

	const settingsKept = current.url !== undefined || current.contentDomain !== undefined;
	if (!settingsKept) {
		state.profiles.delete(name);
		if (state.activeProfile === name) state.activeProfile = fallbackActive(state);
		if (state.profiles.size === 0) await deleteConfig(env);
		else await writeConfigState(state, env);
		return { path, removed, settingsKept, profile: name };
	}
	current.updatedAt = new Date().toISOString();
	await writeConfigState(state, env);
	return { path, removed, settingsKept, profile: name };
}

/** Delete the whole config file, including every profile. */
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
	const state = await readConfigState(env);
	const name = resolveProfileForWrite(state, undefined, env);
	const path = state.path;
	const current = state.profiles.get(name) ?? {};
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
	current.updatedAt = new Date().toISOString();
	state.profiles.set(name, current);
	if (!state.activeProfile) state.activeProfile = name;
	await writeConfigState(state, env);
	return { path, key, value: storedValue, changed: true, profile: name };
}

export async function unsetStoredConfigValue(
	key: ConfigKey,
	env: NodeJS.ProcessEnv = process.env,
): Promise<SettingChange> {
	const state = await readConfigState(env);
	const path = state.path;
	const name = resolveProfileForRead(state, undefined, env);
	const current = name ? state.profiles.get(name) : undefined;
	if (!name || !current) return { path, key, changed: false };

	const existed = current[key] !== undefined;
	if (!existed) return { path, key, changed: false, profile: name };

	delete current[key];
	if (key === 'token') delete current.savedAt;

	if (!current.url && !current.token && !current.contentDomain) {
		state.profiles.delete(name);
		if (state.activeProfile === name) state.activeProfile = fallbackActive(state);
		if (state.profiles.size === 0) await deleteConfig(env);
		else await writeConfigState(state, env);
		return { path, key, changed: existed, profile: name };
	}
	current.updatedAt = new Date().toISOString();
	await writeConfigState(state, env);
	return { path, key, changed: existed, profile: name };
}

/** Effective settings plus where each value came from. Used by `yoal config list`. */
export async function describeConfig(
	env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigReport> {
	const state = await readConfigState(env);
	const name = resolveProfileForRead(state, undefined, env);
	const stored = name ? state.profiles.get(name) : undefined;
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
	return {
		path: state.path,
		stored: stored !== undefined,
		entries,
		profile: name,
		activeProfile: state.activeProfile,
		profiles: [...state.profiles.keys()].sort(),
	};
}

export async function resolveConfig(
	overrides: { url?: string; token?: string; profile?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
	const envUrl = trimmed(env[URL_ENV]);
	const envToken = trimmed(env[TOKEN_ENV]);
	const envContentDomain = trimmed(env[CONTENT_DOMAIN_ENV]);
	const state = await readConfigState(env);

	// Env-only use (CI, agents) must not require a profile: only select one when
	// the URL or token has to come from the config file.
	const completeInEnv = Boolean((overrides.url ?? envUrl) && (overrides.token ?? envToken));
	const profileName = completeInEnv
		? optionalEffectiveProfile(state, overrides.profile, env)
		: resolveProfileForRead(state, overrides.profile, env);
	const stored = profileName ? state.profiles.get(profileName) : undefined;

	const urlValue = overrides.url ?? envUrl ?? stored?.url;
	const tokenValue = overrides.token ?? envToken ?? stored?.token;
	const contentDomainValue = envContentDomain ?? stored?.contentDomain;

	const source = {
		url: overrides.url ? ('flag' as const) : envUrl ? ('env' as const) : ('config' as const),
		token: overrides.token ? ('flag' as const) : envToken ? ('env' as const) : ('config' as const),
		contentDomain: envContentDomain
			? ('env' as const)
			: stored?.contentDomain
				? ('config' as const)
				: ('unset' as const),
	};

	if (!urlValue)
		throw new ConfigError(
			'Not logged in: no platform URL. Run `yoal login`, or set YOAL_URL and YOAL_TOKEN.',
			{ suggestions: profileHint(state) },
		);
	if (!tokenValue)
		throw new ConfigError('Not logged in: no API key. Run `yoal login`, or set YOAL_TOKEN.', {
			suggestions: profileHint(state),
		});

	return {
		url: normalizePlatformUrl(urlValue),
		token: tokenValue,
		origin: platformOrigin(urlValue),
		contentDomain: contentDomainValue
			? normalizeContentDomain(contentDomainValue)
			: undefined,
		profile: profileName,
		source,
		path: configFile(env),
	};
}

interface ConfigState {
	path: string;
	activeProfile?: string;
	profiles: Map<string, StoredConfig>;
}

async function readConfigState(env: NodeJS.ProcessEnv = process.env): Promise<ConfigState> {
	const path = configFile(env);
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (error) {
		if (isNotFound(error)) return { path, profiles: new Map() };
		throw new ConfigError(`Could not read ${path}: ${errorMessage(error)}`, { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ConfigError(`${path} is not valid JSON. Run \`yoal logout --all\` and log in again.`);
	}
	if (!isRecord(parsed))
		throw new ConfigError(
			`${path} must contain a JSON object. Run \`yoal logout --all\` and log in again.`,
		);

	if (parsed.profiles !== undefined) {
		if (!isRecord(parsed.profiles))
			throw new ConfigError(
				`${path} must contain a "profiles" object. Run \`yoal logout --all\` and log in again.`,
			);
		const profiles = new Map<string, StoredConfig>();
		for (const [rawName, value] of Object.entries(parsed.profiles)) {
			const name = normalizeProfileName(rawName);
			if (!isRecord(value))
				throw new ConfigError(`${path} has a non-object profile "${name}".`);
			profiles.set(name, parseProfile(value, `profiles.${name}`, path));
		}
		let activeProfile: string | undefined;
		if (parsed.activeProfile !== undefined && parsed.activeProfile !== null) {
			if (typeof parsed.activeProfile !== 'string')
				throw new ConfigError(`${path} has a non-string "activeProfile".`);
			activeProfile = normalizeProfileName(parsed.activeProfile);
			// A stale activeProfile must not make `yoal profile list/use` unusable.
			if (!profiles.has(activeProfile)) activeProfile = undefined;
		}
		return { path, profiles, activeProfile };
	}

	// Version 1 (or an unversioned older file): settings at the top level.
	const legacy: StoredConfig = {
		url: optionalString(parsed.url, 'url', path),
		token: optionalString(parsed.token, 'token', path),
		contentDomain: optionalString(parsed.contentDomain ?? parsed.content_domain, 'contentDomain', path),
		savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
		updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
	};
	if (legacy.url !== undefined) legacy.url = normalizePlatformUrl(legacy.url);
	if (legacy.contentDomain !== undefined)
		legacy.contentDomain = normalizeContentDomain(legacy.contentDomain);
	if (legacy.url === undefined && legacy.token === undefined && legacy.contentDomain === undefined)
		return { path, profiles: new Map() };
	return {
		path,
		activeProfile: DEFAULT_PROFILE,
		profiles: new Map([[DEFAULT_PROFILE, legacy]]),
	};
}

function parseProfile(
	record: Record<string, unknown>,
	label: string,
	path: string,
): StoredConfig {
	const url = optionalString(record.url, `${label}.url`, path);
	const token = optionalString(record.token, `${label}.token`, path);
	const contentDomain = optionalString(
		record.contentDomain ?? record.content_domain,
		`${label}.contentDomain`,
		path,
	);
	return {
		url: url === undefined ? undefined : normalizePlatformUrl(url),
		token,
		contentDomain:
			contentDomain === undefined ? undefined : normalizeContentDomain(contentDomain),
		savedAt: typeof record.savedAt === 'string' ? record.savedAt : undefined,
		updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
	};
}

async function writeConfigState(
	state: ConfigState,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	if (state.profiles.size === 0) {
		await deleteConfig(env);
		return state.path;
	}
	const profiles: Record<string, StoredConfig> = {};
	for (const name of [...state.profiles.keys()].sort()) {
		const profile = state.profiles.get(name)!;
		profiles[name] = compactProfile(profile);
	}
	const payload: StoredConfigFile = { version: CONFIG_VERSION, profiles };
	if (state.activeProfile) payload.activeProfile = state.activeProfile;

	const dir = configDirectory(env);
	const path = configFile(env);
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		// `chmod` also repairs a directory or file left with loose permissions.
		await chmod(dir, 0o700).catch(() => undefined);
		const temp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
		await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
		await chmod(temp, 0o600).catch(() => undefined);
		await rename(temp, path);
		await chmod(path, 0o600).catch(() => undefined);
	} catch (error) {
		throw new ConfigError(`Could not write ${path}: ${errorMessage(error)}`, { cause: error });
	}
	return path;
}

function compactProfile(profile: StoredConfig): StoredConfig {
	return {
		...(profile.url !== undefined ? { url: profile.url } : {}),
		...(profile.token !== undefined ? { token: profile.token } : {}),
		...(profile.contentDomain !== undefined ? { contentDomain: profile.contentDomain } : {}),
		...(profile.savedAt !== undefined ? { savedAt: profile.savedAt } : {}),
		...(profile.updatedAt !== undefined ? { updatedAt: profile.updatedAt } : {}),
	};
}

/** Explicit flag > `--profile` override > `$YOAL_PROFILE`. */
function requestedProfile(
	explicit: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	return explicit?.trim() || profileOverride || trimmed(env[PROFILE_ENV]);
}

/** Resolve a profile for reading; an unset config is allowed. */
function resolveProfileForRead(
	state: ConfigState,
	explicit: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const requested = requestedProfile(explicit, env);
	if (requested) {
		const name = normalizeProfileName(requested);
		if (!state.profiles.has(name)) throw unknownProfile(state, name);
		return name;
	}
	if (state.activeProfile && state.profiles.has(state.activeProfile)) return state.activeProfile;
	const names = [...state.profiles.keys()];
	if (names.length === 1) return names[0];
	if (names.length === 0) return undefined;
	throw ambiguousProfile(names);
}

/** Resolve a profile for writing; a fresh config gets `default`. */
function resolveProfileForWrite(
	state: ConfigState,
	explicit: string | undefined,
	env: NodeJS.ProcessEnv,
): string {
	const requested = requestedProfile(explicit, env);
	if (requested) return normalizeProfileName(requested);
	if (state.activeProfile) return state.activeProfile;
	const names = [...state.profiles.keys()];
	if (names.length === 1) return names[0]!;
	if (names.length === 0) return DEFAULT_PROFILE;
	throw ambiguousProfile(names);
}

/** Best-effort selection that never throws; used when env creds are complete. */
function optionalEffectiveProfile(
	state: ConfigState,
	explicit: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const requested = requestedProfile(explicit, env);
	if (requested) {
		const name = normalizeProfileName(requested);
		return state.profiles.has(name) ? name : undefined;
	}
	if (state.activeProfile && state.profiles.has(state.activeProfile)) return state.activeProfile;
	const names = [...state.profiles.keys()];
	return names.length === 1 ? names[0] : undefined;
}

function fallbackActive(state: ConfigState): string | undefined {
	const names = [...state.profiles.keys()].sort();
	return names.length === 1 ? names[0] : undefined;
}

function unknownProfile(state: ConfigState, name: string): ConfigError {
	const names = [...state.profiles.keys()].sort();
	const available = names.length
		? `Available profiles: ${names.join(', ')}.`
		: 'No profiles are configured.';
	return new ConfigError(`Unknown profile "${name}". ${available}`, {
		suggestions: [
			'Run `yoal profile list` to see saved profiles.',
			`Run \`yoal profile add ${name} --url <control-url>\` to create it.`,
		],
	});
}

function ambiguousProfile(names: string[]): ConfigError {
	const sorted = [...names].sort();
	return new ConfigError(
		`Multiple profiles are configured (${sorted.join(', ')}), but none is active. Choose one with \`--profile <name>\`, set ${PROFILE_ENV}, or run \`yoal profile use <name>\`.`,
		{ suggestions: ['Run `yoal profile list` to see the profiles.'] },
	);
}

function profileHint(state: ConfigState): string[] {
	const names = [...state.profiles.keys()].sort();
	if (names.length === 0) return [];
	if (names.length === 1) return [`The only saved profile "${names[0]}" has no credentials yet.`];
	return [`Saved profiles: ${names.join(', ')}. Choose one with \`--profile <name>\`.`];
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string')
		throw new ConfigError(`${path} has a non-string "${field}". Run \`yoal config unset ${field}\`.`);
	const trimmedValue = value.trim();
	if (!trimmedValue)
		throw new ConfigError(
			`${path} has an empty "${field}". Run \`yoal config unset ${field}\` or log in again.`,
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
