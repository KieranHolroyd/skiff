import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	buildFunctionBundle,
	mapWranglerBindings,
	type BuiltFunctionBundle,
	type ManifestBinding,
} from './function-bundle.ts';
import type { WranglerInvoker } from './wrangler.ts';

let dir = '';
const built: BuiltFunctionBundle[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-fn-'));
	await mkdir(join(dir, 'src'), { recursive: true });
	await mkdir(join(dir, 'public', 'nested'), { recursive: true });
	await writeFile(join(dir, 'public', 'index.html'), '<h1>Hello</h1>');
	await writeFile(join(dir, 'public', 'nested', 'app.js'), 'console.log("asset")');
	await writeFile(join(dir, 'public', '.DS_Store'), 'junk');
});

afterEach(async () => {
	for (const bundle of built.splice(0)) await bundle.cleanup();
	await rm(dir, { recursive: true, force: true });
});

function fakeInvoker(
	files: Record<string, string | Uint8Array>,
	calls: string[][],
	code = 0,
): WranglerInvoker {
	const invoke = (async (args: string[]) => {
		calls.push(args);
		if (code !== 0) return code;
		const outdir = args[args.indexOf('--outdir') + 1]!;
		for (const [name, data] of Object.entries(files)) {
			const path = join(outdir, ...name.split('/'));
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, data);
		}
		return 0;
	}) as WranglerInvoker;
	return Object.assign(invoke, {
		command: '/virtual/wrangler',
		display: '/virtual/wrangler',
		ephemeral: false,
		installed: true,
	});
}

async function build(
	config: unknown,
	options: {
		files?: Record<string, string | Uint8Array>;
		projectSecrets?: string[];
		raw?: string;
		code?: number;
	} = {},
): Promise<{ bundle: BuiltFunctionBundle; calls: string[][] }> {
	const configPath = join(dir, 'wrangler.jsonc');
	await writeFile(configPath, options.raw ?? JSON.stringify(config, null, 2));
	const calls: string[][] = [];
	const bundle = await buildFunctionBundle({
		config: { path: configPath, format: 'jsonc' },
		invoker: fakeInvoker(options.files ?? { 'index.js': 'export default { fetch() {} }' }, calls, options.code),
		projectSecrets: options.projectSecrets,
	});
	built.push(bundle);
	return { bundle, calls };
}

function byName(bindings: ManifestBinding[]): Map<string, ManifestBinding> {
	return new Map(bindings.map((binding) => [binding.name, binding]));
}

const baseConfig = {
	name: 'demo-fn',
	main: 'src/index.ts',
	compatibility_date: '2026-10-01',
};

describe('buildFunctionBundle', () => {
	test('runs wrangler dry-run, copies modules, hashes them and writes the manifest outside the source', async () => {
		const js = 'export default { fetch() { return new Response("hi") } }';
		const { bundle, calls } = await build(
			{
				...baseConfig,
				compatibility_flags: ['nodejs_compat'],
				triggers: { crons: ['*/5 * * * *'] },
			},
			{
				files: {
					'index.js': js,
					'chunk.mjs': 'export const chunk = 1;',
					'legacy.cjs': 'module.exports = {};',
					'mod.wasm': new Uint8Array([0, 97, 115, 109]),
					'notes.txt': 'hello',
					'page.html': '<p>hi</p>',
					'index.js.map': '{"version":3}',
				},
			},
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.slice(0, 2)).toEqual(['deploy', '--dry-run']);
		expect(calls[0]![calls[0]!.indexOf('--config') + 1]).toBe(join(dir, 'wrangler.jsonc'));

		expect(bundle.manifest.version).toBe(1);
		expect(bundle.manifest.main).toBe('index.js');
		expect(bundle.manifest.compatibilityDate).toBe('2026-10-01');
		expect(bundle.manifest.compatibilityFlags).toEqual(['nodejs_compat']);
		expect(bundle.manifest.triggers).toEqual({ crons: ['*/5 * * * *'] });
		expect(bundle.manifest.modules.map((module) => [module.name, module.type])).toEqual([
			['chunk.mjs', 'esm'],
			['index.js', 'esm'],
			['legacy.cjs', 'cjs'],
			['mod.wasm', 'wasm'],
			['notes.txt', 'text'],
			['page.html', 'text'],
		]);
		const indexModule = bundle.manifest.modules.find((module) => module.name === 'index.js')!;
		expect(indexModule.sha256).toBe(createHash('sha256').update(js).digest('hex'));
		expect(bundle.manifest.assets).toBeUndefined();

		const manifestOnDisk = JSON.parse(
			await readFile(join(bundle.dir, 'skiff-function.json'), 'utf8'),
		) as unknown;
		expect(manifestOnDisk).toEqual(bundle.manifest);
		await expect(stat(join(dir, 'skiff-function.json'))).rejects.toThrow();
		expect(await readFile(join(bundle.dir, 'mod.wasm'))).toEqual(Buffer.from([0, 97, 115, 109]));
	});

	test('maps every supported wrangler binding, assets, secrets and skiff overrides', async () => {
		const { bundle } = await build(
			{
				...baseConfig,
				vars: { API_URL: 'https://api.example.com', CONFIG: { a: 1 } },
				kv_namespaces: [{ binding: 'CACHE', id: 'cf-kv-id' }],
				d1_databases: [{ binding: 'DB', database_name: 'app-db', database_id: 'cf-d1-id' }],
				r2_buckets: [{ binding: 'BUCKET', bucket_name: 'uploads', prefix: 'media/' }],
				durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'Room' }] },
				hyperdrive: [{ binding: 'DB_CONN', id: 'cf-hyperdrive-id' }],
				analytics_engine_datasets: [{ binding: 'ANALYTICS', dataset: 'events' }],
				queues: { producers: [{ binding: 'JOBS', queue: 'jobs' }] },
				services: [
					{ binding: 'SELF', service: 'self', entrypoint: 'Api' },
					{ binding: 'WEB', service: 'web' },
				],
				triggers: { crons: ['0 * * * *'] },
				assets: { directory: './public/', run_worker_first: ['/api/*'] },
				skiff: {
					storage: { BUCKET: 'media' },
					hyperdrive: { DB_CONN: 'app-db' },
					secrets: ['EXTRA_KEY'],
					idleStopSeconds: 60,
					memoryMb: 256,
					cpus: 0.5,
					bindings: [{ name: 'API_URL', type: 'text', value: 'https://override.example.com' }],
				},
			},
			{ projectSecrets: ['PROJECT_KEY'] },
		);

		const bindings = byName(bundle.manifest.bindings);
		expect(bindings.get('API_URL')).toEqual({
			name: 'API_URL',
			type: 'text',
			value: 'https://override.example.com',
		});
		expect(bindings.get('CONFIG')).toEqual({ name: 'CONFIG', type: 'json', value: { a: 1 } });
		expect(bindings.get('CACHE')).toEqual({ name: 'CACHE', type: 'kv' });
		expect(bindings.get('DB')).toEqual({ name: 'DB', type: 'd1', database: 'app-db' });
		expect(bindings.get('BUCKET')).toEqual({
			name: 'BUCKET',
			type: 'r2',
			storage: 'media',
			bucket: 'uploads',
			prefix: 'media/',
		});
		expect(bindings.get('ROOMS')).toEqual({ name: 'ROOMS', type: 'durable_object', className: 'Room' });
		expect(bindings.get('DB_CONN')).toEqual({
			name: 'DB_CONN',
			type: 'hyperdrive',
			database: 'app-db',
		});
		expect(bindings.get('ANALYTICS')).toEqual({
			name: 'ANALYTICS',
			type: 'analytics_engine',
			dataset: 'events',
		});
		expect(bindings.get('JOBS')).toEqual({ name: 'JOBS', type: 'queue', queue: 'jobs' });
		expect(bindings.get('SELF')).toEqual({ name: 'SELF', type: 'service', entrypoint: 'Api' });
		expect(bindings.get('WEB')).toEqual({ name: 'WEB', type: 'app', project: 'web' });
		expect(bindings.get('ASSETS')).toEqual({ name: 'ASSETS', type: 'assets' });
		expect(bindings.get('PROJECT_KEY')).toEqual({ name: 'PROJECT_KEY', type: 'secret' });
		expect(bindings.get('EXTRA_KEY')).toEqual({ name: 'EXTRA_KEY', type: 'secret' });

		expect(bundle.manifest.assets).toEqual({ directory: 'public', runWorkerFirst: ['/api/*'] });
		expect(bundle.manifest.triggers).toEqual({ crons: ['0 * * * *'] });
		expect(bundle.manifest.idleStopSeconds).toBe(60);
		expect(bundle.manifest.memoryMb).toBe(256);
		expect(bundle.manifest.cpus).toBe(0.5);

		expect(bundle.assetCount).toBe(2);
		expect(await readFile(join(bundle.dir, 'public', 'index.html'), 'utf8')).toBe('<h1>Hello</h1>');
		await expect(stat(join(bundle.dir, 'public', '.DS_Store'))).rejects.toThrow();
	});

	test('parses JSONC input end to end', async () => {
		const raw = `{
			// Functions config
			"name": "demo-fn",
			"main": "src/index.ts",
			"compatibility_date": "2026-10-01",
			"vars": { "MODE": "prod", },
		}`;
		const { bundle } = await build(undefined, { raw });
		expect(bundle.manifest.bindings).toEqual([{ name: 'MODE', type: 'text', value: 'prod' }]);
		expect(bundle.manifest.main).toBe('index.js');
	});

	test('skiff.run_worker_first true means every path runs the Worker first', async () => {
		const { bundle } = await build({
			...baseConfig,
			assets: { directory: 'public', run_worker_first: true },
		});
		expect(bundle.manifest.assets).toEqual({ directory: 'public', runWorkerFirst: ['/*'] });
	});

	test('requires compatibility_date', async () => {
		await expect(
			build({ name: 'demo', main: 'src/index.ts' }),
		).rejects.toThrow('compatibility_date is required');
	});

	test('selects a single emitted module when main does not name one', async () => {
		const { bundle } = await build(
			{ compatibility_date: '2026-10-01' },
			{ files: { 'worker.js': 'export default {}' } },
		);
		expect(bundle.manifest.main).toBe('worker.js');
	});

	test('uses main to pick between chunks and errors when it is ambiguous', async () => {
		const { bundle } = await build(
			{ main: 'src/api.ts', compatibility_date: '2026-10-01' },
			{ files: { 'api.js': 'export default {}', 'chunk-1.js': 'export const x = 1;' } },
		);
		expect(bundle.manifest.main).toBe('api.js');

		await expect(
			build(
				{ compatibility_date: '2026-10-01' },
				{ files: { 'a.js': 'export default {}', 'b.js': 'export default {}' } },
			),
		).rejects.toThrow('could not tell which wrangler output is the main module');
	});

	test('reports a wrangler failure with its command', async () => {
		await expect(
			build({ ...baseConfig }, { code: 2 }),
		).rejects.toThrow('/virtual/wrangler deploy --dry-run');
	});

	test('reports a missing or empty assets directory', async () => {
		await expect(
			build({ ...baseConfig, assets: { directory: 'missing' } }),
		).rejects.toThrow('assets.directory "missing" was not found');

		await mkdir(join(dir, 'empty'), { recursive: true });
		await expect(
			build({ ...baseConfig, assets: { directory: 'empty' } }),
		).rejects.toThrow('is empty');
	});

	test('rejects unsupported wrangler bindings by name', async () => {
		for (const key of [
			'ai',
			'browser',
			'vectorize',
			'images',
			'send_email',
			'containers',
			'mtls_certificates',
			'dispatch_namespaces',
			'workflows',
		]) {
			await expect(
				build({ ...baseConfig, [key]: {} }),
			).rejects.toThrow(`"${key}" is not supported by Skiff Functions`);
		}
	});
});

describe('mapWranglerBindings', () => {
	test('requires an entrypoint for a self service binding', () => {
		expect(() =>
			mapWranglerBindings(
				{ services: [{ binding: 'SELF', service: 'self' }] },
				{ label: 'wrangler.jsonc' },
			),
		).toThrow('has no entrypoint');
	});

	test('treats a service named after the worker as this worker', () => {
		const { bindings } = mapWranglerBindings(
			{ name: 'demo-fn', services: [{ binding: 'SELF', service: 'demo-fn', entrypoint: 'Api' }] },
			{ label: 'wrangler.jsonc', workerName: 'demo-fn' },
		);
		expect(bindings).toEqual([{ name: 'SELF', type: 'service', entrypoint: 'Api' }]);
	});

	test('falls back to binding names where wrangler has no resource name', () => {
		const { bindings } = mapWranglerBindings(
			{
				d1_databases: [{ binding: 'DB' }],
				hyperdrive: [{ binding: 'PG' }],
				analytics_engine_datasets: [{ binding: 'ANALYTICS' }],
			},
			{ label: 'wrangler.jsonc' },
		);
		expect(bindings).toEqual([
			{ name: 'DB', type: 'd1', database: 'DB' },
			{ name: 'PG', type: 'hyperdrive', database: 'PG' },
			{ name: 'ANALYTICS', type: 'analytics_engine', dataset: 'ANALYTICS' },
		]);
	});

	test('skiff.bindings wins over a generated binding with the same name', () => {
		const { bindings } = mapWranglerBindings(
			{
				vars: { API_KEY: 'plain' },
				skiff: { bindings: [{ name: 'API_KEY', type: 'secret' }] },
			},
			{ label: 'wrangler.jsonc' },
		);
		expect(bindings).toEqual([{ name: 'API_KEY', type: 'secret' }]);
	});
});
