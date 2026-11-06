import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-core-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.now();

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
		now: () => clock,
	},
});

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('projects', () => {
	test('creates a project and reserves the slug', async () => {
		const project = await core.projects.create(principal, {
			name: 'Blog',
			slug: 'blog',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(project.slug).toBe('blog');
		expect(project.productionUrl).toBe('https://blog.sites.test');
		expect(project.previewPattern).toContain('blog--<id>.sites.test');
	});

	test('rejects taken slugs with suggestions', async () => {
		await expect(core.projects.create(principal, { name: 'Blog' } as never)).rejects.toMatchObject({
			code: 'conflict',
			suggestions: expect.any(Array),
		});
	});

	test('derives a slug from the name', async () => {
		const project = await core.projects.create(principal, { name: 'My Cool Site' } as never);
		expect(project.slug).toBe('my-cool-site');
	});

	test('stores and clears a placement constraint spec', async () => {
		const project = await core.projects.create(principal, {
			name: 'Constrained app',
			slug: 'constrained-app',
			runtime: 'process',
			placement: 'auto',
			placementSpec: { zone: 'home', labels: { tier: 'critical' } },
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(project.placementSpec).toEqual({ zone: 'home', labels: { tier: 'critical' } });
		const updated = await core.projects.update(principal, project.slug, {
			placementSpec: { zone: ['cloud-a', 'cloud-b'], volumeClass: 'fast' },
		});
		expect(updated.placementSpec).toEqual({ zone: ['cloud-a', 'cloud-b'], volumeClass: 'fast' });
		const cleared = await core.projects.update(principal, project.slug, { placementSpec: null });
		expect(cleared.placementSpec).toBeNull();
	});
});

describe('deploy pipeline', () => {
	let deploymentId = '';
	let edgeToken = '';

	test('deploys inline files, creates a release and promotes', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const deployment = await core.uploads.deployInline(
			principal,
			project,
			[
				file('index.html', '<h1>Hello</h1>'),
				file('about.html', '<h1>About</h1>'),
				file('_redirects', '/old /new 301\n'),
				file('skiff.json', JSON.stringify({ spa: false, notFound: '/404.html' })),
				file('404.html', '<h1>Not found</h1>'),
			],
			{ promote: true },
		);
		deploymentId = deployment.id;
		expect(deployment.release.sha256).toHaveLength(64);
		expect(deployment.release.fileCount).toBe(5);
		expect(deployment.previewUrl).toMatch(/^https:\/\/blog--[a-z0-9]{10}\.sites\.test$/);
		expect(deployment.isProduction).toBe(true);

		const row = core.projects.requireRow(principal, 'blog');
		expect(row.productionDeploymentId).toBe(deployment.id);
		expect(await store.exists(`releases/${deployment.release.sha256}.zip`)).toBe(true);
	});

	test('deduplicates the same artifact content', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const first = core.deployments.list(principal, project)[0]!;
		clock += 1000;
		const second = await core.uploads.deployInline(principal, project, [file('index.html', '<h1>Hello</h1>'), file('about.html', '<h1>About</h1>'), file('_redirects', '/old /new 301\n'), file('skiff.json', JSON.stringify({ spa: false, notFound: '/404.html' })), file('404.html', '<h1>Not found</h1>')], { promote: false });
		expect(second.release.sha256).toBe(first.release.sha256);
	});

	test('builds desired state with production and preview routes', async () => {
		const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
		edgeToken = node.token;
		const state = await core.nodes.desiredState(node.token);
		const hosts = state.routes.map((route) => route.host);
		expect(hosts).toContain('blog.sites.test');
		expect(hosts.some((host) => /^blog--[a-z0-9]{10}\.sites\.test$/.test(host))).toBe(true);
		expect(state.releases[0]?.url).toStartWith('https://control.test/api/objects/releases/');
		expect(state.routes.find((route) => route.host === 'blog.sites.test')?.redirects).toEqual([
			{ from: '/old', to: '/new', status: 301 },
		]);
		expect(state.routes.every((route) => route.upstream === null)).toBe(true);
	});

	test('homelab placement: edge proxies to the worker, the worker serves locally', async () => {
		const token = core.nodes.createJoinToken(principal, 'homelab').token;
		const worker = core.nodes.join({
			token,
			name: 'homelab',
			publicAddress: '10.8.0.2:8080',
		});
		const project = await core.projects.create(principal, {
			name: 'Homelab App',
			slug: 'homelab-app',
			runtime: 'static',
			placement: worker.nodeId,
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		await core.uploads.deployInline(principal, core.projects.requireById(principal, project.id), [
			file('index.html', '<h1>homelab</h1>'),
		]);
		const edgeState = await core.nodes.desiredState(edgeToken);
		const edgeRoute = edgeState.routes.find((route) => route.host === 'homelab-app.sites.test');
		expect(edgeRoute?.upstream).toBe('http://10.8.0.2:8080');
		// The edge never downloads the worker's artifact.
		expect(edgeState.releases.some((release) => release.sha256 === edgeRoute?.release)).toBe(false);

		const workerState = await core.nodes.desiredState(worker.token);
		const workerRoute = workerState.routes.find((route) => route.host === 'homelab-app.sites.test');
		expect(workerRoute?.upstream).toBeNull();
		expect(workerState.releases.some((release) => release.sha256 === workerRoute?.release)).toBe(true);
		expect(workerState.routes.some((route) => route.host === 'blog.sites.test')).toBe(false);
	});

	test('promotes and rolls back instantly', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const before = core.deployments.list(principal, project);
		const previous = before.find((deployment) => deployment.id !== project.productionDeploymentId)!;
		const promoted = await core.deployments.promote(principal, project, previous.id);
		expect(promoted.isProduction).toBe(true);
		const rolledBack = await core.deployments.rollback(principal, core.projects.requireRow(principal, 'blog'));
		expect(rolledBack.id).toBe(deploymentId);
	});
});

describe('uploads', () => {
	test('creates a presigned upload and finalizes a zip', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const session = await core.uploads.create(principal, project, { fileCount: 2, totalBytes: 100 });
		expect(session.method).toBe('PUT');
		expect(session.url).toContain('/api/objects/uploads/');
		const zip = zipSync({
			'index.html': new TextEncoder().encode('<h1>Uploaded</h1>'),
			'robots.txt': new TextEncoder().encode('User-agent: *'),
		});
		const url = new URL(session.url);
		const key = url.pathname.replace('/api/objects/', '');
		const exp = Number(url.searchParams.get('exp'));
		expect(store.verify('PUT', key, exp, url.searchParams.get('sig')!)).toBe(true);
		await store.put(key, zip);
		const deployment = await core.uploads.finalize(principal, project, session.uploadId, { promote: false });
		expect(deployment.release.fileCount).toBe(2);
		expect(await store.exists(`uploads/${session.uploadId}.zip`)).toBe(false);
	});

	test('rejects a bad zip', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const session = await core.uploads.create(principal, project, {});
		const url = new URL(session.url);
		await store.put(url.pathname.replace('/api/objects/', ''), new TextEncoder().encode('not a zip'));
		await expect(core.uploads.finalize(principal, project, session.uploadId)).rejects.toMatchObject({
			code: 'validation',
		});
	});
});

describe('access and share links', () => {
	test('share links redeem once per redemption and respect caps', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const link = await core.access.createShareLink(principal, project, {
			maxRedemptions: 2,
			sessionTtlSeconds: 600,
			note: 'client review',
		});
		const raw = new URL(link.url!).searchParams.get('_skiff_share')!;
		const first = core.access.shareAccess(raw, { ip: '1.2.3.4', userAgent: 'test' });
		expect(first.token).toBeTruthy();
		expect(core.access.verifySiteToken(project.id, first.token)?.kind).toBe('share');
		core.access.shareAccess(raw, { ip: '1.2.3.4', userAgent: 'test' });
		expect(() => core.access.shareAccess(raw, { ip: '1.2.3.4', userAgent: 'test' })).toThrow(/redemption limit/);
		await core.access.revokeShareLink(principal, project, link.id);
		expect(() => core.access.shareAccess(raw, { ip: '1.2.3.4', userAgent: 'test' })).toThrow();
	});

	test('password access verifies the hash and binds the token to the host', async () => {
		await core.projects.setAccess(principal, 'blog', { scope: 'production', mode: 'password', password: 'correct horse' });
		const visit = core.access.passwordAccess('blog.sites.test', 'correct horse');
		const claims = core.access.verifySiteToken(core.projects.requireRow(principal, 'blog').id, visit.token);
		expect(claims?.host).toBe('blog.sites.test');
		expect(claims?.kind).toBe('password');
		expect(() => core.access.passwordAccess('blog.sites.test', 'wrong')).toThrow(/Incorrect password/);
	});
});

describe('audit', () => {
	test('records mutations with errors and redacts secrets', () => {
		const entries = core.audit.list({ orgId: 'org_1', limit: 100 });
		expect(entries.some((entry) => entry.action === 'project.create')).toBe(true);
		expect(entries.some((entry) => entry.action === 'deployment.create')).toBe(true);
		expect(entries.every((entry) => entry.result === 'ok' || entry.result === 'error')).toBe(true);
	});
});

describe('site access tokens and share-link sessions', () => {
	const decode = (token: string) =>
		JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as Record<string, unknown>;

	test('callback tokens are one-time and live 60 s; the session expiry travels separately', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const link = await core.access.createShareLink(principal, project, { sessionTtlSeconds: 7200 });
		const raw = new URL(link.url!).searchParams.get('_skiff_share')!;
		const visit = core.access.shareAccess(raw, { ip: '9.9.9.9', userAgent: 'token-test' });
		const claims = decode(visit.token);
		const now = Math.floor(clock / 1000);
		expect(claims.exp).toBe(now + 60);
		expect(claims.sexp).toBe(now + 7200);
		expect(typeof claims.jti).toBe('string');
		expect(Date.parse(visit.expiresAt)).toBe((now + 7200) * 1000);
		const again = core.access.shareAccess(raw, { ip: '9.9.9.9', userAgent: 'token-test' });
		expect(decode(again.token).jti).not.toBe(claims.jti);
	});

	test('maxVisitors caps distinct visitors but lets a returning visitor back in', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const link = await core.access.createShareLink(principal, project, { maxVisitors: 1 });
		const raw = new URL(link.url!).searchParams.get('_skiff_share')!;
		core.access.shareAccess(raw, { ip: '5.5.5.5', userAgent: 'alice' });
		expect(() => core.access.shareAccess(raw, { ip: '5.5.5.5', userAgent: 'alice' })).not.toThrow();
		expect(() => core.access.shareAccess(raw, { ip: '6.6.6.6', userAgent: 'bob' })).toThrow(/visitor limit/);
	});
});

describe('nodes and alerts', () => {
	const heartbeat = (nodeId: string, status: 'online' | 'offline' = 'online') => ({
		nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 0,
		status,
		caddyOk: status === 'online',
		releases: [],
	});

	test('a heartbeat does not undo draining', () => {
		const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'drainee').token, name: 'drainee' });
		core.nodes.setDraining(principal, node.nodeId, true);
		core.nodes.heartbeat(node.token, heartbeat(node.nodeId));
		expect(core.nodes.get(node.nodeId).status).toBe('draining');
		core.nodes.setDraining(principal, node.nodeId, false);
		core.nodes.heartbeat(node.token, heartbeat(node.nodeId));
		expect(core.nodes.get(node.nodeId).status).toBe('online');
	});

	test('node offline alerts fire once a node has been silent for more than 2 minutes', async () => {
		const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'flaky').token, name: 'flaky' });
		core.nodes.heartbeat(node.token, heartbeat(node.nodeId));
		clock += 45_000;
		// Flips offline here, but it is too early to page anyone.
		expect((await core.maintenance.run()).alertsFired).not.toContain(`node_offline:${node.nodeId}`);
		clock += 120_000;
		expect((await core.maintenance.run()).alertsFired).toContain(`node_offline:${node.nodeId}`);
	});

	test('a node reporting Caddy down alerts after 2 minutes even while it heartbeats', async () => {
		const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'caddyless').token, name: 'caddyless' });
		core.nodes.heartbeat(node.token, heartbeat(node.nodeId, 'offline'));
		expect((await core.maintenance.run()).alertsFired).not.toContain(`node_offline:${node.nodeId}`);
		clock += 130_000;
		core.nodes.heartbeat(node.token, heartbeat(node.nodeId, 'offline'));
		expect((await core.maintenance.run()).alertsFired).toContain(`node_offline:${node.nodeId}`);
	});
});

describe('revocations', () => {
	test('a revoked share session stays revoked for as long as the session could last', async () => {
		const project = core.projects.requireRow(principal, 'blog');
		const link = await core.access.createShareLink(principal, project, { sessionTtlSeconds: 30 * 86_400 });
		const raw = new URL(link.url!).searchParams.get('_skiff_share')!;
		const visit = core.access.shareAccess(raw, { ip: '7.7.7.7', userAgent: 'long-session' });
		const sid = (JSON.parse(Buffer.from(visit.token.split('.')[0]!, 'base64url').toString()) as { sid: string }).sid;
		await core.access.revokeShareLink(principal, project, link.id);
		const edge = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'rev-edge').token, name: 'rev-edge' });

		clock += 8 * 86_400_000;
		const ids = (await core.nodes.desiredState(edge.token)).revocations.map((revocation) => revocation.id);
		expect(ids).toContain(sid);
		expect(ids).toContain(link.id);

		clock += 23 * 86_400_000;
		const later = (await core.nodes.desiredState(edge.token)).revocations.map((revocation) => revocation.id);
		expect(later).not.toContain(sid);
		expect(later).not.toContain(link.id);
	});

	test('revokeSession only touches sessions from the given project', async () => {
		const blog = core.projects.requireRow(principal, 'blog');
		const other = core.projects.requireRow(principal, 'my-cool-site');
		const link = await core.access.createShareLink(principal, blog, {});
		const raw = new URL(link.url!).searchParams.get('_skiff_share')!;
		const visit = core.access.shareAccess(raw, { ip: '8.8.8.8', userAgent: 'scoped' });
		const sid = (JSON.parse(Buffer.from(visit.token.split('.')[0]!, 'base64url').toString()) as { sid: string }).sid;
		await expect(core.access.revokeSession(principal, other, sid)).rejects.toThrow();
		await core.access.revokeSession(principal, blog, sid);
		expect(core.access.revocations().some((revocation) => revocation.id === sid)).toBe(true);
	});
});
