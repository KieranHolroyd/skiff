import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	detectPackageManager,
	ensureWrangler,
	findWranglerBinary,
	findWranglerConfig,
	parseJsonc,
	resolveWranglerConfig,
	type WranglerSpawn,
} from './wrangler.ts';

let dir = '';

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-wrangler-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('parseJsonc', () => {
	test('strips line and block comments, trailing commas and a BOM', () => {
		const parsed = parseJsonc(
			`\uFEFF{
				// a line comment
				"name": "demo", // trailing
				/* a block
				   comment */
				"list": [1, 2, /* the last */],
				"nested": { "a": true, },
			}`,
		) as Record<string, unknown>;
		expect(parsed).toEqual({
			name: 'demo',
			list: [1, 2],
			nested: { a: true },
		});
	});

	test('keeps comment-like text and escapes inside strings', () => {
		const parsed = parseJsonc(
			'{"url":"https://example.com/a//b","glob":"/* not a comment */","quote":"a\\" // b"}',
		) as Record<string, string>;
		expect(parsed.url).toBe('https://example.com/a//b');
		expect(parsed.glob).toBe('/* not a comment */');
		expect(parsed.quote).toBe('a" // b');
	});

	test('reports errors with the config filename', () => {
		expect(() => parseJsonc('{ "name": }', 'wrangler.jsonc')).toThrow('wrangler.jsonc:');
		expect(() => parseJsonc('{ /* open', 'wrangler.jsonc')).toThrow('unterminated block comment');
	});
});

describe('findWranglerConfig', () => {
	test('prefers wrangler.jsonc and falls back to wrangler.json', async () => {
		await writeFile(join(dir, 'wrangler.json'), '{}');
		expect(await findWranglerConfig(dir)).toEqual({ path: join(dir, 'wrangler.json'), format: 'json' });

		await writeFile(join(dir, 'wrangler.jsonc'), '{}');
		expect(await findWranglerConfig(dir)).toEqual({ path: join(dir, 'wrangler.jsonc'), format: 'jsonc' });
	});

	test('matches filenames case-sensitively and returns null when absent', async () => {
		await writeFile(join(dir, 'Wrangler.JSONC'), '{}');
		expect(await findWranglerConfig(dir)).toBeNull();
		expect(await findWranglerConfig(join(dir, 'missing'))).toBeNull();
	});

	test('finds a config in a parent directory for a prebuilt deploy root', async () => {
		await writeFile(join(dir, 'wrangler.jsonc'), '{}');
		const nested = join(dir, 'dist', 'server');
		await mkdir(nested, { recursive: true });
		expect(await findWranglerConfig(nested)).toEqual({
			path: join(dir, 'wrangler.jsonc'),
			format: 'jsonc',
		});
	});

	test('rejects wrangler.toml with a pointer to wrangler.jsonc', async () => {
		await writeFile(join(dir, 'wrangler.toml'), 'name = "demo"');
		await expect(findWranglerConfig(dir)).rejects.toThrow(/wrangler\.jsonc/);
	});
});

describe('resolveWranglerConfig', () => {
	test('accepts .jsonc and .json and rejects TOML or other files', async () => {
		const jsonc = join(dir, 'custom.jsonc');
		await writeFile(jsonc, '{}');
		expect(await resolveWranglerConfig(jsonc)).toEqual({ path: jsonc, format: 'jsonc' });

		await expect(resolveWranglerConfig(join(dir, 'wrangler.toml'))).rejects.toThrow(/wrangler\.jsonc/);
		await expect(resolveWranglerConfig(join(dir, 'config.yaml'))).rejects.toThrow('wrangler.jsonc or wrangler.json');
		await expect(resolveWranglerConfig(join(dir, 'missing.jsonc'))).rejects.toThrow('not found');
	});
});

describe('detectPackageManager', () => {
	test('detects each lockfile and falls back to npm for a bare package.json', async () => {
		const project = async (name: string, files: string[]): Promise<string> => {
			const path = join(dir, name);
			await mkdir(path, { recursive: true });
			for (const file of files) await writeFile(join(path, file), '');
			return path;
		};

		expect(await detectPackageManager(await project('bare', ['package.json']))).toBe('npm');
		expect(await detectPackageManager(await project('npm', ['package.json', 'package-lock.json']))).toBe('npm');
		expect(await detectPackageManager(await project('pnpm', ['package.json', 'pnpm-lock.yaml']))).toBe('pnpm');
		expect(await detectPackageManager(await project('yarn', ['package.json', 'yarn.lock']))).toBe('yarn');
		expect(await detectPackageManager(await project('bun', ['package.json', 'bun.lock']))).toBe('bun');
		expect(await detectPackageManager(await project('bunb', ['package.json', 'bun.lockb']))).toBe('bun');
	});

	test('returns null without a package.json', async () => {
		expect(await detectPackageManager(dir)).toBeNull();
	});
});

describe('findWranglerBinary', () => {
	test('walks up to node_modules/.bin and only then consults PATH', async () => {
		const bin = join(dir, 'node_modules', '.bin', 'wrangler');
		await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
		await writeFile(bin, '#!/bin/sh\n');
		await mkdir(join(dir, 'src', 'deep'), { recursive: true });

		let whichCalls = 0;
		const found = await findWranglerBinary(join(dir, 'src', 'deep'), {
			which: async () => {
				whichCalls++;
				return '/usr/local/bin/wrangler';
			},
		});
		expect(found).toBe(bin);
		expect(whichCalls).toBe(0);

		expect(
			await findWranglerBinary(dir, { exists: async () => false, which: async () => '/usr/local/bin/wrangler' }),
		).toBe('/usr/local/bin/wrangler');
		expect(await findWranglerBinary(dir, { exists: async () => false, which: async () => null })).toBeNull();
	});
});

describe('ensureWrangler', () => {
	test('uses an existing local binary and forces CI for the child', async () => {
		const bin = join(dir, 'node_modules', '.bin', 'wrangler');
		await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
		await writeFile(bin, '#!/bin/sh\n');

		const calls: Array<{ command: string; args: string[]; cwd: string; ci: string | undefined }> = [];
		const run: WranglerSpawn = async (command, args, options) => {
			calls.push({ command, args, cwd: options.cwd, ci: options.env?.CI });
			return 7;
		};
		const logs: string[] = [];
		const invoker = await ensureWrangler(dir, {
			run,
			which: async () => null,
			log: (message) => logs.push(message),
		});

		expect(invoker.installed).toBe(true);
		expect(invoker.ephemeral).toBe(false);
		expect(logs.some((line) => line.includes('Using wrangler at node_modules/.bin/wrangler'))).toBe(true);
		expect(await invoker(['--version'])).toBe(7);
		expect(calls).toEqual([{ command: bin, args: ['--version'], cwd: dir, ci: '1' }]);
	});

	test('uses bunx ephemerally when there is no package.json', async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const invoker = await ensureWrangler(dir, {
			run: async (command, args) => {
				calls.push({ command, args });
				return 0;
			},
			which: async (command) => (command === 'bun' ? '/usr/bin/bun' : null),
			log: () => {},
		});

		expect(invoker.ephemeral).toBe(true);
		expect(invoker.installed).toBe(false);
		expect(invoker.display).toBe('bunx wrangler');
		await invoker(['dev']);
		expect(calls).toEqual([{ command: 'bunx', args: ['wrangler', 'dev'] }]);
	});

	test('uses npx --yes ephemerally when bun is unavailable', async () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const invoker = await ensureWrangler(dir, {
			run: async (command, args) => {
				calls.push({ command, args });
				return 0;
			},
			which: async () => null,
			log: () => {},
		});
		expect(invoker.display).toBe('npx --yes wrangler');
		await invoker(['tail']);
		expect(calls).toEqual([{ command: 'npx', args: ['--yes', 'wrangler', 'tail'] }]);
	});

	test('honours --wrangler-bin and reports a missing binary', async () => {
		const bin = join(dir, 'my-wrangler');
		await writeFile(bin, '#!/bin/sh\n');
		const calls: string[] = [];
		const invoker = await ensureWrangler(dir, {
			binary: bin,
			run: async (command) => {
				calls.push(command);
				return 3;
			},
		});
		expect(invoker.command).toBe(bin);
		expect(await invoker(['deploy'])).toBe(3);
		expect(calls).toEqual([bin]);

		await expect(ensureWrangler(dir, { binary: join(dir, 'nope') })).rejects.toThrow('--wrangler-bin');
	});

	const installCases: Array<{
		lock: string;
		manager: string;
		command: string;
		args: string[];
	}> = [
		{ lock: 'bun.lock', manager: 'bun', command: 'bun', args: ['add', '-d', 'wrangler'] },
		{ lock: 'pnpm-lock.yaml', manager: 'pnpm', command: 'pnpm', args: ['add', '-D', 'wrangler'] },
		{ lock: 'yarn.lock', manager: 'yarn', command: 'yarn', args: ['add', '-D', 'wrangler'] },
		{ lock: 'package-lock.json', manager: 'npm', command: 'npm', args: ['install', '--save-dev', 'wrangler'] },
	];

	for (const item of installCases) {
		test(`installs with ${item.manager} as a dev dependency, never globally`, async () => {
			await writeFile(join(dir, 'package.json'), '{}');
			await writeFile(join(dir, item.lock), '');
			const bin = join(dir, 'node_modules', '.bin', 'wrangler');
			const calls: Array<{ command: string; args: string[] }> = [];
			const run: WranglerSpawn = async (command, args) => {
				calls.push({ command, args });
				if (command === item.command) {
					await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
					await writeFile(bin, '#!/bin/sh\n');
				}
				return 0;
			};
			const logs: string[] = [];
			const invoker = await ensureWrangler(dir, {
				run,
				yes: true,
				which: async () => null,
				log: (message) => logs.push(message),
			});

			expect(calls[0]).toEqual({ command: item.command, args: item.args });
			expect(logs.some((line) => line.includes('Installing wrangler as a dev dependency'))).toBe(true);
			expect(invoker.installed).toBe(true);
			expect(invoker.command).toBe(bin);
			await invoker(['deploy']);
			expect(calls[1]).toEqual({ command: bin, args: ['deploy'] });
		});
	}

	test('declining the installation fails without running anything', async () => {
		await writeFile(join(dir, 'package.json'), '{}');
		const calls: string[] = [];
		await expect(
			ensureWrangler(dir, {
				run: async (command) => {
					calls.push(command);
					return 0;
				},
				confirm: async () => false,
				which: async () => null,
			}),
		).rejects.toThrow('wrangler is required');
		expect(calls).toEqual([]);
	});

	test('reports an installation failure instead of continuing', async () => {
		await writeFile(join(dir, 'package.json'), '{}');
		await writeFile(join(dir, 'bun.lock'), '');
		await expect(
			ensureWrangler(dir, {
				run: async () => 1,
				yes: true,
				which: async () => null,
			}),
		).rejects.toThrow('Installing wrangler failed');
	});

	test('yes skips the confirmation prompt', async () => {
		await writeFile(join(dir, 'package.json'), '{}');
		await writeFile(join(dir, 'bun.lock'), '');
		const bin = join(dir, 'node_modules', '.bin', 'wrangler');
		const invoker = await ensureWrangler(dir, {
			run: async (command) => {
				if (command === 'bun') {
					await mkdir(join(dir, 'node_modules', '.bin'), { recursive: true });
					await writeFile(bin, '#!/bin/sh\n');
				}
				return 0;
			},
			yes: true,
			confirm: async () => {
				throw new Error('should not ask');
			},
			which: async () => null,
		});
		expect(invoker.installed).toBe(true);
	});

	test('falls back to a package-manager exec when the installed binary is not at .bin', async () => {
		await writeFile(join(dir, 'package.json'), '{}');
		await writeFile(join(dir, 'bun.lock'), '');
		const calls: Array<{ command: string; args: string[] }> = [];
		const invoker = await ensureWrangler(dir, {
			run: async (command, args) => {
				calls.push({ command, args });
				return 0;
			},
			yes: true,
			which: async () => null,
		});
		expect(invoker.display).toBe('bunx wrangler');
		await invoker(['types']);
		expect(calls.at(-1)).toEqual({ command: 'bunx', args: ['wrangler', 'types'] });
	});
});
