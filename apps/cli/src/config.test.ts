import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	CONTENT_DOMAIN_ENV,
	TOKEN_ENV,
	URL_ENV,
	canonicalConfigKey,
	clearCredentials,
	configDirectory,
	configFile,
	deleteConfig,
	describeConfig,
	normalizeContentDomain,
	normalizePlatformUrl,
	readStoredConfig,
	resolveConfig,
	saveConfig,
	setStoredConfigValue,
	unsetStoredConfigValue,
} from './config.ts';

let dir = '';

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-config-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const env = () =>
	({
		HOME: dir,
		SKIFF_CONFIG_DIR: dir,
		SKIFF_URL: undefined,
		SKIFF_TOKEN: undefined,
		SKIFF_CONTENT_DOMAIN: undefined,
	}) as Record<string, string | undefined>;

describe('config storage', () => {
	test('writes config.json with mode 0600 and reads it back', async () => {
		const values = env();
		const path = await saveConfig(
			{ url: 'https://control.example.com', token: 'sk_test_123', contentDomain: 'sites.example.com' },
			values,
		);

		expect(path).toBe(join(dir, 'config.json'));
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(configDirectory(values))).mode & 0o777).toBe(0o700);

		const stored = await readStoredConfig(values);
		expect(stored?.url).toBe('https://control.example.com');
		expect(stored?.token).toBe('sk_test_123');
		expect(stored?.contentDomain).toBe('sites.example.com');
		expect(typeof stored?.savedAt).toBe('string');

		const text = await readFile(configFile(values), 'utf8');
		expect(text).toContain('"token": "sk_test_123"');
	});

	test('reads a config written by older CLI versions', async () => {
		const values = env();
		await Bun.write(
			configFile(values),
			JSON.stringify({ url: 'https://control.example.com', token: 'token', savedAt: '2026-01-01T00:00:00.000Z' }),
		);
		const stored = await readStoredConfig(values);
		expect(stored?.url).toBe('https://control.example.com');
		expect(stored?.token).toBe('token');
		expect(stored?.contentDomain).toBeUndefined();
	});

	test('keeps the URL and content domain across logout and login', async () => {
		const values = env();
		await saveConfig(
			{ url: 'https://control.example.com', token: 'first', contentDomain: 'sites.example.com' },
			values,
		);

		const cleared = await clearCredentials(values);
		expect(cleared.removed).toBe(true);
		expect(cleared.settingsKept).toBe(true);

		const afterLogout = await readStoredConfig(values);
		expect(afterLogout?.url).toBe('https://control.example.com');
		expect(afterLogout?.contentDomain).toBe('sites.example.com');
		expect(afterLogout?.token).toBeUndefined();

		await saveConfig({ url: 'https://control.example.com', token: 'second' }, values);
		const afterLogin = await readStoredConfig(values);
		expect(afterLogin?.token).toBe('second');
		expect(afterLogin?.contentDomain).toBe('sites.example.com');
	});

	test('logout deletes the file when only a token was stored', async () => {
		const values = env();
		await setStoredConfigValue('token', 'token', values);
		const cleared = await clearCredentials(values);
		expect(cleared.removed).toBe(true);
		expect(cleared.settingsKept).toBe(false);
		expect(await readStoredConfig(values)).toBeNull();
	});

	test('deletes the whole config idempotently', async () => {
		const values = env();
		await saveConfig(
			{ url: 'https://control.example.com', token: 'token', contentDomain: 'sites.example.com' },
			values,
		);
		expect(await deleteConfig(values)).toBe(true);
		expect(await readStoredConfig(values)).toBeNull();
		expect(await deleteConfig(values)).toBe(false);
	});

	test('rejects malformed config instead of guessing', async () => {
		const values = env();
		await Bun.write(configFile(values), '{"url":"https://control.example.com","token":42}');
		await expect(readStoredConfig(values)).rejects.toThrow('non-string "token"');

		await Bun.write(configFile(values), 'not json');
		await expect(readStoredConfig(values)).rejects.toThrow('not valid JSON');
	});

	test('treats an empty or setting-free file as no config', async () => {
		const values = env();
		await Bun.write(configFile(values), '{}');
		expect(await readStoredConfig(values)).toBeNull();
	});
});

describe('persistent settings', () => {
	test('sets aliases with normalized values and unsets them', async () => {
		const values = env();
		expect(canonicalConfigKey('platform')).toBe('url');
		expect(canonicalConfigKey('control-url')).toBe('url');
		expect(canonicalConfigKey('content-domain')).toBe('contentDomain');
		expect(canonicalConfigKey('sites-domain')).toBe('contentDomain');
		expect(canonicalConfigKey('api-key')).toBe('token');

		await setStoredConfigValue('url', 'control.example.com/', values);
		expect((await readStoredConfig(values))?.url).toBe('https://control.example.com');

		await setStoredConfigValue('contentDomain', 'https://Sites.Example.com/', values);
		expect((await readStoredConfig(values))?.contentDomain).toBe('sites.example.com');

		await setStoredConfigValue('token', ' sk_test ', values);
		expect((await readStoredConfig(values))?.token).toBe('sk_test');

		await unsetStoredConfigValue('contentDomain', values);
		expect((await readStoredConfig(values))?.contentDomain).toBeUndefined();

		await unsetStoredConfigValue('url', values);
		await unsetStoredConfigValue('token', values);
		expect(await readStoredConfig(values)).toBeNull();
		expect(await unsetStoredConfigValue('url', values)).toMatchObject({ changed: false });
	});

	test('rejects unknown settings and empty values', async () => {
		expect(() => canonicalConfigKey('colour')).toThrow('Unknown setting "colour"');
		await expect(setStoredConfigValue('url', '   ', env())).rejects.toThrow('A value is required');
	});

	test('reports effective values and their source', async () => {
		const values = env();
		await setStoredConfigValue('url', 'https://control.example.com', values);
		await setStoredConfigValue('contentDomain', 'sites.example.com', values);
		await setStoredConfigValue('token', 'sk_test', values);
		values[CONTENT_DOMAIN_ENV] = 'env.example.com';

		const report = await describeConfig(values);
		const entry = (key: string) => report.entries.find((candidate) => candidate.key === key);
		expect(entry('url')).toMatchObject({ value: 'https://control.example.com', source: 'config' });
		expect(entry('contentDomain')).toMatchObject({ value: 'env.example.com', source: 'env' });
		expect(entry('token')).toMatchObject({ value: 'sk_test', source: 'config', secret: true });
		expect(report.stored).toBe(true);
	});
});

describe('config resolution', () => {
	test('environment variables override stored credentials', async () => {
		const values = env();
		await saveConfig({ url: 'https://config.example.com', token: 'config-token' }, values);
		values[URL_ENV] = 'http://localhost:5173';
		values[TOKEN_ENV] = 'env-token';

		const resolved = await resolveConfig({}, values);
		expect(resolved.url).toBe('http://localhost:5173');
		expect(resolved.token).toBe('env-token');
		expect(resolved.origin).toBe('http://localhost:5173');
		expect(resolved.source).toEqual({
			url: 'env',
			token: 'env',
			contentDomain: 'unset',
		});
	});

	test('explicit flags override the environment', async () => {
		const values = env();
		values[URL_ENV] = 'https://env.example.com';
		values[TOKEN_ENV] = 'env-token';
		const resolved = await resolveConfig(
			{ url: 'https://flag.example.com', token: 'flag-token' },
			values,
		);
		expect(resolved.url).toBe('https://flag.example.com');
		expect(resolved.token).toBe('flag-token');
		expect(resolved.source).toEqual({
			url: 'flag',
			token: 'flag',
			contentDomain: 'unset',
		});
	});

	test('resolves the content domain from the config or the environment', async () => {
		const values = env();
		await saveConfig(
			{ url: 'https://control.example.com', token: 'token', contentDomain: 'sites.example.com' },
			values,
		);
		let resolved = await resolveConfig({}, values);
		expect(resolved.contentDomain).toBe('sites.example.com');
		expect(resolved.source.contentDomain).toBe('config');

		values[CONTENT_DOMAIN_ENV] = 'env.example.com';
		resolved = await resolveConfig({}, values);
		expect(resolved.contentDomain).toBe('env.example.com');
		expect(resolved.source.contentDomain).toBe('env');
	});

	test('explains how to log in when no credentials exist', async () => {
		await expect(resolveConfig({}, env())).rejects.toThrow('Run `skif login`');
	});

	test('a saved URL without a key still asks for login', async () => {
		const values = env();
		await setStoredConfigValue('url', 'https://control.example.com', values);
		await expect(resolveConfig({}, values)).rejects.toThrow('no API key');
	});
});

describe('normalizePlatformUrl', () => {
	test('adds a protocol and strips trailing slashes', () => {
		expect(normalizePlatformUrl('control.example.com/')).toBe('https://control.example.com');
		expect(normalizePlatformUrl('localhost:5173')).toBe('http://localhost:5173');
		expect(normalizePlatformUrl('https://control.example.com///')).toBe('https://control.example.com');
	});

	test('rejects non-http protocols', () => {
		expect(() => normalizePlatformUrl('ftp://example.com')).toThrow('http or https');
	});
});

describe('normalizeContentDomain', () => {
	test('accepts bare hosts, URLs and localhost', () => {
		expect(normalizeContentDomain('kierancloud.dev')).toBe('kierancloud.dev');
		expect(normalizeContentDomain(' https://KieranCloud.dev/ ')).toBe('kierancloud.dev');
		expect(normalizeContentDomain('localhost')).toBe('localhost');
		expect(normalizeContentDomain('sites.example.com.')).toBe('sites.example.com');
	});

	test('rejects paths, ports, wildcards and spaces', () => {
		expect(() => normalizeContentDomain('example.com/path')).toThrow('not a valid domain');
		expect(() => normalizeContentDomain('example.com:8080')).toThrow('not a valid domain');
		expect(() => normalizeContentDomain('*.example.com')).toThrow('not a valid domain');
		expect(() => normalizeContentDomain('not a domain')).toThrow('not a valid domain');
	});
});
