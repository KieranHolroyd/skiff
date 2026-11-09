import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { githubAppManifest, missingPermissions, parseGithubRepoUrl, type PipelineClaimRequestInput, type PipelineJobClaim, type PipelineResolveClaim } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-github-app-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const WEBHOOK_SECRET = 'app-webhook-secret-0123456789';
const INSTALLATION = 7;

interface Call {
	method: string;
	url: string;
	auth: string;
	body: Record<string, unknown> | null;
}
const calls: Call[] = [];
let tokenCounter = 0;
let userInstallations: number[] = [INSTALLATION];
let repositorySelection = 'all';

const installation = () => ({
	id: INSTALLATION,
	account: { login: 'Acme', id: 99, type: 'Organization', avatar_url: 'https://avatars.test/acme' },
	repository_selection: repositorySelection,
	permissions: { contents: 'read', metadata: 'read', statuses: 'write', pull_requests: 'read', deployments: 'write', administration: 'write' },
	suspended_at: null,
});

const githubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input);
	const method = init?.method ?? 'GET';
	const headers = new Headers(init?.headers);
	const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
	calls.push({ method, url, auth: headers.get('authorization') ?? '', body });
	const path = url.replace(/^https:\/\/(api\.)?github\.com/, '');
	if (method === 'GET' && path === '/app')
		return Response.json({ id: 42, slug: 'yoal-test', name: 'Yoal test', html_url: 'https://github.com/apps/yoal-test', owner: { login: 'Acme' }, client_id: 'Iv1.client' });
	if (method === 'POST' && path === '/app-manifests/manifest-code-123/conversions')
		return Response.json(
			{ id: 42, slug: 'yoal-test', name: 'Yoal test', html_url: 'https://github.com/apps/yoal-test', owner: { login: 'Acme' }, pem: PEM, webhook_secret: WEBHOOK_SECRET, client_id: 'Iv1.client', client_secret: 'client-secret-xyz' },
			{ status: 201 },
		);
	if (method === 'GET' && path.startsWith('/app/installations?')) return Response.json([installation()]);
	if (method === 'GET' && path === `/app/installations/${INSTALLATION}`) return Response.json(installation());
	if (method === 'POST' && path === `/app/installations/${INSTALLATION}/access_tokens`) {
		const repositories = body?.repositories as string[] | undefined;
		if (repositories?.includes('private-elsewhere')) return Response.json({ message: 'There is at least one repository that does not exist or is not accessible' }, { status: 422 });
		return Response.json({ token: `ghs_${++tokenCounter}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
	}
	if (method === 'GET' && path.startsWith('/installation/repositories'))
		return Response.json({
			total_count: 2,
			repositories: [
				{ id: 1, name: 'app', full_name: 'Acme/app', owner: { login: 'Acme' }, private: true, default_branch: 'main', clone_url: 'https://github.com/Acme/app.git', html_url: 'https://github.com/Acme/app' },
				{ id: 2, name: 'docs', full_name: 'Acme/docs', owner: { login: 'Acme' }, private: false, default_branch: 'trunk', clone_url: 'https://github.com/Acme/docs.git', html_url: 'https://github.com/Acme/docs' },
			],
		});
	if (method === 'POST' && path === '/login/oauth/access_token') return Response.json({ access_token: 'gho_user' });
	if (method === 'GET' && path.startsWith('/user/installations')) return Response.json({ total_count: userInstallations.length, installations: userInstallations.map((id) => ({ id })) });
	if (method === 'POST' && /\/repos\/[^/]+\/[^/]+\/statuses\//.test(path)) return Response.json({ id: 1 }, { status: 201 });
	if (method === 'POST' && /\/repos\/[^/]+\/[^/]+\/deployments$/.test(path)) return Response.json({ id: 555 }, { status: 201 });
	if (method === 'POST' && /\/deployments\/555\/statuses$/.test(path)) return Response.json({ id: 1 }, { status: 201 });
	if (url.endsWith('/generate-jitconfig'))
		return Response.json({ runner: { id: 900, name: body?.name, status: 'offline', busy: false }, encoded_jit_config: 'jit-900' }, { status: 201 });
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

const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_1', role: 'owner', platformAdmin: true });
const orgOwner = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_1', role: 'owner' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_other', orgId: 'org_2', role: 'owner' });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_dep', orgId: 'org_1', role: 'deployer' });

function sign(body: string, secret = WEBHOOK_SECRET): string {
	return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function deliver(event: string, payload: unknown) {
	const body = JSON.stringify(payload);
	return core.githubApp.handleWebhook(body, sign(body), event);
}

function stateFrom(url: string): string {
	return new URL(url).searchParams.get('state')!;
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	calls.length = 0;
	userInstallations = [INSTALLATION];
	repositorySelection = 'all';
});

describe('contracts', () => {
	test('parses GitHub repository URLs in every common form', () => {
		expect(parseGithubRepoUrl('https://github.com/acme/app.git')).toEqual({ owner: 'acme', repo: 'app' });
		expect(parseGithubRepoUrl('https://github.com/acme/app')).toEqual({ owner: 'acme', repo: 'app' });
		expect(parseGithubRepoUrl('git@github.com:acme/app.git')).toEqual({ owner: 'acme', repo: 'app' });
		expect(parseGithubRepoUrl('ssh://git@github.com/acme/app')).toEqual({ owner: 'acme', repo: 'app' });
		expect(parseGithubRepoUrl('https://gitlab.com/acme/app.git')).toBeNull();
	});

	test('the manifest points every URL at this install and asks for what Yoal uses', () => {
		const manifest = githubAppManifest({ origin: 'https://control.test/', name: 'Yoal', public: false });
		expect(manifest.hook_attributes.url).toBe('https://control.test/api/webhooks/github-app');
		expect(manifest.redirect_url).toBe('https://control.test/settings/github/created');
		expect(manifest.callback_urls[0]).toBe('https://control.test/settings/github/installed');
		expect(manifest.callback_urls).toContain('https://control.test/api/auth/callback/github');
		expect(manifest.default_permissions.contents).toBe('read');
		expect(manifest.default_events).toEqual(['push', 'pull_request']);
	});

	test('missingPermissions flags absent and read-only grants', () => {
		expect(missingPermissions({ contents: 'read', metadata: 'read', statuses: 'read' })).toContain('statuses');
		expect(missingPermissions(installation().permissions)).toEqual(['organization_self_hosted_runners']);
	});
});

describe('app registration', () => {
	test('only a platform admin can start the manifest flow, and the state is bound to them', async () => {
		expect(() => core.githubApp.startManifest(orgOwner, { name: 'Yoal' })).toThrow('platform admin');
		const started = core.githubApp.startManifest(admin, { name: 'Yoal', owner: 'acme' });
		expect(started.postUrl).toStartWith('https://github.com/organizations/acme/settings/apps/new?state=');
		expect(JSON.parse(started.manifest).name).toBe('Yoal');
		const someoneElse = buildPrincipal({ kind: 'user', userId: 'user_x', orgId: 'org_1', role: 'owner', platformAdmin: true });
		await expect(core.githubApp.completeManifest(someoneElse, 'manifest-code-123', started.state)).rejects.toThrow('expired or was started by someone else');
		await expect(core.githubApp.completeManifest(admin, 'manifest-code-123', `${started.state}x`)).rejects.toThrow();

		const view = await core.githubApp.completeManifest(admin, 'manifest-code-123', started.state);
		expect(view).toMatchObject({ configured: true, appId: 42, slug: 'yoal-test', source: 'manifest', signInReady: true });
		expect(view.installUrl).toBe('https://github.com/apps/yoal-test/installations/new');
		expect(core.githubApp.oauthCredentials()).toEqual({ clientId: 'Iv1.client', clientSecret: 'client-secret-xyz' });
		// Secrets are sealed: nothing readable in the settings row.
		const row = opened.sqlite.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'github.app'").get()!;
		expect(row.value).not.toContain('BEGIN RSA PRIVATE KEY');
		expect(row.value).not.toContain(WEBHOOK_SECRET);
		expect(row.value).not.toContain('client-secret-xyz');
		// Non-admins never see the client id.
		expect(core.githubApp.view(orgOwner).clientId).toBeNull();
		expect(() => core.githubApp.startManifest(admin, { name: 'Again' })).toThrow('already connected');
	});

	test('a manual App is checked against GitHub before it is stored', async () => {
		await expect(core.githubApp.configureManual(admin, { appId: 41, privateKey: PEM, webhookSecret: WEBHOOK_SECRET })).rejects.toThrow('different GitHub App');
		const view = await core.githubApp.configureManual(admin, { appId: 42, privateKey: PEM, webhookSecret: WEBHOOK_SECRET });
		expect(view.source).toBe('manual');
		// It synced installations: the one on Acme arrives unclaimed.
		expect(core.githubApp.installations(admin).map((entry) => [entry.id, entry.orgId])).toEqual([[INSTALLATION, null]]);
		expect(core.githubApp.installations(orgOwner)).toEqual([]);
	});
});

describe('webhook', () => {
	test('refuses unsigned or wrongly signed deliveries', async () => {
		const body = JSON.stringify({ zen: 'hi' });
		await expect(core.githubApp.handleWebhook(body, null, 'ping')).rejects.toMatchObject({ status: 401 });
		await expect(core.githubApp.handleWebhook(body, sign(body, 'wrong-secret-0123456789'), 'ping')).rejects.toMatchObject({ status: 401 });
		expect(await core.githubApp.handleWebhook(body, sign(body), 'ping')).toMatchObject({ accepted: true });
	});

	test('a push from an unlinked installation does nothing', async () => {
		const result = await deliver('push', { ref: 'refs/heads/main', after: 'a'.repeat(40), installation: { id: INSTALLATION }, repository: { full_name: 'Acme/app' } });
		expect(result).toMatchObject({ accepted: false, reason: 'installation is not linked to an organisation' });
	});
});

describe('linking installations', () => {
	test('a deployer cannot link; the OAuth check must see the installation', async () => {
		const deployerUrl = core.githubApp.installUrl(deployer)!;
		await expect(core.githubApp.completeInstallation(deployer, { installationId: INSTALLATION, code: 'oauth-code-123', state: stateFrom(deployerUrl) })).rejects.toThrow('owners and admins');
		userInstallations = [8];
		const url = core.githubApp.installUrl(orgOwner)!;
		expect(url).toStartWith('https://github.com/apps/yoal-test/installations/new?state=');
		await expect(core.githubApp.completeInstallation(orgOwner, { installationId: INSTALLATION, code: 'oauth-code-123', state: stateFrom(url) })).rejects.toThrow('cannot see');
		// Without a code only a platform admin may link.
		await expect(core.githubApp.completeInstallation(orgOwner, { installationId: INSTALLATION, state: stateFrom(url) })).rejects.toThrow('platform admin');
		// Without the signed state a non-admin cannot link at all.
		await expect(core.githubApp.completeInstallation(orgOwner, { installationId: INSTALLATION, code: 'oauth-code-123' })).rejects.toThrow('Start the installation');
		// The state is bound to the org it was started from.
		await expect(core.githubApp.completeInstallation(otherOrg, { installationId: INSTALLATION, code: 'oauth-code-123', state: stateFrom(url) })).rejects.toThrow();
	});

	test('an org owner links an installation they can see; another org cannot take it', async () => {
		const url = core.githubApp.installUrl(orgOwner)!;
		const linked = await core.githubApp.completeInstallation(orgOwner, { installationId: INSTALLATION, code: 'oauth-code-123', state: stateFrom(url), setupAction: 'install' });
		expect(linked).toMatchObject({ id: INSTALLATION, orgId: 'org_1', account: { login: 'Acme', type: 'Organization' } });
		expect(linked.settingsUrl).toBe(`https://github.com/organizations/Acme/settings/installations/${INSTALLATION}`);
		const oauth = calls.find((call) => call.url === 'https://github.com/login/oauth/access_token')!;
		expect(oauth.body).toMatchObject({ client_id: 'Iv1.client', code: 'oauth-code-123' });
		expect(core.githubApp.installations(orgOwner).map((entry) => entry.id)).toEqual([INSTALLATION]);

		const otherUrl = core.githubApp.installUrl(otherOrg)!;
		await expect(core.githubApp.completeInstallation(otherOrg, { installationId: INSTALLATION, code: 'oauth-code-123', state: stateFrom(otherUrl) })).rejects.toThrow('another Yoal organisation');
		expect(core.githubApp.installations(otherOrg)).toEqual([]);
	});

	test('lists the installation’s repositories for pickers', async () => {
		const list = await core.githubApp.repositories(orgOwner, { refresh: true });
		expect(list.connected).toBe(true);
		expect(list.repositories.map((repo) => repo.fullName)).toEqual(['Acme/app', 'Acme/docs']);
		expect(list.repositories[1]).toMatchObject({ defaultBranch: 'trunk', private: false, installationId: INSTALLATION });
		expect((await core.githubApp.repositories(otherOrg)).connected).toBe(false);
		expect(core.githubApp.repositoryLink('org_1', 'git@github.com:acme/app.git')).toEqual({ fullName: 'acme/app', installationId: INSTALLATION });
		expect(core.githubApp.repositoryLink('org_2', 'https://github.com/acme/app')).toEqual({ fullName: 'acme/app', installationId: null });
	});

	test('repository tokens are narrowed to one repository and the permissions asked for', async () => {
		const access = await core.githubApp.repoToken('org_1', 'https://github.com/acme/app.git', { contents: 'read' });
		expect(access).toMatchObject({ installationId: INSTALLATION, owner: 'acme', repo: 'app' });
		const minted = calls.find((call) => call.url.endsWith('/access_tokens'))!;
		expect(minted.body).toEqual({ repositories: ['app'], permissions: { contents: 'read' } });
		expect(minted.auth).toStartWith('Bearer ey');
		// Cached: a second request mints nothing.
		calls.length = 0;
		expect((await core.githubApp.repoToken('org_1', 'https://github.com/acme/app', { contents: 'read' }))?.token).toBe(access!.token);
		expect(calls).toHaveLength(0);
		// Not in the installation, not GitHub, or another org: null, never a throw.
		expect(await core.githubApp.repoToken('org_1', 'https://github.com/acme/private-elsewhere', { contents: 'read' })).toBeNull();
		expect(await core.githubApp.repoToken('org_1', 'https://gitlab.com/acme/app', { contents: 'read' })).toBeNull();
		expect(await core.githubApp.repoToken('org_2', 'https://github.com/acme/app', { contents: 'read' })).toBeNull();
	});
});

describe('git builds through the App', () => {
	let builderNodeId = '';
	let slug = '';

	test('setup: a project building Acme/app and a builder node', async () => {
		const created = await core.projects.create(orgOwner, { name: 'site', slug: 'site', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
		slug = created.slug;
		core.builds.upsertGitSource(orgOwner, core.projects.requireRow(orgOwner, slug), {
			repoUrl: 'https://github.com/acme/app.git',
			branch: 'main',
			rootDir: '.',
			buildCommand: 'bun run build',
			outputDir: 'dist',
			webhookSecret: 'project-webhook-secret-123',
			enabled: true,
		});
		const node = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'builder').token, name: 'builder' });
		core.nodes.setBuilder(admin, node.nodeId, true);
		builderNodeId = node.nodeId;
	});

	test('a push queues a build with no project webhook, reports pending, and the claim carries a clone token', async () => {
		const sha = 'b'.repeat(40);
		const result = await deliver('push', {
			ref: 'refs/heads/main',
			after: sha,
			head_commit: { message: 'ship' },
			installation: { id: INSTALLATION },
			repository: { full_name: 'Acme/App' },
		});
		expect(result.accepted).toBe(true);
		expect(result.builds).toHaveLength(1);
		await Bun.sleep(10);
		const status = calls.find((call) => call.url.includes(`/statuses/${sha}`))!;
		expect(status.url).toBe(`https://api.github.com/repos/acme/app/statuses/${sha}`);
		expect(status.body).toMatchObject({ state: 'pending', context: `yoal-build/${slug}` });

		const job = await core.builds.claim(builderNodeId);
		expect(job?.commitSha).toBe(sha);
		expect(job?.auth).toMatchObject({ username: 'x-access-token' });
		expect(job?.auth?.password).toStartWith('ghs_');
		await core.builds.report(builderNodeId, job!.buildId, { status: 'failed', error: 'boom' });
		await Bun.sleep(10);
		expect(calls.filter((call) => call.url.includes(`/statuses/${sha}`)).map((call) => call.body?.state)).toEqual(['pending', 'failure']);
	});

	test('another branch queues nothing', async () => {
		const result = await deliver('push', { ref: 'refs/heads/feature', after: 'c'.repeat(40), installation: { id: INSTALLATION }, repository: { full_name: 'Acme/app' } });
		expect(result).toMatchObject({ accepted: false, builds: [] });
	});

	test('the project’s own webhook is ignored while the App delivers that repository', async () => {
		const project = core.projects.requireRow(orgOwner, slug);
		const body = JSON.stringify({ ref: 'refs/heads/main', after: 'd'.repeat(40), repository: { full_name: 'Acme/app' } });
		expect(await core.builds.handleGithubWebhook(project, body, sign(body, 'project-webhook-secret-123'), 'push')).toBeNull();
		// With a selected-repositories installation that does not list the repository, it still works.
		repositorySelection = 'selected';
		await deliver('installation', { action: 'new_permissions_accepted', installation: { ...installation(), repository_selection: 'selected' } });
		const other = JSON.stringify({ ref: 'refs/heads/main', after: 'e'.repeat(40), repository: { full_name: 'Acme/app-two' } });
		// app-two is not listed by the installation, so the hand-made webhook is the only delivery.
		const build = await core.builds.handleGithubWebhook(project, other, sign(other, 'project-webhook-secret-123'), 'push');
		expect(build?.commitSha).toBe('e'.repeat(40));
	});
});

describe('pipelines through the App', () => {
	const labels: PipelineClaimRequestInput = { labels: ['linux', 'x64'], capacity: 1, isolation: 'sandbox' };
	const engine = core.pipelines.engine;
	let nodeId = '';

	test('setup', () => {
		opened.sqlite.run("DELETE FROM builds WHERE status IN ('queued','building')");
		const node = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'ci').token, name: 'ci' });
		core.nodes.setBuilder(admin, node.nodeId, true);
		nodeId = node.nodeId;
		core.pipelines.createRepository(orgOwner, { name: 'app', cloneUrl: 'https://github.com/acme/app.git', provider: 'github', defaultBranch: 'main' });
	});

	test('a push becomes a trigger; resolve and job claims carry a clone token; trusted jobs get GITHUB_TOKEN', async () => {
		const sha = 'f'.repeat(40);
		const result = await deliver('push', { ref: 'refs/heads/main', after: sha, commits: [], installation: { id: INSTALLATION }, repository: { full_name: 'Acme/app' } });
		expect(result.triggers).toHaveLength(1);
		const resolve = (await engine.claim(nodeId, labels)) as PipelineResolveClaim;
		expect(resolve.kind).toBe('resolve');
		expect(resolve.gitToken).toStartWith('ghs_');
		engine.resolveTrigger(engine.authenticateTrigger(resolve.token), {
			sha,
			files: [{ path: '.yoal/workflows/ci.yml', content: 'name: ci\non: push\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n' }],
		});
		const job = (await engine.claim(nodeId, labels)) as PipelineJobClaim;
		expect(job.kind).toBe('job');
		expect(job.gitToken).toStartWith('ghs_');
		expect(job.secretNames).toContain('GITHUB_TOKEN');
		const secrets = await engine.secrets(engine.authenticateJob(job.token));
		expect(secrets.GITHUB_TOKEN).toStartWith('ghs_');
		const minted = calls.filter((call) => call.url.endsWith('/access_tokens')).map((call) => call.body);
		expect(minted).toContainEqual({ repositories: ['app'], permissions: { contents: 'read', pull_requests: 'read', statuses: 'write' } });
		await Bun.sleep(10);
		expect(calls.some((call) => call.url.includes(`/statuses/${sha}`) && call.body?.context === 'yoal/ci')).toBe(true);
	});

	test('a fork pull request runs untrusted: no GITHUB_TOKEN', async () => {
		const result = await deliver('pull_request', {
			action: 'opened',
			number: 3,
			pull_request: { title: 't', head: { sha: '1'.repeat(40), ref: 'x', repo: { full_name: 'evil/app' } }, base: { ref: 'main', repo: { full_name: 'Acme/app' } } },
			installation: { id: INSTALLATION },
			repository: { full_name: 'Acme/app' },
		});
		expect(result.triggers).toHaveLength(1);
		let claim = await engine.claim(nodeId, labels);
		// Drain any job left from the previous test.
		while (claim && claim.kind === 'job') {
			engine.complete(engine.authenticateJob(claim.token), { conclusion: 'success', outputs: {} });
			claim = await engine.claim(nodeId, labels);
		}
		const resolve = claim as PipelineResolveClaim;
		engine.resolveTrigger(engine.authenticateTrigger(resolve.token), {
			sha: '1'.repeat(40),
			files: [{ path: '.yoal/workflows/ci.yml', content: 'name: ci\non: pull_request\njobs:\n  a: { runs-on: linux, steps: [{ run: echo }] }\n' }],
		});
		const job = (await engine.claim(nodeId, labels)) as PipelineJobClaim;
		expect(job.trust).toBe('untrusted');
		expect(job.secretNames).not.toContain('GITHUB_TOKEN');
		expect(await engine.secrets(engine.authenticateJob(job.token))).toEqual({});
	});
});

describe('unlinking and removal', () => {
	test('unlinking stops tokens; removing the App forgets installations', async () => {
		expect(() => core.githubApp.unlinkInstallation(deployer, INSTALLATION)).toThrow('owners and admins');
		core.githubApp.unlinkInstallation(orgOwner, INSTALLATION);
		expect(core.githubApp.installations(orgOwner)).toEqual([]);
		expect(await core.githubApp.repoToken('org_1', 'https://github.com/acme/app', { contents: 'read' })).toBeNull();
		// A platform admin can link an unclaimed installation directly.
		expect(core.githubApp.linkInstallation(admin, INSTALLATION).orgId).toBe('org_1');
		expect(() => core.githubApp.remove(orgOwner)).toThrow('platform admin');
		core.githubApp.remove(admin);
		expect(core.githubApp.view(admin).configured).toBe(false);
		expect(core.githubApp.installations(admin)).toEqual([]);
	});
});
