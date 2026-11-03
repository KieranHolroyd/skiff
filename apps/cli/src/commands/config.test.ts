import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir = '';

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-command-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
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

/** Async variant: the sync spawn would block an in-process test server. */
async function runAsync(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], {
		cwd: join(import.meta.dir, '../..'),
		env: childEnv(),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() };
}

function childEnv(): Record<string, string | undefined> {
	return {
		...process.env,
		SKIFF_CONFIG_DIR: dir,
		SKIFF_URL: '',
		SKIFF_TOKEN: '',
		SKIFF_CONTENT_DOMAIN: '',
	};
}

describe('skif config', () => {
	test('sets settings, then reports them as JSON', () => {
		expect(run('config', 'set', 'url', 'control.kieran.dev').code).toBe(0);
		expect(run('config', 'set', 'content-domain', 'kierancloud.dev').code).toBe(0);
		expect(run('config', 'set', 'token', 'sk_test_123456789').code).toBe(0);

		const listed = run('config', 'list', '--json');
		expect(listed.code).toBe(0);
		const payload = JSON.parse(listed.stdout) as {
			stored: boolean;
			settings: Array<{ key: string; value?: string; source: string; secret: boolean }>;
		};
		expect(payload.stored).toBe(true);
		const setting = (key: string) => payload.settings.find((candidate) => candidate.key === key);
		expect(setting('url')).toMatchObject({ value: 'https://control.kieran.dev', source: 'config' });
		expect(setting('contentDomain')).toMatchObject({ value: 'kierancloud.dev', source: 'config' });
		// list masks the key.
		expect(setting('token')?.value).not.toBe('sk_test_123456789');
		expect(setting('token')?.secret).toBe(true);
	});

	test('get prints a value only and unset removes it', () => {
		run('config', 'set', 'contentDomain', 'kierancloud.dev');

		const got = run('config', 'get', 'sites-domain');
		expect(got.code).toBe(0);
		expect(got.stdout).toBe('kierancloud.dev');

		expect(run('config', 'unset', 'contentDomain').code).toBe(0);
		expect(run('config', 'get', 'contentDomain').stdout).toBe('');
	});

	test('logout keeps url and contentDomain, and logout --all removes them', () => {
		run('config', 'set', 'url', 'control.kieran.dev');
		run('config', 'set', 'contentDomain', 'kierancloud.dev');
		run('config', 'set', 'token', 'sk_test_123456789');

		const logout = run('logout', '--json');
		expect(logout.code).toBe(0);
		expect(JSON.parse(logout.stdout)).toMatchObject({
			removed: true,
			settingsKept: true,
		});

		const listed = JSON.parse(run('config', 'list', '--json').stdout) as {
			settings: Array<{ key: string; value?: string }>;
		};
		const setting = (key: string) => listed.settings.find((candidate) => candidate.key === key);
		expect(setting('url')?.value).toBe('https://control.kieran.dev');
		expect(setting('contentDomain')?.value).toBe('kierancloud.dev');
		expect(setting('token')?.value).toBeUndefined();

		expect(run('logout', '--all').code).toBe(0);
		expect(run('config', 'path', '--json').stdout).toContain('"exists": false');
	});

	test('rejects unknown settings and missing values', () => {
		const unknown = run('config', 'set', 'colour', 'blue');
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain('Unknown setting "colour"');

		const missing = run('config', 'set', 'url');
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('Usage: skif config set');
	});

	test('login records the platform and content domain the server reports', async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === '/api/v1/whoami')
					return Response.json({
						user: { id: 'usr_1', email: 'owner@example.com' },
						permissions: [],
						platform: url.origin,
						contentDomain: 'sites.example.com',
					});
				return new Response('not found', { status: 404 });
			},
		});
		const base = `http://127.0.0.1:${server.port}`;
		try {
			const login = await runAsync(
				'login',
				'--url',
				base,
				'--token',
				'sk_test_123456789',
				'--json',
			);
			expect(login.code).toBe(0);
			expect(JSON.parse(login.stdout)).toMatchObject({
				url: base,
				platform: base,
				contentDomain: 'sites.example.com',
			});

			const stored = JSON.parse(await Bun.file(join(dir, 'config.json')).text()) as {
				url?: string;
				token?: string;
				contentDomain?: string;
			};
			expect(stored).toMatchObject({
				url: base,
				token: 'sk_test_123456789',
				contentDomain: 'sites.example.com',
			});

			expect(run('logout').code).toBe(0);
			const afterLogout = JSON.parse(await Bun.file(join(dir, 'config.json')).text()) as {
				url?: string;
				contentDomain?: string;
				token?: string;
			};
			expect(afterLogout.url).toBe(base);
			expect(afterLogout.contentDomain).toBe('sites.example.com');
			expect(afterLogout.token).toBeUndefined();
		} finally {
			server.stop(true);
		}
	});
});
