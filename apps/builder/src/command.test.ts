import { describe, expect, test } from 'bun:test';
import {
	BuildValidationError,
	directRunArgs,
	gitAuthEnv,
	redactSecret,
	validateGitRef,
	safeRelativeDir,
	systemdRunArgs,
	unitName,
	validateBuildCommand,
} from './command.ts';

describe('build command validation', () => {
	test('accepts a normal command and trims edges', () => {
		expect(validateBuildCommand('  bun install && bun run build  ')).toBe('bun install && bun run build');
	});

	test('rejects empty, NUL and overlong commands', () => {
		expect(() => validateBuildCommand('   ')).toThrow(BuildValidationError);
		expect(() => validateBuildCommand('bun\0run')).toThrow(BuildValidationError);
		expect(() => validateBuildCommand('x'.repeat(2049))).toThrow(BuildValidationError);
	});
});

describe('repo-relative directories', () => {
	test('normalizes inside-repository paths', () => {
		expect(safeRelativeDir('.', 'rootDir')).toBe('.');
		expect(safeRelativeDir('apps/web/', 'rootDir')).toBe('apps/web');
		expect(safeRelativeDir('dist', 'outputDir')).toBe('dist');
	});

	test('rejects traversal and absolute paths', () => {
		expect(() => safeRelativeDir('../etc', 'rootDir')).toThrow(BuildValidationError);
		expect(() => safeRelativeDir('/srv', 'rootDir')).toThrow(BuildValidationError);
		expect(() => safeRelativeDir('a//b', 'rootDir')).toThrow(BuildValidationError);
	});
});

describe('systemd argv', () => {
	test('builds a transient unit with the D3 limits', () => {
		expect(
			systemdRunArgs({
				workDir: '/var/lib/skiff-builder/build-abc',
				command: 'bun run build',
				unit: unitName('bld_123'),
			}),
		).toEqual([
			'systemd-run',
			'--quiet',
			'--collect',
			'--pipe',
			'--wait',
			'--unit=skiff-build-bld_123',
			'--property=MemoryMax=2G',
			'--property=CPUQuota=200%',
			'--property=TimeoutStartSec=600',
			'--property=RuntimeMaxSec=600',
			'--working-directory=/var/lib/skiff-builder/build-abc',
			'/bin/bash',
			'-lc',
			'bun run build',
		]);
	});

	test('sandboxes the unit and runs it as the build account when a user is set', () => {
		const argv = systemdRunArgs({
			workDir: '/var/lib/skiff-builder/build-abc/apps/web',
			writableDir: '/var/lib/skiff-builder/build-abc',
			command: 'bun run build',
			unit: unitName('bld_123'),
			user: 'skiff-build',
			env: { HOME: '/var/lib/skiff-builder/build-abc/.home', CI: '1' },
		});
		expect(argv).toContain('--property=User=skiff-build');
		expect(argv).toContain('--property=NoNewPrivileges=yes');
		expect(argv).toContain('--property=ProtectSystem=strict');
		expect(argv).toContain('--property=ReadWritePaths=/var/lib/skiff-builder/build-abc');
		expect(argv).toContain('--property=CapabilityBoundingSet=');
		expect(argv.find((arg) => arg.startsWith('--property=InaccessiblePaths='))).toContain('-/etc/skiff');
		expect(argv).toContain('--setenv=HOME=/var/lib/skiff-builder/build-abc/.home');
		expect(argv).toContain('--setenv=CI=1');
		// The command is still the last argument, after every property.
		expect(argv.slice(-3)).toEqual(['/bin/bash', '-lc', 'bun run build']);
		expect(argv.indexOf('--working-directory=/var/lib/skiff-builder/build-abc/apps/web')).toBe(argv.length - 4);
	});

	test('direct fallback uses the same shell boundary', () => {
		expect(directRunArgs('bun run build')).toEqual(['/bin/bash', '-lc', 'bun run build']);
	});

	test('sanitizes unit names', () => {
		expect(unitName('bld_abc/../def')).toBe('skiff-build-bld_abc-..-def');
	});
});

describe('clone credentials', () => {
	const hosts = ['github.com'];
	const header = `Authorization: Basic ${Buffer.from('x-access-token:tok en').toString('base64')}`;

	test('scopes the token to an allowed https host, through the environment only', () => {
		expect(gitAuthEnv('https://github.com/acme/app.git', 'tok en', hosts)).toEqual({
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
			GIT_CONFIG_VALUE_0: header,
		});
		expect(gitAuthEnv('https://GitHub.com/acme/app.git', 'tok en', hosts).GIT_CONFIG_KEY_0).toBe(
			'http.https://github.com/.extraHeader',
		);
	});

	test('never sends the token to another host, scheme or a URL with its own credentials', () => {
		expect(gitAuthEnv('https://attacker.example/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('https://github.com.attacker.example/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('https://github.com:8443/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('http://github.com/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('git@github.com:acme/app.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('https://me:pw@github.com/x.git', 'tok', hosts)).toEqual({});
		expect(gitAuthEnv('https://github.com/acme/app.git', null, hosts)).toEqual({});
		expect(gitAuthEnv('https://git.corp:8443/x.git', 'tok', ['git.corp:8443']).GIT_CONFIG_KEY_0).toBe(
			'http.https://git.corp:8443/.extraHeader',
		);
	});

	test('rejects refs git would read as options', () => {
		expect(validateGitRef('main')).toBe('main');
		expect(validateGitRef('feature/x-1')).toBe('feature/x-1');
		expect(() => validateGitRef('--upload-pack=touch /tmp/x')).toThrow(BuildValidationError);
		expect(() => validateGitRef('main x')).toThrow(BuildValidationError);
		expect(() => validateGitRef('')).toThrow(BuildValidationError);
	});

	test('redacts a token from git output', () => {
		expect(redactSecret('fatal: https://x-access-token:secret@github.com/x failed secret', 'secret')).toBe(
			'fatal: https://***@github.com/x failed ***',
		);
	});
});
