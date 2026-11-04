import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { createDb, builds, releases } from '@skiff/db';
import { eq } from 'drizzle-orm';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { CLAIM_TTL_MS } from './builds.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-builds-'));
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
const WEBHOOK_SECRET = 'webhook-secret-0123456789';
let slugCounter = 0;

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	opened.sqlite.run('DELETE FROM builds');
	clock = Date.now();
});

async function projectWithSource(options: { webhookSecret?: boolean } = {}): Promise<{
	project: ReturnType<typeof core.projects.requireRow>;
	builderNodeId: string;
}> {
	const slug = `build-app-${++slugCounter}`;
	const created = await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	core.builds.upsertGitSource(principal, core.projects.requireRow(principal, created.slug), {
		repoUrl: 'https://github.com/acme/app.git',
		branch: 'main',
		rootDir: '.',
		buildCommand: 'bun install && bun run build',
		outputDir: 'dist',
		...(options.webhookSecret === false ? {} : { webhookSecret: WEBHOOK_SECRET }),
		enabled: true,
	});
	const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, `builder-${slugCounter}`).token, name: `builder-${slugCounter}` });
	core.nodes.setBuilder(principal, node.nodeId, true);
	return {
		project: core.projects.requireRow(principal, created.slug),
		builderNodeId: node.nodeId,
	};
}

describe('build queue', () => {
	test('claims oldest first and one build at a time per node', async () => {
		const { project, builderNodeId } = await projectWithSource();
		const first = core.builds.enqueue(principal, project, { ref: 'main', promote: false });
		clock += 1000;
		const second = core.builds.enqueue(principal, project, { ref: 'release', promote: false });

		const job = await core.builds.claim(builderNodeId);
		expect(job?.buildId).toBe(first.id);
		expect(job?.repoUrl).toBe('https://github.com/acme/app.git');
		expect(job?.uploadUrl).toContain(`/api/objects/builds/${first.id}.zip`);

		// While that claim is live, the same Builder gets nothing even though a job is queued.
		expect(await core.builds.claim(builderNodeId)).toBeNull();

		await core.builds.report(builderNodeId, first.id, { status: 'failed', error: 'boom' });
		const next = await core.builds.claim(builderNodeId);
		expect(next?.buildId).toBe(second.id);
	});

	test('requeues a claim older than the TTL', async () => {
		const { project, builderNodeId } = await projectWithSource();
		const build = core.builds.enqueue(principal, project, { ref: 'main', promote: false });
		expect((await core.builds.claim(builderNodeId))?.buildId).toBe(build.id);

		opened.sqlite.run('UPDATE builds SET claimed_at = ?, started_at = ? WHERE id = ?', [
			clock - CLAIM_TTL_MS - 1,
			clock - CLAIM_TTL_MS - 1,
			build.id,
		]);
		clock += 1000;

		const retry = await core.builds.claim(builderNodeId);
		expect(retry?.buildId).toBe(build.id);
		const row = opened.db.select().from(builds).where(eq(builds.id, build.id)).get();
		expect(row?.logTail).toContain('claim expired');
	});

	test('deleting the project cancels its builds and a late report never deploys', async () => {
		const { project, builderNodeId } = await projectWithSource();
		const running = core.builds.enqueue(principal, project, { ref: 'main', promote: true });
		clock += 1000;
		const queued = core.builds.enqueue(principal, project, { ref: 'main', promote: true });
		expect((await core.builds.claim(builderNodeId))?.buildId).toBe(running.id);

		await core.projects.softDelete(principal, project.slug);
		for (const id of [running.id, queued.id])
			expect(opened.db.select().from(builds).where(eq(builds.id, id)).get()?.status).toBe('cancelled');
		expect(await core.builds.claim(builderNodeId)).toBeNull();

		// A Builder that never heard about the cancel reports success; nothing is deployed.
		opened.sqlite.run("UPDATE builds SET status = 'building' WHERE id = ?", [running.id]);
		await expect(core.builds.report(builderNodeId, running.id, { status: 'succeeded' })).rejects.toMatchObject({
			code: 'not_found',
		});
		expect(opened.db.select().from(builds).where(eq(builds.id, running.id)).get()?.status).toBe('cancelled');
		const restored = core.projects.requireRow(principal, project.slug, { includeDeleted: true });
		expect(restored.productionDeploymentId).toBeNull();
	});

	test('rejects nodes that are not Builders', async () => {
		const node = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'plain').token, name: 'plain' });
		await expect(core.builds.claim(node.nodeId)).rejects.toMatchObject({ status: 403 });
	});
});

describe('github webhook', () => {
	const payload = JSON.stringify({
		ref: 'refs/heads/main',
		after: 'abc123def456',
		head_commit: { message: 'Ship it' },
	});
	const sign = (body: string) => `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;

	test('rejects a webhook when no secret is configured', async () => {
		const { project } = await projectWithSource({ webhookSecret: false });
		await expect(core.builds.handleGithubWebhook(project, payload, null, 'push')).rejects.toMatchObject({
			code: 'unauthorized',
			status: 401,
		});
	});

	test('rejects an invalid signature', async () => {
		const { project } = await projectWithSource();
		await expect(core.builds.handleGithubWebhook(project, payload, 'sha256=deadbeef', 'push')).rejects.toMatchObject({
			code: 'unauthorized',
			status: 401,
		});
	});

	test('queues a push for the configured branch only', async () => {
		const { project } = await projectWithSource();
		const build = await core.builds.handleGithubWebhook(project, payload, sign(payload), 'push');
		expect(build?.commitSha).toBe('abc123def456');
		expect(build?.commitMessage).toBe('Ship it');
		expect(build?.ref).toBe('main');

		const otherBranch = JSON.stringify({ ref: 'refs/heads/dev', after: 'fff' });
		expect(await core.builds.handleGithubWebhook(project, otherBranch, sign(otherBranch), 'push')).toBeNull();
		expect(await core.builds.handleGithubWebhook(project, payload, sign(payload), 'ping')).toBeNull();
	});
});

describe('builder reports', () => {
	test('finalizes a successful build into a release and deployment', async () => {
		const { project, builderNodeId } = await projectWithSource();
		const build = core.builds.enqueue(principal, project, { ref: 'main', promote: true });
		expect((await core.builds.claim(builderNodeId))?.buildId).toBe(build.id);

		const zip = zipSync({
			'index.html': new TextEncoder().encode('<h1>built by git</h1>'),
			'assets/app.js': new TextEncoder().encode('console.log("hi")'),
		});
		await store.put(`builds/${build.id}.zip`, zip);

		const finished = await core.builds.report(builderNodeId, build.id, {
			status: 'succeeded',
			commitSha: 'abc123def456',
			commitMessage: 'Ship it',
		});

		expect(finished.status).toBe('succeeded');
		expect(finished.deploymentId).toStartWith('dep_');
		expect(finished.releaseSha256 ?? '').toHaveLength(64);

		const row = opened.db.select().from(builds).where(eq(builds.id, build.id)).get();
		expect(row?.releaseId).toStartWith('rel_');
		expect(row?.releaseId).not.toBe(row?.deploymentId);
		const release = opened.db.select().from(releases).where(eq(releases.id, row!.releaseId!)).get();
		expect(release?.sha256 ?? null).toBe(finished.releaseSha256);

		// Promote is per build, so production points at the new deployment.
		expect(core.projects.requireRow(principal, project.slug).productionDeploymentId).toBe(finished.deploymentId);
		// The transient upload is cleaned up after finalize.
		expect(await store.exists(`builds/${build.id}.zip`)).toBe(false);
	});

	test('records a failed report, its log and removes the upload', async () => {
		const { project, builderNodeId } = await projectWithSource();
		const build = core.builds.enqueue(principal, project, { ref: 'main', promote: false });
		await core.builds.claim(builderNodeId);
		core.builds.appendLog(builderNodeId, build.id, 'installing dependencies\n');

		await store.put(`builds/${build.id}.zip`, zipSync({ 'index.html': new TextEncoder().encode('x') }));
		const finished = await core.builds.report(builderNodeId, build.id, {
			status: 'failed',
			error: 'compile error',
		});

		expect(finished.status).toBe('failed');
		expect(finished.error).toBe('compile error');
		const full = core.builds.get(principal, project, build.id);
		expect(full.logTail).toContain('installing dependencies');
		expect(await store.exists(`builds/${build.id}.zip`)).toBe(false);
	});

	test('rejects reports from another node and after cancel', async () => {
		const { project, builderNodeId } = await projectWithSource();
		const build = core.builds.enqueue(principal, project, { ref: 'main', promote: false });
		await core.builds.claim(builderNodeId);
		await expect(
			core.builds.report('nod_other', build.id, { status: 'failed', error: 'x' }),
		).rejects.toMatchObject({ status: 403 });

		const cancelled = core.builds.cancel(principal, project, build.id);
		expect(cancelled.status).toBe('cancelled');
		await expect(
			core.builds.report(builderNodeId, build.id, { status: 'failed', error: 'late' }),
		).rejects.toMatchObject({ code: 'conflict' });
	});

	test('treats a malformed uploaded archive as a failed build', async () => {
		const { project, builderNodeId } = await projectWithSource();
		const build = core.builds.enqueue(principal, project, { ref: 'main', promote: false });
		await core.builds.claim(builderNodeId);
		await store.put(`builds/${build.id}.zip`, new TextEncoder().encode('not a zip'));

		const finished = await core.builds.report(builderNodeId, build.id, { status: 'succeeded' });
		expect(finished.status).toBe('failed');
		expect(finished.error?.toLowerCase()).toContain('zip');
		expect(await store.exists(`builds/${build.id}.zip`)).toBe(false);
	});
});
