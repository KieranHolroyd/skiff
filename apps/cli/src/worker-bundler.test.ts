import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ESBUILD_VERSION, globToRegExp, nodeCompatEnabled, readBuildSettings } from './worker-bundler.ts';

describe('the pinned bundler', () => {
	test('ESBUILD_VERSION matches the exact esbuild pin in package.json', async () => {
		const pkg = JSON.parse(await readFile(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>;
			scripts?: Record<string, string>;
		};
		// An exact version, not a range: a release must never pick up a new esbuild on its own.
		expect(pkg.dependencies?.esbuild).toBe(ESBUILD_VERSION);
		// The CLI is one bundled file; esbuild's native binary has to stay a real dependency.
		expect(pkg.scripts?.build).toContain('--external esbuild');
	});

	test('the loaded esbuild is the pinned one', async () => {
		const esbuild = await import('esbuild');
		expect(esbuild.version).toBe(ESBUILD_VERSION);
	});
});

describe('globToRegExp', () => {
	test('matches import specifiers the way Wrangler module rules do', () => {
		const text = globToRegExp('**/*.txt');
		expect(text.test('./notes.txt')).toBe(true);
		expect(text.test('../a/b/notes.txt')).toBe(true);
		expect(text.test('notes.txt')).toBe(true);
		expect(text.test('./notes.txt.js')).toBe(false);

		const wasm = globToRegExp('**/*.wasm?module');
		expect(wasm.test('./mod.wasm?module')).toBe(true);
		expect(wasm.test('./mod.wasmXmodule')).toBe(false);

		const flat = globToRegExp('data/*.bin');
		expect(flat.test('data/a.bin')).toBe(true);
		expect(flat.test('data/nested/a.bin')).toBe(false);
	});
});

describe('readBuildSettings', () => {
	const path = '/project/wrangler.jsonc';
	const NONE = { date: '2026-01-01', flags: [] };

	test('resolves paths against the config and applies Wrangler defaults', () => {
		const settings = readBuildSettings(
			{ main: 'src/index.ts', tsconfig: 'tsconfig.worker.json' },
			path,
			{ date: '2026-10-01', flags: ['nodejs_compat'] },
		);
		expect(settings.entry).toBe('/project/src/index.ts');
		expect(settings.projectRoot).toBe('/project');
		expect(settings.tsconfig).toBe('/project/tsconfig.worker.json');
		expect(settings.nodeCompat).toBe(true);
		expect(settings.keepNames).toBe(true);
		expect(settings.minify).toBe(false);
		expect(settings.rules.map((rule) => rule.type)).toEqual(['Text', 'Data', 'CompiledWasm']);
	});

	test('a config rule replaces the default of its type unless it falls through', () => {
		const replaced = readBuildSettings(
			{ main: 'index.js', rules: [{ type: 'Text', globs: ['**/*.md'] }] },
			path,
			NONE,
		);
		expect(replaced.rules).toEqual([
			{ type: 'Text', globs: ['**/*.md'] },
			{ type: 'Data', globs: ['**/*.bin'] },
			{ type: 'CompiledWasm', globs: ['**/*.wasm', '**/*.wasm?module'] },
		]);

		const kept = readBuildSettings(
			{ main: 'index.js', rules: [{ type: 'Text', globs: ['**/*.md'], fallthrough: true }, { type: 'ESModule', globs: ['**/*.js'] }] },
			path,
			NONE,
		);
		expect(kept.rules.map((rule) => rule.type)).toEqual(['Text', 'Text', 'Data', 'CompiledWasm']);
	});

	test('validates option types', () => {
		expect(() => readBuildSettings({ main: 'a.js', minify: 'yes' }, path, NONE)).toThrow('"minify" must be true or false');
		expect(() => readBuildSettings({ main: 'a.js', define: { A: 1 } }, path, NONE)).toThrow('"define.A" must be a string');
		expect(() => readBuildSettings({ main: 'a.js', build: { command: '' } }, path, NONE)).toThrow(
			'"build.command" must be a non-empty string',
		);
	});
});

describe('nodeCompatEnabled', () => {
	test('follows the flag, the opt-out and workerd\'s 2026-08-04 default', () => {
		expect(nodeCompatEnabled('2025-01-01', ['nodejs_compat'])).toBe(true);
		expect(nodeCompatEnabled('2025-01-01', ['nodejs_compat_v2'])).toBe(true);
		expect(nodeCompatEnabled('2026-08-03', [])).toBe(false);
		expect(nodeCompatEnabled('2026-08-04', [])).toBe(true);
		expect(nodeCompatEnabled('2026-10-01', ['no_nodejs_compat'])).toBe(false);
	});
});
