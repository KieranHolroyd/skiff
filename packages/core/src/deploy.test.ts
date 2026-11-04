import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { limits } from '@skiff/contracts';
import { createDb, slugRedirects } from '@skiff/db';
import { eq } from 'drizzle-orm';
import { entriesFromZip } from './artifact.ts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore, objectKeyForRelease, objectKeyForUpload } from './object-store.ts';
import type { Core } from './index.ts';

/** Local store whose reported size can be faked, to exercise the pre-download size check. */
class SizedStore extends LocalObjectStore {
	fakeSize: number | undefined;
	override async size(key: string): Promise<number | null> {
		const real = await super.size(key);
		return real !== null && this.fakeSize !== undefined ? this.fakeSize : real;
	}
}

const dir = mkdtempSync(join(tmpdir(), 'skiff-deploy-'));
const opened = createDb({ path: ':memory:' });
const store = new SizedStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
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

const orgA = buildPrincipal({ kind: 'user', userId: 'user_a', orgId: 'org_a', role: 'owner' });
const orgB = buildPrincipal({ kind: 'user', userId: 'user_b', orgId: 'org_b', role: 'owner' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const zipOf = (files: Record<string, string>) =>
	zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)])));

async function project(principal: typeof orgA, slug: string) {
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	return core.projects.requireRow(principal, slug);
}

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('release garbage collection', () => {
	test('keeps a content-addressed object another org still uses', async () => {
		const a = await project(orgA, 'shared-a');
		const b = await project(orgB, 'shared-b');
		const files = [file('index.html', '<h1>same bytes</h1>')];
		const deployA = await core.uploads.deployInline(orgA, a, files);
		const deployB = await core.uploads.deployInline(orgB, b, files);
		expect(deployA.release.sha256).toBe(deployB.release.sha256);

		await core.deployments.delete(orgA, core.projects.requireRow(orgA, 'shared-a'), deployA.id);
		await core.deployments.gcReleases('org_a');

		expect(await store.exists(objectKeyForRelease(deployB.release.sha256))).toBe(true);
	});

	test('deletes the object once no org references it', async () => {
		const b = core.projects.requireRow(orgB, 'shared-b');
		const [only] = core.deployments.list(orgB, b);
		await core.deployments.delete(orgB, b, only!.id);
		await core.deployments.gcReleases('org_b');
		expect(await store.exists(objectKeyForRelease(only!.release.sha256))).toBe(false);
	});
});

describe('zip limits', () => {
	test('rejects an oversize entry from its declared size, before inflating', () => {
		const bomb = zipSync({ 'big.bin': new Uint8Array(limits.fileBytes + 1) }, { level: 9 });
		expect(bomb.byteLength).toBeLessThan(1024 * 1024);
		expect(() => entriesFromZip(bomb)).toThrow('per-file limit');
	});
});

describe('project lifecycle', () => {
	test('restoring a deleted project brings production back', async () => {
		const p = await project(orgA, 'restore-me');
		const deployment = await core.uploads.deployInline(orgA, p, [file('index.html', 'hi')]);
		await core.projects.softDelete(orgA, 'restore-me');
		const restored = await core.projects.restore(orgA, 'restore-me');
		expect(restored.productionDeploymentId).toBe(deployment.id);
	});

	test('purging a deleted project removes its deployments and everything keyed by it', async () => {
		const p = await project(orgA, 'purge-me');
		await core.uploads.deployInline(orgA, p, [file('index.html', 'bye')]);
		const before = core.metrics.status(orgA).deployments.total;
		const tables = ['deployments', 'environments', 'workloads', 'builds', 'git_sources', 'log_events', 'secrets'];
		const insertedAt = clock;
		opened.sqlite.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, created_at, updated_at)
			 VALUES ('wl_purge', 'org_a', ?, 'dep_x', 'node_x', 'process', 'running', '{}', 256, ?, ?)`,
			[p.id, insertedAt, insertedAt],
		);
		opened.sqlite.run(
			`INSERT INTO log_events (org_id, project_id, source, stream, message, ts) VALUES ('org_a', ?, 'system', 'system', 'x', ?)`,
			[p.id, insertedAt],
		);
		const count = (table: string) =>
			opened.sqlite.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(p.id)!.n;
		expect(count('deployments')).toBeGreaterThan(0);

		await core.projects.softDelete(orgA, 'purge-me');
		// Status counts stop including the deleted project's deployments straight away.
		expect(core.metrics.status(orgA).deployments.total).toBeLessThan(before);

		clock += (limits.trashDays + 1) * 86_400_000;
		expect(core.projects.purgeExpired()).toBeGreaterThanOrEqual(1);
		for (const table of tables) expect(count(table)).toBe(0);
		expect(opened.sqlite.query('SELECT 1 FROM projects WHERE id = ?').get(p.id)).toBeNull();
	});

	test('an old slug is released once its rename redirect expires', async () => {
		await project(orgA, 'old-name');
		await core.projects.update(orgA, 'old-name', { slug: 'new-name' });
		await expect(project(orgA, 'old-name')).rejects.toMatchObject({ code: 'conflict' });

		clock += (limits.redirectDays + 1) * 86_400_000;
		const reused = await project(orgA, 'old-name');
		expect(reused.slug).toBe('old-name');

		expect(core.projects.pruneExpiredRedirects()).toBe(1);
		expect(opened.db.select().from(slugRedirects).where(eq(slugRedirects.fromSlug, 'old-name')).all()).toHaveLength(0);
	});
});

describe('upload finalize', () => {
	test('refuses an upload created for another project', async () => {
		const first = await project(orgA, 'upload-one');
		const second = await project(orgA, 'upload-two');
		const upload = await core.uploads.create(orgA, first);
		await store.put(objectKeyForUpload(upload.uploadId), zipOf({ 'index.html': 'x' }));
		await expect(core.uploads.finalize(orgA, second, upload.uploadId)).rejects.toThrow('different project');
		// The session is untouched and can still be finalized into its own project.
		const view = await core.uploads.finalize(orgA, first, upload.uploadId);
		expect(view.projectSlug).toBe('upload-one');
	});

	test('a finalize before the PUT leaves the session retryable', async () => {
		const p = core.projects.requireRow(orgA, 'upload-one');
		const upload = await core.uploads.create(orgA, p);
		await expect(core.uploads.finalize(orgA, p, upload.uploadId)).rejects.toThrow('Nothing has been uploaded');
		await store.put(objectKeyForUpload(upload.uploadId), zipOf({ 'index.html': 'later' }));
		expect((await core.uploads.finalize(orgA, p, upload.uploadId)).release.fileCount).toBe(1);
	});

	test('rejects oversize objects before downloading and deletes them', async () => {
		const p = core.projects.requireRow(orgA, 'upload-one');
		const upload = await core.uploads.create(orgA, p);
		const key = objectKeyForUpload(upload.uploadId);
		await store.put(key, zipOf({ 'index.html': 'x' }));
		store.fakeSize = limits.artifactBytes + 1;
		try {
			await expect(core.uploads.finalize(orgA, p, upload.uploadId)).rejects.toThrow('the limit is');
		} finally {
			store.fakeSize = undefined;
		}
		expect(await store.exists(key)).toBe(false);
	});

	test('the stale sweep also cleans up failed sessions', async () => {
		const p = core.projects.requireRow(orgA, 'upload-one');
		const upload = await core.uploads.create(orgA, p);
		const key = objectKeyForUpload(upload.uploadId);
		await store.put(key, new Uint8Array([1, 2, 3]));
		await expect(core.uploads.finalize(orgA, p, upload.uploadId)).rejects.toThrow('not a valid zip');
		// A client can still PUT to the presigned URL after the failure.
		await store.put(key, new Uint8Array([1, 2, 3]));
		clock += (limits.uploadTtlSeconds + 1) * 1000;
		expect(core.uploads.expireStale()).toBeGreaterThanOrEqual(1);
		await Bun.sleep(5);
		expect(await store.exists(key)).toBe(false);
	});
});

describe('SPA hint', () => {
	test('is offered for uploaded single-page builds', async () => {
		await project(orgA, 'spa-upload');
		const upload = await core.uploads.create(orgA, core.projects.requireRow(orgA, 'spa-upload'));
		await store.put(objectKeyForUpload(upload.uploadId), zipOf({ 'index.html': '<div id=app>', 'app.js': '1' }));
		const result = await core.deploy.deploySite(orgA, { name: 'spa-upload', uploadId: upload.uploadId, promote: true });
		expect(result.hint).toContain('single-page app');
	});

	test('is not offered when skiff.json already enables SPA mode, or when suppressed', async () => {
		const configured = await core.deploy.deploySite(orgA, {
			name: 'spa-configured',
			files: [file('index.html', '<div id=app>'), file('skiff.json', '{"spa":true}')],
			promote: true,
		});
		expect(configured.hint).toBeUndefined();
		const suppressed = await core.deploy.deploySite(orgA, {
			name: 'spa-suppressed',
			files: [file('index.html', '<div id=app>')],
			promote: true,
			spa: false,
		});
		expect(suppressed.hint).toBeUndefined();
	});
});
