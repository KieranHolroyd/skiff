import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { FRAMEWORK_PRESETS, detectFramework, githubImportSchema } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

/** Deploy from GitHub and automatic pipeline setup (docs/GITHUB.md §9–§10, D172). */

const dir = mkdtempSync(join(tmpdir(), 'skiff-github-import-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const WEBHOOK_SECRET = 'app-webhook-secret-0123456789';
const INSTALLATION = 7;

const calls: Array<{ method: string; path: string }> = [];
let repositorySelection = 'all';
let tokenCounter = 0;

const repos: Record<string, { default_branch: string; private: boolean; archived?: boolean }> = {
	'Acme/web': { default_branch: 'main', private: true },
	'Acme/api': { default_branch: 'trunk', private: false },
	'Acme/old': { default_branch: 'main', private: false, archived: true },
};
const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const file = (path: string, content?: string) => ({ name: path.split('/').pop(), path, type: 'file', ...(content === undefined ? {} : { content, encoding: 'base64' }) });
const folder = (path: string) => ({ name: path.split('/').pop(), path, type: 'dir' });
/** `owner/repo:path@ref` → contents API answer. */
const contents: Record<string, unknown> = {
	'Acme/web:@main': [file('package.json'), file('bun.lock'), folder('src'), folder('node_modules'), folder('.skiff'), folder('apps')],
	'Acme/web:package.json@main': file('package.json', b64({ name: 'web', devDependencies: { vite: '^6' }, scripts: { build: 'vite build' } })),
	'Acme/web:apps@main': [folder('apps/docs')],
	'Acme/web:apps/docs@main': [file('apps/docs/package.json')],
	'Acme/web:apps/docs/package.json@main': file('apps/docs/package.json', b64({ name: '@acme/docs', dependencies: { astro: '^5' } })),
	'Acme/web:.skiff/workflows@main': [file('.skiff/workflows/ci.yml'), file('.skiff/workflows/README.md')],
	'Acme/api:@trunk': [file('package.json'), file('index.ts')],
	'Acme/api:package.json@trunk': file('package.json', b64({ name: 'api', scripts: { start: 'bun index.ts' }, devDependencies: { '@types/bun': '1' } })),
	[`Acme/api:.skiff/workflows@${'a'.repeat(40)}`]: [file('.skiff/workflows/test.yaml')],
};

const githubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(String(input));
	const method = init?.method ?? 'GET';
	const path = url.pathname;
	calls.push({ method, path: `${path}${url.search}` });
	if (method === 'GET' && path === '/app')
		return Response.json({ id: 42, slug: 'skiff-test', name: 'Skiff test', html_url: 'https://github.com/apps/skiff-test', owner: { login: 'Acme' } });
	const installation = {
		id: INSTALLATION,
		account: { login: 'Acme', id: 99, type: 'Organization' },
		repository_selection: repositorySelection,
		permissions: { contents: 'read', metadata: 'read', statuses: 'write' },
		suspended_at: null,
	};
	if (method === 'GET' && path === '/app/installations') return Response.json([installation]);
	if (method === 'POST' && path === `/app/installations/${INSTALLATION}/access_tokens`)
		return Response.json({ token: `ghs_${++tokenCounter}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
	if (method === 'GET' && path === '/installation/repositories')
		return Response.json({
			total_count: 1,
			repositories: [{ id: 1, name: 'web', full_name: 'Acme/web', owner: { login: 'Acme' }, private: true, default_branch: 'main', clone_url: 'https://github.com/Acme/web.git', html_url: 'https://github.com/Acme/web' }],
		});
	const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(?:\/contents(\/.*)?)?$/.exec(path);
	if (method === 'GET' && repoMatch) {
		const key = Object.keys(repos).find((name) => name.toLowerCase() === `${repoMatch[1]}/${repoMatch[2]}`.toLowerCase());
		if (!key) return Response.json({ message: 'Not Found' }, { status: 404 });
		const [owner, name] = key.split('/');
		if (!path.includes('/contents')) {
			const repo = repos[key]!;
			return Response.json({ id: 5, name, full_name: key, owner: { login: owner }, clone_url: `https://github.com/${key}.git`, html_url: `https://github.com/${key}`, ...repo });
		}
		const found = contents[`${key}:${decodeURIComponent(repoMatch[3]?.slice(1) ?? '')}@${url.searchParams.get('ref')}`];
		return found ? Response.json(found) : Response.json({ message: 'Not Found' }, { status: 404 });
	}
	return Response.json({ message: `Not Found: ${method} ${path}` }, { status: 404 });
}) as typeof fetch;

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		githubFetch,
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_1', role: 'owner', platformAdmin: true });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_dep', orgId: 'org_1', role: 'deployer' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_view', orgId: 'org_1', role: 'viewer' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_other', orgId: 'org_2', role: 'owner' });

async function push(fullName: string, payload: Record<string, unknown>) {
	const body = JSON.stringify({ installation: { id: INSTALLATION }, repository: { full_name: fullName }, ...payload });
	return core.githubApp.handleWebhook(body, `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`, 'push');
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	calls.length = 0;
	repositorySelection = 'all';
});

describe('detectFramework', () => {
	test('recognises frameworks from package.json', () => {
		const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: 'x' }) => ({ dependencies: deps, scripts });
		expect(detectFramework({ files: ['package.json'], packageJson: pkg({ next: '15' }) }).id).toBe('nextjs');
		expect(detectFramework({ files: [], packageJson: pkg({ '@sveltejs/kit': '2', '@sveltejs/adapter-static': '3' }) }).id).toBe('sveltekit-static');
		expect(detectFramework({ files: [], packageJson: pkg({ '@sveltejs/kit': '2', '@sveltejs/adapter-node': '5' }) }).id).toBe('sveltekit-node');
		expect(detectFramework({ files: [], packageJson: pkg({ astro: '5', vite: '6' }) }).id).toBe('astro');
		expect(detectFramework({ files: [], packageJson: pkg({ vite: '6' }) })).toEqual(FRAMEWORK_PRESETS.vite);
		expect(detectFramework({ files: [], packageJson: pkg({ 'react-scripts': '5' }) }).outputDir).toBe('build');
		expect(detectFramework({ files: ['bun.lock'], packageJson: pkg({ hono: '4' }, { start: 'bun run index.ts' }) }).id).toBe('bun-server');
		expect(detectFramework({ files: [], packageJson: pkg({ express: '4' }, { start: 'node index.js' }) }).id).toBe('node-server');
		expect(detectFramework({ files: [], packageJson: pkg({ lodash: '4' }) }).id).toBe('other');
	});

	test('recognises sites without package.json', () => {
		expect(detectFramework({ files: ['index.html', 'style.css'], packageJson: null })).toMatchObject({ id: 'static-html', outputDir: '.', buildCommand: 'true' });
		expect(detectFramework({ files: ['hugo.toml', 'content'], packageJson: null }).id).toBe('hugo');
		expect(detectFramework({ files: ['README.md'], packageJson: null }).id).toBe('other');
	});

	test('the import schema keeps directories inside the repository and process-only fields on process apps', () => {
		const base = { repository: 'acme/web', buildCommand: 'bun run build' };
		expect(githubImportSchema.safeParse({ ...base, rootDir: '../x' }).success).toBe(false);
		expect(githubImportSchema.safeParse({ ...base, outputDir: '/etc' }).success).toBe(false);
		expect(githubImportSchema.safeParse({ ...base, command: ['bun', 'x'] }).success).toBe(false);
		expect(githubImportSchema.safeParse({ ...base, runtime: 'process', command: ['bun', 'x'] }).success).toBe(true);
		expect(githubImportSchema.safeParse({ ...base, productionAccess: 'password' }).success).toBe(false);
		expect(githubImportSchema.safeParse({ ...base, repository: 'not a repo' }).success).toBe(false);
	});
});

describe('setup', () => {
	test('an App with one installation, linked to org_1', async () => {
		await core.githubApp.configureManual(owner, { appId: 42, privateKey: PEM, webhookSecret: WEBHOOK_SECRET });
		core.githubApp.linkInstallation(owner, INSTALLATION);
		expect(core.githubApp.installations(owner).map((row) => row.orgId)).toEqual(['org_1']);
	});
});

describe('coverage', () => {
	test('says whether the App delivers a repository’s events, and where to fix it', async () => {
		expect((await core.githubApp.coverage('org_1', 'https://gitlab.com/a/b.git')).status).toBe('not-github');
		expect(await core.githubApp.coverage('org_1', 'https://github.com/acme/web')).toMatchObject({ status: 'covered', installationId: INSTALLATION });
		expect(await core.githubApp.coverage('org_1', 'https://github.com/someone/else')).toMatchObject({
			status: 'not-installed',
			manageUrl: 'https://github.com/apps/skiff-test/installations/new',
		});
		repositorySelection = 'selected';
		await core.githubApp.syncInstallations();
		expect((await core.githubApp.coverage('org_1', 'git@github.com:Acme/web.git')).status).toBe('covered');
		expect(await core.githubApp.coverage('org_1', 'https://github.com/Acme/api')).toMatchObject({
			status: 'not-selected',
			manageUrl: `https://github.com/organizations/Acme/settings/installations/${INSTALLATION}`,
		});
		repositorySelection = 'all';
		await core.githubApp.syncInstallations();
	});
});

describe('detect', () => {
	test('reads the repository through the App and suggests a preset', async () => {
		const detection = await core.githubImport.detect(owner, { repository: 'acme/web' });
		expect(detection).toMatchObject({
			repository: { fullName: 'Acme/web', cloneUrl: 'https://github.com/Acme/web.git', defaultBranch: 'main', private: true },
			branch: 'main',
			rootDir: '.',
			preset: { id: 'vite', outputDir: 'dist', runtime: 'static' },
			directories: ['apps', 'src'],
			workflows: ['ci.yml'],
			hasDockerfile: false,
			suggestedName: 'web',
		});
		// The token used is narrowed to the one repository.
		expect(calls.filter((call) => call.path.startsWith('/repos/')).every((call) => call.path.toLowerCase().startsWith('/repos/acme/web'))).toBe(true);
	});

	test('a monorepo package is detected from its own directory', async () => {
		const detection = await core.githubImport.detect(owner, { repository: 'Acme/web', rootDir: './apps/docs/' });
		expect(detection).toMatchObject({ rootDir: 'apps/docs', preset: { id: 'astro' }, suggestedName: 'docs', workflows: ['ci.yml'] });
	});

	test('refuses what it cannot read', async () => {
		await expect(core.githubImport.detect(owner, { repository: 'Acme/web', rootDir: 'missing' })).rejects.toThrow('no directory "missing"');
		await expect(core.githubImport.detect(owner, { repository: 'Acme/nope' })).rejects.toThrow('cannot reach Acme/nope');
		await expect(core.githubImport.detect(owner, { repository: 'Acme/old' })).rejects.toThrow('archived');
		await expect(core.githubImport.detect(otherOrg, { repository: 'Acme/web' })).rejects.toThrow('cannot reach');
		await expect(core.githubImport.detect(viewer, { repository: 'Acme/web' })).rejects.toThrow();
	});
});

describe('import', () => {
	test('creates the project, its git source, the first build and the pipeline repository', async () => {
		const result = await core.githubImport.importRepository(owner, {
			repository: 'acme/web',
			name: 'Web',
			slug: 'acme-web',
			framework: 'vite',
			buildCommand: 'bun install && bun run build',
			outputDir: 'dist',
		});
		expect(result.project).toMatchObject({ slug: 'acme-web', name: 'Web' });
		expect(result.build?.id).toStartWith('bld_');
		expect(result.pipelineRepository).toBe('web');
		expect(result.warnings).toEqual([]);

		const project = core.projects.requireRow(owner, 'acme-web');
		expect(project.runtime).toBe('static');
		expect(core.builds.gitSource(owner, project)).toMatchObject({
			repoUrl: 'https://github.com/Acme/web.git',
			branch: 'main',
			outputDir: 'dist',
			hasWebhookSecret: false,
			githubAppInstallationId: INSTALLATION,
		});
		expect(core.builds.list(owner, project)[0]).toMatchObject({ id: result.build!.id, status: 'queued', ref: 'main' });
		expect(core.pipelines.getRepository(owner, 'web')).toMatchObject({ cloneUrl: 'https://github.com/Acme/web.git', hasWebhookSecret: false, githubAppInstallationId: INSTALLATION });
	});

	test('importing the same repository again reuses its pipeline repository', async () => {
		opened.sqlite.run("DELETE FROM builds WHERE status IN ('queued','building')");
		const result = await core.githubImport.importRepository(owner, { repository: 'Acme/web', slug: 'acme-web-docs', rootDir: 'apps/docs', buildCommand: 'bun run build', outputDir: 'dist' });
		expect(result.pipelineRepository).toBe('web');
		expect(core.pipelines.listRepositories(owner).map((row) => row.name)).toEqual(['web']);
	});

	test('a process app gets its start command and variables', async () => {
		opened.sqlite.run("DELETE FROM builds WHERE status IN ('queued','building')");
		const result = await core.githubImport.importRepository(owner, {
			repository: 'Acme/api',
			slug: 'acme-api',
			runtime: 'process',
			buildCommand: 'bun install',
			outputDir: '.',
			command: ['bun', 'index.ts'],
			port: 8080,
			env: { NODE_ENV: 'production' },
			pipelines: false,
		});
		expect(result.pipelineRepository).toBeNull();
		const project = core.projects.requireRow(owner, 'acme-api');
		expect(core.workloads.projectSpec(project)).toMatchObject({ runtime: 'process', command: ['bun', 'index.ts'], port: 8080, env: { NODE_ENV: 'production' } });
		expect(core.builds.gitSource(owner, project)?.branch).toBe('trunk');
	});

	test('checks happen before anything is created', async () => {
		await expect(core.githubImport.importRepository(owner, { repository: 'Acme/web', slug: 'acme-web', buildCommand: 'x' })).rejects.toThrow();
		await expect(core.githubImport.importRepository(viewer, { repository: 'Acme/web', slug: 'viewer-web', buildCommand: 'x' })).rejects.toThrow();
		await expect(core.githubImport.importRepository(owner, { repository: 'Acme/nope', slug: 'nope-web', buildCommand: 'x' })).rejects.toThrow('cannot reach');
		expect(core.projects.list(owner).map((row) => row.slug).sort()).toEqual(['acme-api', 'acme-web', 'acme-web-docs']);
	});
});

describe('automatic pipeline setup', () => {
	const sha = 'a'.repeat(40);

	test('a push to a repository with workflows adds it and starts a run', async () => {
		expect(core.pipelines.autoSetup(owner)).toEqual({ enabled: true, ignored: [] });
		const result = await push('Acme/api', {
			ref: 'refs/heads/trunk',
			after: sha,
			commits: [],
			repository: { full_name: 'Acme/api', clone_url: 'https://github.com/Acme/api.git', default_branch: 'trunk' },
		});
		expect(result.triggers).toHaveLength(1);
		const repo = core.pipelines.getRepository(owner, 'api');
		expect(repo).toMatchObject({ cloneUrl: 'https://github.com/Acme/api.git', defaultBranch: 'trunk', hasWebhookSecret: false });
		const audit = opened.sqlite.query<{ action: string }, []>("SELECT action FROM audit_log WHERE action = 'pipeline.repository.auto_create'").all();
		expect(audit).toHaveLength(1);
	});

	test('a repository without workflows is not added, and is not asked again for a while', async () => {
		const other = 'b'.repeat(40);
		repos['Acme/plain'] = { default_branch: 'main', private: false };
		const first = await push('Acme/plain', { ref: 'refs/heads/main', after: other, commits: [] });
		expect(first.triggers).toEqual([]);
		const asked = calls.filter((call) => call.path.includes('/contents/.skiff/workflows')).length;
		expect(asked).toBe(1);
		await push('Acme/plain', { ref: 'refs/heads/main', after: other, commits: [{ added: ['README.md'] }] });
		expect(calls.filter((call) => call.path.includes('/contents/.skiff/workflows')).length).toBe(1);
		// A push that touches workflows is checked straight away.
		contents[`Acme/plain:.skiff/workflows@${'c'.repeat(40)}`] = [file('.skiff/workflows/ci.yml')];
		const third = await push('Acme/plain', { ref: 'refs/heads/main', after: 'c'.repeat(40), commits: [{ added: ['.skiff/workflows/ci.yml'] }] });
		expect(third.triggers).toHaveLength(1);
		expect(core.pipelines.getRepository(owner, 'plain').cloneUrl).toBe('https://github.com/Acme/plain.git');
	});

	test('a removed repository stays removed until it is added by hand or forgotten', async () => {
		await core.pipelines.deleteRepository(owner, 'api');
		expect(core.pipelines.autoSetup(owner).ignored).toEqual(['Acme/api']);
		const again = await push('Acme/api', { ref: 'refs/heads/trunk', after: sha, commits: [{ added: ['.skiff/workflows/test.yaml'] }] });
		expect(again.triggers).toEqual([]);
		expect(core.pipelines.setAutoSetup(owner, { unignore: 'acme/api' }).ignored).toEqual([]);
		const back = await push('Acme/api', { ref: 'refs/heads/trunk', after: sha, commits: [] });
		expect(back.triggers).toHaveLength(1);
	});

	test('pull requests, deleted branches and a switched-off org add nothing', async () => {
		await core.pipelines.deleteRepository(owner, 'api');
		core.pipelines.setAutoSetup(owner, { unignore: 'Acme/api' });
		const body = JSON.stringify({
			action: 'opened',
			number: 1,
			installation: { id: INSTALLATION },
			repository: { full_name: 'Acme/api' },
			pull_request: { head: { sha, ref: 'x', repo: { full_name: 'evil/api' } }, base: { ref: 'trunk', repo: { full_name: 'Acme/api' } } },
		});
		const pr = await core.githubApp.handleWebhook(body, `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`, 'pull_request');
		expect(pr.triggers).toEqual([]);
		expect((await push('Acme/api', { ref: 'refs/heads/trunk', after: '0'.repeat(40), deleted: true })).triggers).toEqual([]);
		expect(() => core.pipelines.setAutoSetup(deployer, { enabled: false })).toThrow();
		expect(core.pipelines.setAutoSetup(owner, { enabled: false }).enabled).toBe(false);
		expect((await push('Acme/api', { ref: 'refs/heads/trunk', after: sha, commits: [] })).triggers).toEqual([]);
		expect(core.pipelines.listRepositories(owner).map((row) => row.name)).not.toContain('api');
	});
});
