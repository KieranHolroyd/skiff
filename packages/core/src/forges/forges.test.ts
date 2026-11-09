import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { zipSync } from 'fflate';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { PipelineClaimRequestInput, PipelineJobClaim, PipelineResolveClaim } from '@yoal/contracts';
import { buildPrincipal } from '../orgs.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { headerReader } from '../builds.ts';

/**
 * GitLab, Gitea and Forgejo connections end to end (docs/FORGES.md): connect, hooks created on the
 * forge, pushes and merge requests routed to builds and pipelines, clone credentials, statuses,
 * deployments, Deploy from Git and GitLab CI trusts. The forges are a fake behind `forgeFetch`.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-forges-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');

interface Call {
	method: string;
	url: string;
	headers: Headers;
	body: Record<string, unknown> | null;
}
const calls: Call[] = [];
const hooks: Array<{ id: number; url: string; secret: string; scope: string; path: string }> = [];
let deployTokenAllowed = true;
let deployTokens = 0;

const b64 = (value: string) => Buffer.from(value).toString('base64');

const forgeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(String(input));
	const method = init?.method ?? 'GET';
	const headers = new Headers(init?.headers);
	const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
	calls.push({ method, url: url.toString(), headers, body });
	const path = decodeURIComponent(url.pathname);

	// GitLab (gitlab.test)
	if (url.host === 'gitlab.test') {
		if (headers.get('private-token') !== 'glpat-api-token' && headers.get('private-token') !== 'glpat-clone-only') return Response.json({ message: '401 Unauthorized' }, { status: 401 });
		if (path === '/api/v4/user') return Response.json({ username: headers.get('private-token') === 'glpat-clone-only' ? 'reader' : 'yoal-bot' });
		if (path === '/api/v4/projects' && method === 'GET')
			return Response.json([
				{ id: 11, name: 'api', path_with_namespace: 'acme/platform/api', namespace: { full_path: 'acme/platform' }, visibility: 'private', default_branch: 'main', http_url_to_repo: 'https://gitlab.test/acme/platform/api.git', web_url: 'https://gitlab.test/acme/platform/api', last_activity_at: '2026-11-01T00:00:00Z' },
			]);
		if (path === '/api/v4/projects/acme/platform/api' && method === 'GET')
			return Response.json({ id: 11, name: 'api', path_with_namespace: 'acme/platform/api', visibility: 'private', default_branch: 'main', http_url_to_repo: 'https://gitlab.test/acme/platform/api.git', web_url: 'https://gitlab.test/acme/platform/api' });
		if (path.endsWith('/repository/tree')) {
			const treePath = url.searchParams.get('path') ?? '';
			if (treePath === '') return Response.json([{ name: 'package.json', path: 'package.json', type: 'blob' }, { name: 'src', path: 'src', type: 'tree' }]);
			if (treePath === '.yoal/workflows') return Response.json([{ name: 'ci.yml', path: '.yoal/workflows/ci.yml', type: 'blob' }]);
			return Response.json({ message: '404 Tree Not Found' }, { status: 404 });
		}
		if (path.endsWith('/repository/files/package.json'))
			return Response.json({ content: b64(JSON.stringify({ name: 'api', scripts: { build: 'vite build' }, devDependencies: { vite: '6' } })), encoding: 'base64' });
		const hookMatch = /^\/api\/v4\/(projects|groups)\/(.+)\/hooks(?:\/(\d+))?$/.exec(path);
		if (hookMatch) {
			const scope = hookMatch[1] === 'groups' ? 'namespace' : 'repository';
			if (method === 'GET') return Response.json(hooks.filter((hook) => hook.scope === scope && hook.path === hookMatch[2]).map((hook) => ({ id: hook.id, url: hook.url })));
			if (method === 'POST') {
				const hook = { id: hooks.length + 100, url: String(body?.url), secret: String(body?.token), scope, path: hookMatch[2]! };
				hooks.push(hook);
				return Response.json({ id: hook.id }, { status: 201 });
			}
			if (method === 'DELETE') {
				const index = hooks.findIndex((hook) => String(hook.id) === hookMatch[3]);
				if (index >= 0) hooks.splice(index, 1);
				return new Response(null, { status: 204 });
			}
		}
		if (path.endsWith('/deploy_tokens') && method === 'GET') return Response.json([]);
		if (path.endsWith('/deploy_tokens') && method === 'POST') {
			if (!deployTokenAllowed) return Response.json({ message: '403 Forbidden' }, { status: 403 });
			deployTokens++;
			return Response.json({ id: deployTokens, username: `gitlab+deploy-token-${deployTokens}`, token: `gldt-${deployTokens}` }, { status: 201 });
		}
		if (/\/statuses\/[a-f0-9]{40}$/.test(path)) return Response.json({ id: 1 }, { status: 201 });
		if (path.endsWith('/deployments') && method === 'POST') return Response.json({ id: 77 }, { status: 201 });
	}

	// Forgejo (forgejo.test)
	if (url.host === 'forgejo.test') {
		if (headers.get('authorization') !== 'token fj-api-token') return Response.json({ message: 'token is required' }, { status: 401 });
		if (path === '/api/v1/user') return Response.json({ login: 'yoal-bot' });
		if (path === '/api/v1/user/repos') return Response.json([{ id: 5, name: 'web', full_name: 'acme/web', owner: { login: 'acme' }, private: true, default_branch: 'main', clone_url: 'https://forgejo.test/acme/web.git', html_url: 'https://forgejo.test/acme/web' }]);
		const hookMatch = /^\/api\/v1\/(repos|orgs)\/(.+)\/hooks(?:\/(\d+))?$/.exec(path);
		if (hookMatch) {
			const scope = hookMatch[1] === 'orgs' ? 'namespace' : 'repository';
			if (method === 'GET') return Response.json(hooks.filter((hook) => hook.scope === scope && hook.path === hookMatch[2]).map((hook) => ({ id: hook.id, config: { url: hook.url } })));
			if (method === 'POST') {
				const config = body?.config as { url: string; secret: string };
				const hook = { id: hooks.length + 100, url: config.url, secret: config.secret, scope, path: hookMatch[2]! };
				hooks.push(hook);
				return Response.json({ id: hook.id }, { status: 201 });
			}
		}
		if (path === '/api/v1/repos/acme/new-svc/contents/.yoal/workflows') return Response.json([{ name: 'ci.yaml', path: '.yoal/workflows/ci.yaml', type: 'file' }]);
		if (/\/statuses\/[a-f0-9]{40}$/.test(path)) return Response.json({ id: 1 }, { status: 201 });
	}
	return Response.json({ message: `Not Found: ${method} ${url}` }, { status: 404 });
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
		masterKey: new Uint8Array(32).fill(9),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		forgeFetch,
	},
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_1', role: 'owner', platformAdmin: true });
const owner = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_1', role: 'owner' });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_dep', orgId: 'org_1', role: 'deployer' });
const labels: PipelineClaimRequestInput = { labels: ['linux', 'x64'], capacity: 1, isolation: 'sandbox' };

let gitlabId = '';
let forgejoId = '';
let builderNodeId = '';

function hookFor(path: string, scope = 'repository') {
	const hook = hooks.find((entry) => entry.path === path && entry.scope === scope);
	if (!hook) throw new Error(`no ${scope} hook on ${path}`);
	return hook;
}

async function gitlabDeliver(event: string, payload: unknown, token?: string) {
	const body = JSON.stringify(payload);
	return core.forges.handleWebhook(gitlabId, body, headerReader({ 'x-gitlab-event': event, 'x-gitlab-token': token ?? hookFor('acme/platform/api').secret }));
}

async function forgejoDeliver(event: string, payload: unknown, secret: string) {
	const body = JSON.stringify(payload);
	return core.forges.handleWebhook(forgejoId, body, headerReader({ 'x-forgejo-event': event, 'x-forgejo-signature': createHmac('sha256', secret).update(body).digest('hex') }));
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	calls.length = 0;
});

describe('connections', () => {
	test('a bad token is refused and nothing is stored', async () => {
		await expect(core.forges.create(owner, { kind: 'gitlab', baseUrl: 'https://gitlab.test', token: 'glpat-wrong-token' })).rejects.toMatchObject({ code: 'forge_unauthorized' });
		expect(core.forges.list(owner)).toHaveLength(0);
	});

	test('only owners and admins connect; GitHub is refused', async () => {
		await expect(core.forges.create(deployer, { kind: 'gitlab', baseUrl: 'https://gitlab.test', token: 'glpat-api-token' })).rejects.toMatchObject({ status: 403 });
		await expect(core.forges.create(owner, { kind: 'gitea', baseUrl: 'https://github.com', token: 'whatever-token' })).rejects.toThrow('GitHub App');
	});

	test('GitLab and Forgejo connect; tokens are proven and never returned', async () => {
		const gitlab = await core.forges.create(owner, { kind: 'gitlab', baseUrl: 'https://gitlab.test/', token: 'glpat-api-token', cloneToken: 'glpat-clone-only' });
		gitlabId = gitlab.id;
		expect(gitlab).toMatchObject({ kind: 'gitlab', baseUrl: 'https://gitlab.test', accountLogin: 'yoal-bot', cloneLogin: 'reader', hasCloneToken: true, webhookUrl: `https://control.test/api/webhooks/forge/${gitlab.id}` });
		expect(JSON.stringify(gitlab)).not.toContain('glpat');
		forgejoId = (await core.forges.create(owner, { kind: 'forgejo', baseUrl: 'https://forgejo.test', token: 'fj-api-token', name: 'Forgejo' })).id;
		await expect(core.forges.create(owner, { kind: 'gitlab', baseUrl: 'https://gitlab.test', token: 'glpat-api-token' })).rejects.toMatchObject({ status: 409 });
	});

	test('pickers list every connection’s repositories', async () => {
		const list = await core.git.repositories(owner);
		expect(list.github).toBe(false);
		expect(list.repositories.map((repo) => `${repo.provider}:${repo.fullName}`)).toEqual(['gitlab:acme/platform/api', 'forgejo:acme/web']);
		expect(list.repositories[0]).toMatchObject({ connectionId: gitlabId, key: 'gitlab.test/acme/platform/api', defaultBranch: 'main' });
	});
});

describe('git builds on GitLab', () => {
	let slug = '';

	test('a git source on a connected forge gets Yoal’s webhook', async () => {
		const project = await core.projects.create(owner, { name: 'api', slug: 'gl-api', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
		slug = project.slug;
		const source = core.builds.upsertGitSource(owner, core.projects.requireRow(owner, slug), {
			repoUrl: 'https://gitlab.test/acme/platform/api.git',
			branch: 'main',
			rootDir: '.',
			buildCommand: 'bun run build',
			outputDir: 'dist',
			webhookSecret: 'hand-made-secret-12345',
			enabled: true,
		});
		await Bun.sleep(20);
		const hook = hookFor('acme/platform/api');
		expect(hook.url).toBe(`https://control.test/api/webhooks/forge/${gitlabId}`);
		expect(core.git.link('org_1', source.repoUrl)).toEqual({ kind: 'gitlab', connectionId: gitlabId, via: 'gitlab.test', delivered: true });
		expect(core.forges.get(owner, gitlabId).webhooks).toMatchObject([{ scope: 'repository', path: 'acme/platform/api', error: null }]);
		const node = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'builder').token, name: 'builder' });
		core.nodes.setBuilder(admin, node.nodeId, true);
		builderNodeId = node.nodeId;
	});

	test('a forged delivery is refused', async () => {
		await expect(gitlabDeliver('Push Hook', { object_kind: 'push' }, 'not-the-secret')).rejects.toMatchObject({ status: 401 });
	});

	test('a push queues a build; the claim carries a deploy token for gitlab.test; statuses use GitLab states', async () => {
		const sha = 'a'.repeat(40);
		const result = await gitlabDeliver('Push Hook', {
			object_kind: 'push',
			ref: 'refs/heads/main',
			after: sha,
			total_commits_count: 1,
			commits: [{ id: sha, message: 'ship it', added: ['x'] }],
			user_username: 'dev',
			project: { path_with_namespace: 'acme/platform/api', git_http_url: 'https://gitlab.test/acme/platform/api.git', default_branch: 'main' },
		});
		expect(result.accepted).toBe(true);
		expect(result.builds).toHaveLength(1);
		const job = await core.builds.claim(builderNodeId);
		expect(job?.commitSha).toBe(sha);
		expect(job?.auth).toEqual({ username: 'gitlab+deploy-token-1', password: 'gldt-1', host: 'gitlab.test' });
		await core.builds.report(builderNodeId, job!.buildId, { status: 'failed', error: 'boom' });
		await Bun.sleep(20);
		const states = calls.filter((call) => call.url.includes(`/statuses/${sha}`)).map((call) => call.body?.state);
		expect(states).toEqual(['pending', 'failed']);
		expect(calls.find((call) => call.url.includes('/statuses/'))!.body).toMatchObject({ name: `yoal-build/${slug}` });
	});

	test('without Maintainer the clone token is used; the deploy token is cached', async () => {
		const cached = await core.git.cloneAuth('org_1', 'https://gitlab.test/acme/platform/api.git');
		expect(cached?.token).toBe('gldt-1');
		deployTokenAllowed = false;
		const other = await core.git.cloneAuth('org_1', 'https://gitlab.test/acme/other.git');
		expect(other).toEqual({ host: 'gitlab.test', username: 'oauth2', token: 'glpat-clone-only' });
		expect(await core.git.cloneAuth('org_1', 'git@gitlab.test:acme/other.git')).toBeNull();
		expect(await core.git.cloneAuth('org_1', 'https://elsewhere.test/acme/other.git')).toBeNull();
		deployTokenAllowed = true;
	});

	test('the project’s hand-made webhook accepts GitLab’s token but is ignored while Yoal’s hook delivers', async () => {
		const project = core.projects.requireRow(owner, slug);
		const body = JSON.stringify({ object_kind: 'push', ref: 'refs/heads/main', after: 'b'.repeat(40), commits: [], project: { path_with_namespace: 'acme/platform/api' } });
		await expect(core.builds.handleWebhook(project, body, headerReader({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'wrong-secret' }))).rejects.toMatchObject({ status: 401 });
		expect(await core.builds.handleWebhook(project, body, headerReader({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'hand-made-secret-12345' }))).toBeNull();
		// Once Yoal's hook is gone, the hand-made one builds.
		opened.sqlite.run('UPDATE forge_webhooks SET hook_id = NULL');
		const build = await core.builds.handleWebhook(project, body, headerReader({ 'x-gitlab-event': 'Push Hook', 'x-gitlab-token': 'hand-made-secret-12345' }));
		expect(build?.commitSha).toBe('b'.repeat(40));
		await core.forges.addWebhook(owner, gitlabId, { repository: 'https://gitlab.test/acme/platform/api.git' });
		expect(core.git.link('org_1', 'https://gitlab.test/acme/platform/api.git').delivered).toBe(true);
		opened.sqlite.run("UPDATE builds SET status = 'cancelled' WHERE status IN ('queued','building')");
	});

	test('a succeeded build records a GitLab deployment', async () => {
		const sha = 'c'.repeat(40);
		await gitlabDeliver('Push Hook', { object_kind: 'push', ref: 'refs/heads/main', after: sha, commits: [], project: { path_with_namespace: 'acme/platform/api' } });
		const job = await core.builds.claim(builderNodeId);
		await store.put(`builds/${job!.buildId}.zip`, zipSync({ 'index.html': new TextEncoder().encode('<h1>ok</h1>') }));
		await core.builds.report(builderNodeId, job!.buildId, { status: 'succeeded' });
		await Bun.sleep(30);
		const deployment = calls.find((call) => call.method === 'POST' && call.url.endsWith('/deployments'));
		expect(deployment?.body).toMatchObject({ environment: slug, sha, ref: 'main', status: 'success' });
	});
});

describe('pipelines on GitLab and Forgejo', () => {
	let nodeId = '';
	const engine = core.pipelines.engine;

	async function drain() {
		let claim = await engine.claim(nodeId, labels);
		while (claim) {
			if (claim.kind === 'job') engine.complete(engine.authenticateJob(claim.token), { conclusion: 'success', outputs: {} });
			else engine.resolveTrigger(engine.authenticateTrigger(claim.token), { sha: claim.sha ?? 'f'.repeat(40), files: [] });
			claim = await engine.claim(nodeId, labels);
		}
	}

	test('setup: a pipeline repository infers its provider', async () => {
		opened.sqlite.run("DELETE FROM builds WHERE status IN ('queued','building')");
		const node = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'ci').token, name: 'ci' });
		core.nodes.setBuilder(admin, node.nodeId, true);
		nodeId = node.nodeId;
		const repo = core.pipelines.createRepository(owner, { name: 'api', cloneUrl: 'https://gitlab.test/acme/platform/api.git', defaultBranch: 'main' });
		expect(repo.provider).toBe('gitlab');
		expect(repo.gitProvider).toMatchObject({ kind: 'gitlab', delivered: true });
	});

	test('a push resolves with the deploy token for gitlab.test', async () => {
		const sha = 'd'.repeat(40);
		const result = await gitlabDeliver('Push Hook', { object_kind: 'push', ref: 'refs/heads/main', after: sha, commits: [], project: { path_with_namespace: 'acme/platform/api' } });
		expect(result.triggers).toHaveLength(1);
		const resolve = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		expect(resolve).toMatchObject({ kind: 'resolve', gitTokenHost: 'gitlab.test', gitTokenUsername: 'gitlab+deploy-token-1', gitToken: 'gldt-1' });
		engine.resolveTrigger(engine.authenticateTrigger(resolve.token), {
			sha,
			files: [{ path: '.yoal/workflows/ci.yml', content: 'name: ci\non: push\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n' }],
		});
		const job = (await engine.claim(nodeId, labels)) as PipelineJobClaim;
		expect(job.gitTokenHost).toBe('gitlab.test');
		expect(job.secretNames).not.toContain('GITHUB_TOKEN');
		await Bun.sleep(20);
		expect(calls.some((call) => call.url.includes(`/statuses/${sha}`) && call.body?.name === 'yoal/ci')).toBe(true);
		await drain();
	});

	test('a merge request from a fork runs untrusted on GitLab’s MR ref', async () => {
		const result = await gitlabDeliver('Merge Request Hook', {
			object_kind: 'merge_request',
			user: { username: 'outsider' },
			project: { path_with_namespace: 'acme/platform/api' },
			object_attributes: { iid: 5, action: 'open', title: 'feat', source_branch: 'feat', target_branch: 'main', last_commit: { id: 'e'.repeat(40) }, source_project_id: 99, target_project_id: 11 },
		});
		expect(result.triggers).toHaveLength(1);
		const resolve = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		expect(resolve.ref).toBe('refs/merge-requests/5/head');
		engine.resolveTrigger(engine.authenticateTrigger(resolve.token), {
			sha: 'e'.repeat(40),
			files: [{ path: '.yoal/workflows/ci.yml', content: 'name: ci\non: pull_request\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n' }],
		});
		const job = (await engine.claim(nodeId, labels)) as PipelineJobClaim;
		expect(job.trust).toBe('untrusted');
		await drain();
	});

	test('a Forgejo organisation hook adds repositories with workflows on push', async () => {
		const hook = await core.forges.addWebhook(owner, forgejoId, { namespace: 'acme' });
		expect(hook).toMatchObject({ scope: 'namespace', path: 'acme', error: null });
		const secret = hookFor('acme', 'namespace').secret;
		const result = await forgejoDeliver(
			'push',
			{ ref: 'refs/heads/main', after: '1'.repeat(40), commits: [], repository: { full_name: 'acme/new-svc', clone_url: 'https://forgejo.test/acme/new-svc.git', default_branch: 'main' } },
			secret,
		);
		expect(result.triggers).toHaveLength(1);
		const created = core.pipelines.listRepositories(owner).find((repo) => repo.cloneUrl === 'https://forgejo.test/acme/new-svc.git');
		expect(created).toMatchObject({ name: 'new-svc', provider: 'forgejo', hasWebhookSecret: false });
		await drain();
		// Removing it puts it on the ignore list under host/full name; the next push does not re-add it.
		await core.pipelines.deleteRepository(owner, 'new-svc');
		expect(core.pipelines.autoSetup(owner).ignored).toContain('forgejo.test/acme/new-svc');
		const again = await forgejoDeliver('push', { ref: 'refs/heads/main', after: '2'.repeat(40), commits: [], repository: { full_name: 'acme/new-svc', clone_url: 'https://forgejo.test/acme/new-svc.git' } }, secret);
		expect(again.triggers).toEqual([]);
		await expect(forgejoDeliver('push', { ref: 'refs/heads/main' }, 'bad')).rejects.toMatchObject({ status: 401 });
	});
});

describe('Deploy from Git', () => {
	test('detects a GitLab repository through the connection and imports it with its pipeline repository', async () => {
		const detection = await core.githubImport.detect(owner, { connectionId: gitlabId, repository: 'acme/platform/api' });
		expect(detection.repository).toMatchObject({ provider: 'gitlab', connectionId: gitlabId, cloneUrl: 'https://gitlab.test/acme/platform/api.git' });
		expect(detection.preset.id).toBe('vite');
		expect(detection.directories).toEqual(['src']);
		expect(detection.workflows).toEqual(['ci.yml']);
		const result = await core.githubImport.importRepository(owner, {
			connectionId: gitlabId,
			repository: 'acme/platform/api',
			name: 'api two',
			slug: 'api-two',
			buildCommand: detection.preset.buildCommand,
			outputDir: detection.preset.outputDir,
		});
		expect(result.project.slug).toBe('api-two');
		// The pipeline repository created earlier names the same repository, so it is reused.
		expect(result.pipelineRepository).toBe('api');
		expect(core.builds.gitSource(owner, core.projects.requireRow(owner, 'api-two'))?.gitProvider).toMatchObject({ kind: 'gitlab', delivered: true });
	});
});

describe('egress', () => {
	const other = createDb({ path: ':memory:' });
	const live: Core = createCore({
		db: other.db,
		sqlite: other.sqlite,
		version: '0.1.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: store,
			masterKey: new Uint8Array(32).fill(9),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
		},
	});
	afterAll(() => other.sqlite.close());

	test('a forge on a private address needs a platform admin', async () => {
		live.forges.resolveHost = async (host) => (host === 'git.home.example' ? ['192.168.0.9'] : ['93.184.216.34']);
		expect(await live.forges.isPrivateHost('https://git.home.example')).toBe(true);
		expect(await live.forges.isPrivateHost('http://127.0.0.1:3000')).toBe(true);
		expect(await live.forges.isPrivateHost('https://gitea.lan')).toBe(true);
		expect(await live.forges.isPrivateHost('https://gitlab.example.org')).toBe(false);
		await expect(live.forges.create(owner, { kind: 'gitea', baseUrl: 'https://git.home.example', token: 'tok-12345678' })).rejects.toMatchObject({
			status: 403,
			message: expect.stringContaining('platform admin'),
		});
		expect(live.forges.list(owner)).toEqual([]);
	});
});

describe('connecting covers what the org already builds', () => {
	test('a git source saved before the forge was connected gets its webhook on connect', async () => {
		await core.forges.remove(owner, forgejoId);
		const project = await core.projects.create(owner, { name: 'legacy', slug: 'legacy', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
		core.builds.upsertGitSource(owner, core.projects.requireRow(owner, project.slug), {
			repoUrl: 'https://forgejo.test/acme/legacy.git',
			branch: 'main',
			rootDir: '.',
			buildCommand: 'bun run build',
			outputDir: 'dist',
			enabled: true,
		});
		expect(core.forges.coverage('org_1', 'https://forgejo.test/acme/legacy.git').status).toBe('no-connection');
		forgejoId = (await core.forges.create(owner, { kind: 'forgejo', baseUrl: 'https://forgejo.test', token: 'fj-api-token' })).id;
		expect(hookFor('acme/legacy').url).toBe(`https://control.test/api/webhooks/forge/${forgejoId}`);
		expect(core.forges.coverage('org_1', 'https://forgejo.test/acme/legacy.git')).toMatchObject({ status: 'covered', connectionId: forgejoId, fullName: 'acme/legacy' });
		expect(core.forges.coverage('org_1', 'https://forgejo.test/acme/other.git').status).toBe('not-hooked');
	});
});
