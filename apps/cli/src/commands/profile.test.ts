import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir = '';

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-profile-command-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function run(
	...args: string[]
): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: childEnv(),
	});
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
}

function runWithEnv(
	extra: Record<string, string>,
	...args: string[]
): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: { ...childEnv(), ...extra },
	});
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
}

function childEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		SKIFF_CONFIG_DIR: dir,
		SKIFF_URL: '',
		SKIFF_TOKEN: '',
		SKIFF_CONTENT_DOMAIN: '',
		SKIFF_PROFILE: '',
	};
}

function json<T>(output: string): T {
	return JSON.parse(output) as T;
}

describe('skif profile', () => {
	test('adds profiles, lists them, and reports the current one', () => {
		const added = run(
			'profile',
			'add',
			'prod',
			'--url',
			'control.example.com',
			'--content-domain',
			'sites.example.com',
			'--token',
			'sk_prod_123456789',
			'--json',
		);
		expect(added.code).toBe(0);
		expect(json(added.stdout)).toMatchObject({ name: 'prod', activeProfile: 'prod' });

		const second = run(
			'profile',
			'add',
			'staging',
			'--url',
			'staging.example.com',
			'--token',
			'sk_staging_987654321',
			'--json',
		);
		expect(second.code).toBe(0);
		expect(json(second.stdout)).toMatchObject({ name: 'staging', activeProfile: 'prod' });

		const listed = json<{
			activeProfile: string;
			currentProfile: string;
			profiles: Array<{ name: string; url?: string; token?: string; current: boolean }>;
		}>(run('profile', 'list', '--json').stdout);
		expect(listed.activeProfile).toBe('prod');
		expect(listed.currentProfile).toBe('prod');
		expect(listed.profiles.map((profile) => profile.name)).toEqual(['prod', 'staging']);
		// Tokens are masked in list output.
		expect(listed.profiles[0]?.token).not.toBe('sk_prod_123456789');
		expect(listed.profiles[0]?.token).toContain('…');

		expect(run('profile', 'current').stdout).toBe('prod');
	});

	test('use switches the active profile and remove falls back to the remainder', () => {
		run('profile', 'add', 'prod', '--url', 'control.example.com', '--token', 'sk_prod_123456789');
		run('profile', 'add', 'staging', '--url', 'staging.example.com', '--token', 'sk_stage_123456789');

		expect(run('profile', 'use', 'staging').code).toBe(0);
		expect(run('profile', 'current').stdout).toBe('staging');

		const removed = run('profile', 'remove', 'staging', '--json');
		expect(removed.code).toBe(0);
		expect(json(removed.stdout)).toMatchObject({ name: 'staging', activeProfile: 'prod' });
		expect(run('profile', 'current').stdout).toBe('prod');
	});

	test('selects a profile per command with --profile and SKIFF_PROFILE', () => {
		run(
			'profile',
			'add',
			'prod',
			'--url',
			'https://prod.example.com',
			'--content-domain',
			'prod.example.com',
			'--token',
			'prod-token',
		);
		run(
			'profile',
			'add',
			'dev',
			'--url',
			'http://localhost:5173',
			'--content-domain',
			'localhost',
			'--token',
			'dev-token',
		);

		expect(run('--profile', 'dev', 'config', 'get', 'url').stdout).toBe('http://localhost:5173');
		expect(run('config', 'get', 'url', '--profile', 'dev').stdout).toBe('http://localhost:5173');
		expect(run('config', 'get', 'url').stdout).toBe('https://prod.example.com');

		const viaEnv = runWithEnv({ SKIFF_PROFILE: 'dev' }, 'config', 'get', 'url');
		expect(viaEnv.stdout).toBe('http://localhost:5173');
	});

	test('does not guess between several profiles when none is active', async () => {
		await Bun.write(
			join(dir, 'config.json'),
			JSON.stringify({
				version: 2,
				profiles: {
					prod: { url: 'https://prod.example.com', token: 'prod-token' },
					staging: { url: 'https://staging.example.com', token: 'staging-token' },
				},
			}),
		);

		const ambiguous = run('config', 'get', 'url');
		expect(ambiguous.code).toBe(1);
		expect(ambiguous.stderr).toContain('none is active');

		expect(run('--profile', 'staging', 'config', 'get', 'url').stdout).toBe(
			'https://staging.example.com',
		);
		expect(run('profile', 'list', '--json').code).toBe(0);

		expect(run('profile', 'use', 'prod').code).toBe(0);
		expect(run('config', 'get', 'url').stdout).toBe('https://prod.example.com');
	});

	test('logout only clears the selected profile', () => {
		run('profile', 'add', 'prod', '--url', 'https://prod.example.com', '--token', 'prod-token');
		run('profile', 'add', 'dev', '--url', 'https://dev.example.com', '--token', 'dev-token');

		expect(run('logout', '--profile', 'dev').code).toBe(0);
		expect(run('--profile', 'prod', 'config', 'get', 'token').stdout).toBe('prod-token');
		expect(run('--profile', 'dev', 'config', 'get', 'token').stdout).toBe('');
	});

	test('validates profile add and unknown profiles', () => {
		const missing = run('profile', 'add', 'dev');
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('Provide --url and/or --token');

		const unknown = run('profile', 'use', 'nope');
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain('Unknown profile "nope"');

		const show = run(
			'profile',
			'add',
			'prod',
			'--url',
			'https://prod.example.com',
			'--token',
			'sk_prod_123456789',
		);
		expect(show.code).toBe(0);
		const shown = run('profile', 'show', 'prod', '--json');
		expect(shown.code).toBe(0);
		const profile = json<{ profile: { token?: string } }>(shown.stdout).profile;
		expect(profile.token).not.toBe('sk_prod_123456789');
		expect(profile.token).toContain('…');
	});
});
