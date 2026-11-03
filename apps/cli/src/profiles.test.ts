import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	CONTENT_DOMAIN_ENV,
	DEFAULT_PROFILE,
	PROFILE_ENV,
	TOKEN_ENV,
	URL_ENV,
	addProfile,
	clearCredentials,
	configDirectory,
	configFile,
	describeConfig,
	describeProfiles,
	effectiveProfile,
	listProfileNames,
	normalizeProfileName,
	readProfile,
	readStoredConfig,
	removeProfile,
	resolveConfig,
	saveConfig,
	setProfileOverride,
	setStoredConfigValue,
	useProfile,
} from './config.ts';

let dir = '';

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-profiles-'));
	setProfileOverride(undefined);
});

afterEach(async () => {
	setProfileOverride(undefined);
	await rm(dir, { recursive: true, force: true });
});

const env = () =>
	({
		HOME: dir,
		SKIFF_CONFIG_DIR: dir,
		SKIFF_URL: undefined,
		SKIFF_TOKEN: undefined,
		SKIFF_CONTENT_DOMAIN: undefined,
		SKIFF_PROFILE: undefined,
	}) as Record<string, string | undefined>;

describe('profiles', () => {
	test('reads a legacy single-profile config as the default profile', async () => {
		const values = env();
		await Bun.write(
			configFile(values),
			JSON.stringify({
				version: 1,
				url: 'https://control.example.com',
				token: 'legacy-token',
				contentDomain: 'sites.example.com',
			}),
		);

		expect(await listProfileNames(values)).toEqual([DEFAULT_PROFILE]);
		const report = await describeProfiles(values);
		expect(report.activeProfile).toBe(DEFAULT_PROFILE);
		expect(report.currentProfile).toBe(DEFAULT_PROFILE);

		const resolved = await resolveConfig({}, values);
		expect(resolved.profile).toBe(DEFAULT_PROFILE);
		expect(resolved.url).toBe('https://control.example.com');
		expect(resolved.token).toBe('legacy-token');
	});

	test('writes version 2 profiles with 0600 permissions', async () => {
		const values = env();
		await saveConfig(
			{ url: 'https://prod.example.com', token: 'prod-token', contentDomain: 'prod.example.com' },
			values,
		);

		const path = configFile(values);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(configDirectory(values))).mode & 0o777).toBe(0o700);

		const raw = JSON.parse(await readFile(path, 'utf8')) as {
			version: number;
			activeProfile: string;
			profiles: Record<string, { url?: string; token?: string }>;
		};
		expect(raw.version).toBe(2);
		expect(raw.activeProfile).toBe(DEFAULT_PROFILE);
		expect(raw.profiles[DEFAULT_PROFILE]).toMatchObject({
			url: 'https://prod.example.com',
			token: 'prod-token',
		});
	});

	test('adds profiles without changing the active one', async () => {
		const values = env();
		await saveConfig(
			{ url: 'https://prod.example.com', token: 'prod-token', contentDomain: 'prod.example.com' },
			values,
		);
		const change = await addProfile(
			'staging',
			{
				url: 'https://staging.example.com',
				token: 'staging-token',
				contentDomain: 'staging.example.com',
			},
			{},
			values,
		);

		expect(change).toMatchObject({ name: 'staging', activeProfile: DEFAULT_PROFILE });
		expect(await listProfileNames(values)).toEqual([DEFAULT_PROFILE, 'staging']);
		expect((await resolveConfig({}, values)).profile).toBe(DEFAULT_PROFILE);
		expect((await resolveConfig({ profile: 'staging' }, values)).url).toBe(
			'https://staging.example.com',
		);
	});

	test('selects a sole profile automatically even without activeProfile', async () => {
		const values = env();
		await Bun.write(
			configFile(values),
			JSON.stringify({
				version: 2,
				profiles: {
					dev: { url: 'http://localhost:5173', token: 'dev-token' },
				},
			}),
		);

		const resolved = await resolveConfig({}, values);
		expect(resolved.profile).toBe('dev');
		expect(resolved.url).toBe('http://localhost:5173');
	});

	test('refuses to guess when several profiles exist and none is active', async () => {
		const values = env();
		await Bun.write(
			configFile(values),
			JSON.stringify({
				version: 2,
				profiles: {
					prod: { url: 'https://prod.example.com', token: 'prod-token' },
					staging: { url: 'https://staging.example.com', token: 'staging-token' },
				},
			}),
		);

		await expect(resolveConfig({}, values)).rejects.toThrow('none is active');
		await expect(describeConfig(values)).rejects.toThrow('none is active');
		expect((await describeProfiles(values)).currentProfile).toBeUndefined();

		// A per-command profile (or env) still works.
		expect((await resolveConfig({ profile: 'staging' }, values)).profile).toBe('staging');
		values[PROFILE_ENV] = 'prod';
		expect((await resolveConfig({}, values)).profile).toBe('prod');
	});

	test('environment credentials do not require a profile', async () => {
		const values = env();
		await Bun.write(
			configFile(values),
			JSON.stringify({
				version: 2,
				profiles: {
					prod: { url: 'https://prod.example.com', token: 'prod-token' },
					staging: { url: 'https://staging.example.com', token: 'staging-token' },
				},
			}),
		);
		values[URL_ENV] = 'https://ci.example.com';
		values[TOKEN_ENV] = 'ci-token';

		const resolved = await resolveConfig({}, values);
		expect(resolved.url).toBe('https://ci.example.com');
		expect(resolved.token).toBe('ci-token');
		expect(resolved.profile).toBeUndefined();
	});

	test('the flag override wins over the environment', async () => {
		const values = env();
		await addProfile('prod', { url: 'https://prod.example.com', token: 'prod-token' }, {}, values);
		await addProfile(
			'staging',
			{ url: 'https://staging.example.com', token: 'staging-token' },
			{},
			values,
		);
		values[PROFILE_ENV] = 'staging';
		setProfileOverride('prod');

		expect(await effectiveProfile(undefined, values)).toBe('prod');
		expect((await resolveConfig({}, values)).profile).toBe('prod');
	});

	test('use and remove update the active profile', async () => {
		const values = env();
		await addProfile('prod', { url: 'https://prod.example.com', token: 'prod-token' }, {}, values);
		await addProfile(
			'staging',
			{ url: 'https://staging.example.com', token: 'staging-token' },
			{},
			values,
		);

		await useProfile('staging', values);
		expect((await resolveConfig({}, values)).profile).toBe('staging');

		await removeProfile('staging', values);
		expect(await listProfileNames(values)).toEqual(['prod']);
		const report = await describeProfiles(values);
		expect(report.activeProfile).toBe('prod');
		expect(report.currentProfile).toBe('prod');
	});

	test('rejects unknown and malformed profile names', async () => {
		const values = env();
		await addProfile('prod', { url: 'https://prod.example.com', token: 'prod-token' }, {}, values);

		await expect(useProfile('missing', values)).rejects.toThrow('Unknown profile "missing"');
		await expect(resolveConfig({ profile: 'missing' }, values)).rejects.toThrow(
			'Unknown profile "missing"',
		);
		expect(() => normalizeProfileName('bad name')).toThrow('not a valid profile name');
		expect(() => normalizeProfileName('')).toThrow('required');
	});

	test('addProfile refuses duplicates unless forced', async () => {
		const values = env();
		await addProfile('prod', { url: 'https://prod.example.com', token: 'prod-token' }, {}, values);
		await expect(
			addProfile('prod', { url: 'https://other.example.com', token: 'other' }, {}, values),
		).rejects.toThrow('already exists');

		await addProfile(
			'prod',
			{ url: 'https://other.example.com', token: 'other' },
			{ force: true },
			values,
		);
		expect((await readProfile('prod', values))?.url).toBe('https://other.example.com');
	});

	test('keeps tokens and settings isolated per profile', async () => {
		const values = env();
		await addProfile(
			'prod',
			{ url: 'https://prod.example.com', token: 'prod-token', contentDomain: 'prod.example.com' },
			{},
			values,
		);
		await addProfile(
			'staging',
			{
				url: 'https://staging.example.com',
				token: 'staging-token',
				contentDomain: 'staging.example.com',
			},
			{},
			values,
		);

		await clearCredentials(values, 'staging');
		const staging = await readProfile('staging', values);
		expect(staging).toMatchObject({
			url: 'https://staging.example.com',
			contentDomain: 'staging.example.com',
		});
		expect(staging?.token).toBeUndefined();
		expect(await readProfile('prod', values)).toMatchObject({
			url: 'https://prod.example.com',
			token: 'prod-token',
			contentDomain: 'prod.example.com',
		});

		setProfileOverride('staging');
		await setStoredConfigValue('url', 'http://localhost:3000', values);
		expect((await readProfile('staging', values))?.url).toBe('http://localhost:3000');
		expect((await readProfile('prod', values))?.url).toBe('https://prod.example.com');
	});

	test('logout keeps a profile when its URL and domain remain', async () => {
		const values = env();
		await addProfile(
			'prod',
			{ url: 'https://prod.example.com', token: 'prod-token', contentDomain: 'prod.example.com' },
			{},
			values,
		);

		const cleared = await clearCredentials(values, 'prod');
		expect(cleared).toMatchObject({ removed: true, settingsKept: true, profile: 'prod' });
		const stored = await readStoredConfig(values);
		expect(stored).toMatchObject({
			url: 'https://prod.example.com',
			contentDomain: 'prod.example.com',
		});
		expect(stored?.token).toBeUndefined();
	});
});
