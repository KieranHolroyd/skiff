import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	buildFunctionBundle,
	mapQueueConsumers,
	mapWranglerBindings,
	type BuiltFunctionBundle,
	type ManifestBinding,
} from './function-bundle.ts';

let dir = '';
const built: BuiltFunctionBundle[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'skiff-cli-fn-'));
	await mkdir(join(dir, 'src'), { recursive: true });
	await mkdir(join(dir, 'public', 'nested'), { recursive: true });
	await writeFile(join(dir, 'public', 'index.html'), '<h1>Hello</h1>');
	await writeFile(join(dir, 'public', 'nested', 'app.js'), 'console.log("asset")');
	await writeFile(join(dir, 'public', '.DS_Store'), 'junk');
	await writeFile(join(dir, 'src', 'index.ts'), WORKER_SOURCE);
});

afterEach(async () => {
	for (const bundle of built.splice(0)) await bundle.cleanup();
	await rm(dir, { recursive: true, force: true });
});

const WORKER_SOURCE = 'export default { fetch(): Response { return new Response("ok"); } };\n';

async function writeSource(files: Record<string, string | Uint8Array>): Promise<void> {
	for (const [name, data] of Object.entries(files)) {
		const path = join(dir, ...name.split('/'));
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, data);
	}
}

async function build(
	config: unknown,
	options: {
		files?: Record<string, string | Uint8Array>;
		projectSecrets?: string[];
		raw?: string;
		buildCommands?: Array<{ command: string; cwd: string }>;
		buildExitCode?: number;
	} = {},
): Promise<{ bundle: BuiltFunctionBundle }> {
	const configPath = join(dir, 'wrangler.jsonc');
	await writeFile(configPath, options.raw ?? JSON.stringify(config, null, 2));
	if (options.files) await writeSource(options.files);
	const bundle = await buildFunctionBundle({
		config: { path: configPath, format: 'jsonc' },
		projectSecrets: options.projectSecrets,
		runBuildCommand: async (command, cwd) => {
			options.buildCommands?.push({ command, cwd });
			return options.buildExitCode ?? 0;
		},
	});
	built.push(bundle);
	return { bundle };
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
	test('bundles main with the pinned bundler, splits rule modules out and writes the manifest outside the source', async () => {
		const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
		const { bundle } = await build(
			{
				...baseConfig,
				compatibility_flags: ['nodejs_compat'],
				triggers: { crons: ['*/5 * * * *'] },
			},
			{
				files: {
					'src/index.ts': [
						'import { helper } from "./helper";',
						'import notes from "./notes.txt";',
						'import page from "./page.html";',
						'import blob from "./blob.bin";',
						'import mod from "./mod.wasm";',
						'import { Buffer } from "node:buffer";',
						'import { EventEmitter } from "events";',
						'import { DurableObject } from "cloudflare:workers";',
						'export class Room extends DurableObject {}',
						'export default { fetch(): Response { return new Response(helper() + notes + page + String(blob) + String(mod) + Buffer.from("x") + String(EventEmitter)); } };',
					].join('\n'),
					'src/helper.ts': 'export const helper = (): string => "hi";\n',
					'src/notes.txt': 'hello',
					'src/page.html': '<p>hi</p>',
					'src/blob.bin': new Uint8Array([1, 2, 3]),
					'src/mod.wasm': wasm,
				},
			},
		);

		expect(bundle.manifest.version).toBe(1);
		expect(bundle.manifest.main).toBe('index.js');
		expect(bundle.manifest.compatibilityDate).toBe('2026-10-01');
		expect(bundle.manifest.compatibilityFlags).toEqual(['nodejs_compat']);
		expect(bundle.manifest.triggers).toEqual({ crons: ['*/5 * * * *'], queues: [] });
		const sha1 = (data: string | Uint8Array): string => createHash('sha1').update(data).digest('hex');
		const types = new Map(bundle.manifest.modules.map((module) => [module.name, module.type]));
		expect(types).toEqual(
			new Map([
				['index.js', 'esm'],
				[`${sha1('hello')}-notes.txt`, 'text'],
				[`${sha1('<p>hi</p>')}-page.html`, 'text'],
				[`${sha1(new Uint8Array([1, 2, 3]))}-blob.bin`, 'data'],
				[`${sha1(wasm)}-mod.wasm`, 'wasm'],
			]),
		);

		const code = await readFile(join(bundle.dir, 'index.js'), 'utf8');
		expect(code).toContain('"hi"');
		expect(code).toContain(`from "./${sha1('hello')}-notes.txt"`);
		expect(code).toContain('from "node:buffer"');
		expect(code).toContain('from "node:events"');
		expect(code).toContain('from "cloudflare:workers"');
		expect(code).toMatch(/export\s*\{[^}]*Room/);
		const indexModule = bundle.manifest.modules.find((module) => module.name === 'index.js')!;
		expect(indexModule.sha256).toBe(createHash('sha256').update(code).digest('hex'));
		expect(bundle.manifest.assets).toBeUndefined();

		const manifestOnDisk = JSON.parse(
			await readFile(join(bundle.dir, 'skiff-function.json'), 'utf8'),
		) as unknown;
		expect(manifestOnDisk).toEqual(bundle.manifest);
		await expect(stat(join(dir, 'skiff-function.json'))).rejects.toThrow();
		await expect(stat(join(dir, '.skiff-bundle'))).rejects.toThrow();
		expect(await readFile(join(bundle.dir, `${sha1(wasm)}-mod.wasm`))).toEqual(Buffer.from(wasm));
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
		expect(bundle.manifest.triggers).toEqual({ crons: ['0 * * * *'], queues: [] });
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

	test('requires main', async () => {
		await expect(build({ compatibility_date: '2026-10-01' })).rejects.toThrow('"main" is required');
	});

	test('names the output after the entrypoint', async () => {
		const { bundle } = await build(
			{ main: 'src/api.mjs', compatibility_date: '2026-10-01' },
			{ files: { 'src/api.mjs': 'export default { fetch() { return new Response("api") } }' } },
		);
		expect(bundle.manifest.main).toBe('api.js');
		expect(bundle.manifest.modules.map((module) => module.name)).toEqual(['api.js']);
	});

	test('reports bundling errors with file positions', async () => {
		await expect(
			build(baseConfig, { files: { 'src/index.ts': 'import { x } from "./missing";\nexport default { x };\n' } }),
		).rejects.toThrow(/src\/index\.ts:1:\d+: Could not resolve "\.\/missing"/);
	});

	test('points at nodejs_compat when a Node built-in is imported without it', async () => {
		// From 2026-08-04 workerd implies nodejs_compat, so only an older date can lack it.
		await expect(
			build({ ...baseConfig, compatibility_date: '2026-06-01' }, {
				files: { 'src/index.ts': 'import { readFile } from "node:fs/promises";\nexport default { readFile };\n' },
			}),
		).rejects.toThrow('"compatibility_flags": ["nodejs_compat"]');
	});

	test('refuses service-worker syntax', async () => {
		await expect(
			build(baseConfig, {
				files: { 'src/index.ts': 'addEventListener("fetch", () => {});\n' },
			}),
		).rejects.toThrow('Service-worker syntax');
	});

	test('honours define, minify and custom module rules', async () => {
		const { bundle } = await build(
			{
				...baseConfig,
				define: { __VERSION__: '"1.2.3"' },
				minify: true,
				rules: [{ type: 'Text', globs: ['**/*.md'] }],
			},
			{
				files: {
					'src/index.ts': 'import readme from "./README.md";\ndeclare const __VERSION__: string;\nexport default { fetch() { return new Response(__VERSION__ + readme); } };\n',
					'src/README.md': '# hi',
				},
			},
		);
		const code = await readFile(join(bundle.dir, 'index.js'), 'utf8');
		expect(code).toContain('"1.2.3"');
		expect(code).not.toContain('__VERSION__');
		const readme = bundle.manifest.modules.find((module) => module.name.endsWith('-README.md'));
		expect(readme?.type).toBe('text');
	});

	test('runs build.command before bundling and stops when it fails', async () => {
		const commands: Array<{ command: string; cwd: string }> = [];
		await build({ ...baseConfig, build: { command: 'npm run build', cwd: 'src' } }, { buildCommands: commands });
		expect(commands).toEqual([{ command: 'npm run build', cwd: join(dir, 'src') }]);

		await expect(
			build({ ...baseConfig, build: { command: 'false' } }, { buildExitCode: 3 }),
		).rejects.toThrow('The custom build command failed (exit 3): false');
	});

	test('refuses Wrangler options it cannot honour', async () => {
		await expect(build({ ...baseConfig, no_bundle: true })).rejects.toThrow('"no_bundle" is not supported');
		await expect(build({ ...baseConfig, node_compat: true })).rejects.toThrow('"node_compat" is the retired');
		await expect(
			build({ ...baseConfig, rules: [{ type: 'PythonModule', globs: ['**/*.py'] }] }),
		).rejects.toThrow('Python module rules are not needed');
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

describe('queues on managed brokers (D112)', () => {
	test('producers and consumers map from wrangler, with skiff.brokers naming the broker', () => {
		const config = {
			queues: {
				producers: [{ binding: 'JOBS', queue: 'jobs' }, { binding: 'MAIL', queue: 'mail' }],
				consumers: [
					{ queue: 'jobs', max_batch_size: 25, max_batch_timeout: 2, max_retries: 5, retry_delay: 30, dead_letter_queue: 'jobs-dlq' },
					{ queue: 'mail' },
				],
			},
			skiff: { brokers: { jobs: 'events' } },
		};
		const { bindings } = mapWranglerBindings(config, { label: 'wrangler.jsonc', workerName: 'w', projectSecrets: [] });
		expect(bindings.find((item) => item.name === 'JOBS')).toEqual({ name: 'JOBS', type: 'queue', queue: 'jobs', broker: 'events' });
		expect(bindings.find((item) => item.name === 'MAIL')).toEqual({ name: 'MAIL', type: 'queue', queue: 'mail' });
		expect(mapQueueConsumers(config, 'wrangler.jsonc', { jobs: 'events' })).toEqual([
			{ queue: 'jobs', broker: 'events', maxBatchSize: 25, maxBatchTimeout: 2, maxRetries: 5, retryDelay: 30, deadLetterQueue: 'jobs-dlq' },
			{ queue: 'mail' },
		]);
	});

	test('consumer settings Skiff cannot honour are refused, not ignored', () => {
		expect(() => mapQueueConsumers({ queues: { consumers: [{ queue: 'jobs', max_concurrency: 4 }] } }, 'w', {})).toThrow(
			/max_concurrency is not supported/,
		);
	});
});
