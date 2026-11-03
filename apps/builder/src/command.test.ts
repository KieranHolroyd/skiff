import { describe, expect, test } from 'bun:test';
import {
	BuildValidationError,
	directRunArgs,
	redactSecret,
	repoUrlWithToken,
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

	test('direct fallback uses the same shell boundary', () => {
		expect(directRunArgs('bun run build')).toEqual(['/bin/bash', '-lc', 'bun run build']);
	});

	test('sanitizes unit names', () => {
		expect(unitName('bld_abc/../def')).toBe('skiff-build-bld_abc-..-def');
	});
});

describe('clone url credentials', () => {
	test('adds a token to https only', () => {
		expect(repoUrlWithToken('https://github.com/acme/app.git', 'tok en')).toBe(
			'https://x-access-token:tok%20en@github.com/acme/app.git',
		);
		expect(repoUrlWithToken('git@github.com:acme/app.git', 'tok')).toBe('git@github.com:acme/app.git');
		expect(repoUrlWithToken('https://github.com/acme/app.git', null)).toBe('https://github.com/acme/app.git');
	});

	test('redacts a token from git output', () => {
		expect(redactSecret('fatal: https://x-access-token:secret@github.com/x failed secret', 'secret')).toBe(
			'fatal: https://***@github.com/x failed ***',
		);
	});
});
