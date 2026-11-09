import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFunctionBundle } from './function-bundle.ts';
import { bundlePythonWorker, isPythonMain, readPythonBuildSettings } from './python-bundler.ts';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'yoal-py-'));
	dirs.push(root);
	for (const [path, content] of Object.entries(files)) {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), content);
	}
	return root;
}

const WRANGLER = JSON.stringify({ name: 'py', main: 'src/entry.py', compatibility_date: '2026-10-01' });

describe('Python Worker bundling (D121)', () => {
	test('detects a .py main', () => {
		expect(isPythonMain({ main: 'src/entry.py' })).toBe(true);
		expect(isPythonMain({ main: 'src/index.ts' })).toBe(false);
	});

	test('collects sources relative to the entry and vendored packages, skipping caches', async () => {
		const root = await project({
			'wrangler.json': WRANGLER,
			'src/entry.py': 'from workers import WorkerEntrypoint\n',
			'src/lib/util.py': 'X = 1\n',
			'src/README.md': 'not shipped',
			'src/__pycache__/entry.cpython-314.pyc': 'x',
			'python_modules/workers/__init__.py': '',
			'python_modules/workers/workflows.js': 'export {}',
			'python_modules/_loader.pth': 'import x',
			'python_modules/workers_runtime_sdk-0.1.0.dist-info/METADATA': 'meta',
			'python_modules/pyvenv.cfg': '',
		});
		const settings = readPythonBuildSettings(JSON.parse(WRANGLER), join(root, 'wrangler.json'));
		const bundle = await bundlePythonWorker(settings);
		expect(bundle.main).toBe('entry.py');
		expect(bundle.modules.map((module) => [module.name, module.type])).toEqual([
			['entry.py', 'python'],
			['lib/util.py', 'python'],
			['python_modules/_loader.pth', 'data'],
			['python_modules/workers/__init__.py', 'python'],
			['python_modules/workers/workflows.js', 'data'],
		]);
		expect(bundle.warnings).toEqual([]);
	});

	test('runs build.command first and warns when nothing is vendored', async () => {
		const root = await project({
			'wrangler.json': '{}',
			'pyproject.toml': '[project]\nname = "py"\n',
			'src/entry.py': '',
		});
		const ran: string[] = [];
		const bundle = await bundlePythonWorker(
			readPythonBuildSettings({ main: 'src/entry.py', build: { command: 'uv run pywrangler sync' } }, join(root, 'wrangler.json')),
			{
				runCommand: async (command, cwd) => {
					ran.push(`${command} @ ${cwd}`);
					return 0;
				},
			},
		);
		expect(ran).toEqual([`uv run pywrangler sync @ ${root}`]);
		expect(bundle.warnings[0]).toContain('pywrangler sync');
	});

	test('a missing entry module and a failed build are CLI errors', async () => {
		const root = await project({ 'wrangler.json': '{}' });
		await expect(
			bundlePythonWorker(readPythonBuildSettings({ main: 'src/entry.py' }, join(root, 'wrangler.json'))),
		).rejects.toThrow(/does not exist/);
		await expect(
			bundlePythonWorker(
				readPythonBuildSettings({ main: 'src/entry.py', build: { command: 'false' } }, join(root, 'wrangler.json')),
				{ runCommand: async () => 1 },
			),
		).rejects.toThrow(/exit 1/);
	});

	test('yoal deploy writes a manifest whose main and modules are Python', async () => {
		const root = await project({
			'wrangler.json': WRANGLER,
			'src/entry.py': 'print(1)\n',
			'python_modules/workers/__init__.py': '',
		});
		const built = await buildFunctionBundle({ config: { path: join(root, 'wrangler.json') } as never });
		try {
			expect(built.manifest.main).toBe('entry.py');
			expect(built.manifest.modules.map((module) => module.type)).toEqual(['python', 'python']);
			expect(built.moduleCount).toBe(2);
		} finally {
			await built.cleanup();
		}
	});
});
