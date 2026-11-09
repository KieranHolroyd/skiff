import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiError, CliError } from '../errors.ts';
import type { FinalizeOutcome, ProjectCreateInput, ProjectView, SecretView } from '../api.ts';
import { deployCommand, type DeployClient } from './deploy.ts';

let dir = '';
const temps: string[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'yoal-cli-deploy-'));
});

afterEach(async () => {
	for (const temp of temps.splice(0)) await rm(temp, { recursive: true, force: true });
	await rm(dir, { recursive: true, force: true });
});

interface FakeState {
	project: ProjectView | null;
	secrets: SecretView[];
	created: ProjectCreateInput[];
	createUploads: Array<{ project: string; fileCount: number; totalBytes: number }>;
	uploads: Uint8Array[];
	finalized: Array<{ uploadId: string; project: string; promote: boolean; message?: string }>;
	composes: Array<{ project: string; document: string }>;
	listSecretsCalls: number;
	listSecretsError?: Error;
}

function fakeClient(state: FakeState): DeployClient {
	return {
		async getProject(slug) {
			if (!state.project || state.project.slug !== slug)
				throw new ApiError('Project not found.', {
					status: 404,
					method: 'GET',
					url: `http://control/api/v1/projects/${slug}`,
				});
			return { project: state.project, raw: { project: state.project } };
		},
		async createProject(input) {
			state.created.push(input);
			state.project = {
				id: 'prj_1',
				slug: input.slug,
				name: input.name,
				runtime: input.runtime ?? 'static',
			};
			return { project: state.project, raw: { project: state.project } };
		},
		async listSecrets() {
			state.listSecretsCalls++;
			if (state.listSecretsError) throw state.listSecretsError;
			return { secrets: state.secrets, raw: { secrets: state.secrets } };
		},
		async createUpload(input) {
			state.createUploads.push(input);
			return { uploadId: 'up_1', url: 'http://control/upload', method: 'PUT', headers: {} };
		},
		async putUpload(_ticket, bytes) {
			state.uploads.push(bytes);
		},
		async deployCompose(project, input) {
			state.composes.push({ project, document: input.document });
			return {
				deployment: { previewUrl: 'https://compose.example.com' } as never,
				workload: null,
				raw: { ok: true },
			};
		},
		async finalizeUpload(uploadId, input): Promise<FinalizeOutcome> {
			state.finalized.push({ uploadId, ...input });
			return {
				deployment: { id: 'dep_1', url: 'https://demo.example.com', status: 'active' },
				project: state.project ?? undefined,
				nextSteps: [],
				promoted: input.promote,
				deploymentUrl: 'https://demo.example.com',
				raw: { ok: true },
			};
		},
	};
}

const WORKER = 'export default { fetch() { return new Response("ok"); } };\n';

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
	return {
		project: null,
		secrets: [],
		created: [],
		createUploads: [],
		uploads: [],
		finalized: [],
		composes: [],
		listSecretsCalls: 0,
		...overrides,
	};
}

async function projectDir(files: Record<string, string> = {}): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), 'yoal-cli-deploy-project-'));
	temps.push(project);
	for (const [name, contents] of Object.entries(files)) {
		const path = join(project, ...name.split('/'));
		const parent = path.slice(0, path.lastIndexOf('/'));
		if (parent !== project) await mkdir(parent, { recursive: true });
		await writeFile(path, contents);
	}
	return project;
}

describe('yoal deploy with a wrangler project', () => {
	test('creates a function project, bundles with the pinned bundler and uploads the generated manifest', async () => {
		const project = await projectDir({
			'wrangler.jsonc': `{
				// A Functions project
				"name": "hello",
				"main": "src/index.ts",
				"compatibility_date": "2026-10-01",
				"vars": { "MODE": "prod" },
				"assets": { "directory": "public", "run_worker_first": ["/api/*"], },
			}`,
			'public/index.html': '<h1>Hello</h1>',
			'src/index.ts': 'import mod from "./mod.wasm";\nexport default { fetch() { return new Response(String(mod)); } };\n',
			'src/mod.wasm': 'wasm',
		});

		const state = emptyState({
			secrets: [
				{ id: 'sec_1', name: 'API_KEY', projectId: 'prj_1', type: 'secret', version: 1 },
				{ id: 'sec_2', name: 'ORG_KEY', projectId: null, type: 'secret', version: 1 },
			],
		});
		const logs: string[] = [];

		await deployCommand([project, '--project', 'demo-fn', '--message', 'first function'], {
			client: fakeClient(state),
			log: (message) => logs.push(message),
		});

		expect(state.created).toHaveLength(1);
		expect(state.created[0]).toMatchObject({
			slug: 'demo-fn',
			runtime: 'function',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(state.listSecretsCalls).toBe(1);
		expect(logs.some((line) => line.startsWith('Bundling with the yoal bundler (esbuild '))).toBe(true);

		expect(state.uploads).toHaveLength(1);
		const entries = readZip(state.uploads[0]!);
		const wasmModule = `${createHash('sha1').update('wasm').digest('hex')}-mod.wasm`;
		expect([...entries.keys()].sort()).toEqual(
			[wasmModule, 'index.js', 'public/index.html', 'yoal-function.json'].sort(),
		);
		expect(entries.get('index.js')).toContain(`from "./${wasmModule}"`);
		const manifest = JSON.parse(entries.get('yoal-function.json')!) as {
			version: number;
			main: string;
			compatibilityDate: string;
			bindings: Array<Record<string, unknown>>;
			assets: { directory: string; runWorkerFirst: string[] };
		};
		expect(manifest.version).toBe(1);
		expect(manifest.main).toBe('index.js');
		expect(manifest.compatibilityDate).toBe('2026-10-01');
		expect(manifest.assets).toEqual({ directory: 'public', runWorkerFirst: ['/api/*'] });
		expect(manifest.bindings).toContainEqual({ name: 'MODE', type: 'text', value: 'prod' });
		// Project-scoped secrets are auto-bound; org-scoped secrets never are.
		expect(manifest.bindings).toContainEqual({ name: 'API_KEY', type: 'secret' });
		expect(manifest.bindings).not.toContainEqual({ name: 'ORG_KEY', type: 'secret' });

		// The manifest is generated into the temporary bundle, never the user's project.
		await expect(stat(join(project, 'yoal-function.json'))).rejects.toThrow();

		expect(state.finalized).toEqual([
			{ uploadId: 'up_1', project: 'demo-fn', promote: true, message: 'first function' },
		]);
		expect(state.createUploads[0]!.project).toBe('demo-fn');
		expect(logs).toContain('Bundle: 2 module(s), 1 asset file(s) (14 B assets).');
	});

	test('refuses a project with a different runtime', async () => {
		const project = await projectDir({
			'wrangler.jsonc': JSON.stringify({
				name: 'hello',
				main: 'src/index.ts',
				compatibility_date: '2026-10-01',
			}),
			'index.html': '<h1>Hello</h1>',
			'src/index.ts': WORKER,
		});
		const state = emptyState({
			project: { id: 'prj_1', slug: 'demo-fn', runtime: 'static' },
		});

		await expect(
			deployCommand([project, '--project', 'demo-fn'], {
				client: fakeClient(state),
				log: () => {},
			}),
		).rejects.toThrow('uses runtime "static"');
		expect(state.created).toEqual([]);
		expect(state.uploads).toEqual([]);
	});

	test('deploys into an existing function project without creating it', async () => {
		const project = await projectDir({
			'wrangler.jsonc': JSON.stringify({
				name: 'hello',
				main: 'src/index.ts',
				compatibility_date: '2026-10-01',
			}),
			'src/index.ts': WORKER,
		});
		const state = emptyState({
			project: { id: 'prj_1', slug: 'demo-fn', runtime: 'function' },
		});

		await deployCommand([project, '--project', 'demo-fn', '--no-promote'], {
			client: fakeClient(state),
			log: () => {},
		});

		expect(state.created).toEqual([]);
		expect(state.uploads).toHaveLength(1);
		expect(state.finalized[0]!.promote).toBe(false);
		expect(readZip(state.uploads[0]!).has('yoal-function.json')).toBe(true);
	});

	test('static deploy is unchanged', async () => {
		const project = await projectDir({
			'index.html': '<h1>Static</h1>',
			'yoal.json': '{"cleanUrls":true}',
		});
		const state = emptyState();

		await deployCommand([project, '--project', 'demo-site', '--spa'], {
			client: fakeClient(state),
			log: () => {},
		});

		expect(state.created).toHaveLength(1);
		expect(state.created[0]!.runtime).toBeUndefined();
		const entries = readZip(state.uploads[0]!);
		expect([...entries.keys()]).toEqual(['index.html', 'yoal.json']);
		expect(JSON.parse(entries.get('yoal.json')!)).toEqual({ cleanUrls: true, spa: true });
		expect(entries.has('yoal-function.json')).toBe(false);
	});

	test('--no-wrangler deploys the plain directory without a runtime', async () => {
		const project = await projectDir({
			'wrangler.jsonc': '{}',
			'index.html': '<h1>Static</h1>',
		});
		const state = emptyState();

		await deployCommand([project, '--project', 'demo-site', '--no-wrangler'], {
			client: fakeClient(state),
			log: () => {},
		});

		expect(state.created).toHaveLength(1);
		expect(state.created[0]!.runtime).toBeUndefined();
		const entries = readZip(state.uploads[0]!);
		expect([...entries.keys()]).toEqual(['index.html', 'wrangler.jsonc']);
		expect(entries.has('yoal-function.json')).toBe(false);
	});

	test('--wrangler uses an explicit config path', async () => {
		const project = await projectDir({
			'custom.jsonc': JSON.stringify({
				name: 'hello',
				main: 'src/index.ts',
				compatibility_date: '2026-10-01',
			}),
			'src/index.ts': WORKER,
		});
		const state = emptyState();

		await deployCommand([project, '--project', 'demo-fn', '--wrangler', join(project, 'custom.jsonc')], {
			client: fakeClient(state),
			log: () => {},
		});

		expect(state.created[0]!.runtime).toBe('function');
		expect(readZip(state.uploads[0]!).has('yoal-function.json')).toBe(true);
	});

	test('continues with a note when project secrets cannot be listed', async () => {
		const project = await projectDir({
			'wrangler.jsonc': JSON.stringify({
				name: 'hello',
				main: 'src/index.ts',
				compatibility_date: '2026-10-01',
			}),
			'src/index.ts': WORKER,
		});
		const state = emptyState({
			project: { id: 'prj_1', slug: 'demo-fn', runtime: 'function' },
			listSecretsError: new CliError('no permission'),
		});
		const logs: string[] = [];

		await deployCommand([project, '--project', 'demo-fn'], {
			client: fakeClient(state),
			log: (message) => logs.push(message),
		});

		expect(state.uploads).toHaveLength(1);
		expect(logs.some((line) => line.includes('could not list project secrets'))).toBe(true);
	});
});

/** Read names and (inflated) contents from a zip produced by `buildZip`. */
function readZip(zip: Uint8Array): Map<string, string> {
	const buffer = Buffer.from(zip);
	let eocd = -1;
	for (let offset = buffer.length - 22; offset >= 0; offset--) {
		if (buffer.readUInt32LE(offset) === 0x06054b50) {
			eocd = offset;
			break;
		}
	}
	if (eocd === -1) throw new Error('No end-of-central-directory record');

	const count = buffer.readUInt16LE(eocd + 10);
	let central = buffer.readUInt32LE(eocd + 16);
	const out = new Map<string, string>();

	for (let index = 0; index < count; index++) {
		if (buffer.readUInt32LE(central) !== 0x02014b50) throw new Error('Bad central directory record');
		const method = buffer.readUInt16LE(central + 10);
		const compressedSize = buffer.readUInt32LE(central + 20);
		const nameLength = buffer.readUInt16LE(central + 28);
		const extraLength = buffer.readUInt16LE(central + 30);
		const commentLength = buffer.readUInt16LE(central + 32);
		const localOffset = buffer.readUInt32LE(central + 42);
		const name = buffer.toString('utf8', central + 46, central + 46 + nameLength);

		if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Bad local header');
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const payload = buffer.subarray(dataStart, dataStart + compressedSize);
		const data = method === 8 ? inflateRawSync(payload) : payload;
		out.set(name, data.toString('utf8'));

		central += 46 + nameLength + extraLength + commentLength;
	}
	return out;
}

describe('yoal deploy with a compose file', () => {
	test('detects docker-compose.yml, creates a level-4 project and sends the document', async () => {
		const dir = await projectDir({
			'docker-compose.yml': 'services:\n  web:\n    image: nginx:1.27\n    ports: ["80"]\n',
		});
		const state = emptyState();
		await deployCommand([dir, '--json'], { client: fakeClient(state), log: () => {} });
		expect(state.created[0]?.runtime).toBe('compose');
		expect(state.composes).toHaveLength(1);
		expect(state.composes[0]!.document).toContain('nginx:1.27');
		expect(state.createUploads).toHaveLength(0);
		expect(state.finalized).toHaveLength(0);
	});
});
