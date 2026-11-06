import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MetricBucket } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { disposeTelemetryStore, hasClickHouse, testTelemetryStore } from './test-clickhouse.ts';
import type { Core } from './index.ts';

const MINUTE = 60_000;
const dir = mkdtempSync(join(tmpdir(), 'skiff-deployment-detail-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Math.floor(Date.parse('2026-11-06T12:00:00Z') / MINUTE) * MINUTE;

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

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const telemetry = testTelemetryStore();

beforeAll(async () => {
	await telemetry.open();
	core.ctx.telemetry = telemetry;
	await core.projects.create(owner, {
		name: 'Detail',
		slug: 'detail',
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
});

afterAll(async () => {
	await disposeTelemetryStore(telemetry);
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const row = () => core.projects.requireRow(owner, 'detail');

async function deploy(body: string, promote: boolean) {
	clock += 1_000;
	return core.uploads.deployInline(
		owner,
		row(),
		[file('index.html', body), file('_redirects', '/old /new 301\n/a /b 302\n')],
		{ promote, message: `deploy ${body}` },
	);
}

function bucket(host: string, at: number, requests: number): MetricBucket {
	return {
		host,
		projectId: null,
		bucket: new Date(at).toISOString(),
		requests,
		status2xx: requests,
		status3xx: 0,
		status4xx: 0,
		status5xx: 0,
		bytes: requests * 100,
		durationP50Ms: 1,
		durationP95Ms: 2,
		topPaths: [],
		topReferrers: [],
	};
}

describe('deployment detail', () => {
	test('production lists its serving host, promotion time and snapshot config', async () => {
		const live = await deploy('v1', true);
		const detail = core.deployments.detail(owner, row(), live.shortId);

		expect(detail.id).toBe(live.id);
		expect(detail.isProduction).toBe(true);
		expect(detail.previewHost).toBe(`detail--${live.shortId}.sites.test`);
		expect(detail.serving.map((item) => item.host)).toEqual(['detail.sites.test']);
		expect(detail.serving[0]!.isProduction).toBe(true);
		expect(detail.promotedAt).not.toBeNull();
		expect(detail.createdBy.id).toBe('user_1');
		// A bare core database has no auth tables, so the name is unknown rather than an error.
		expect(detail.createdBy.name).toBeNull();
		expect(detail.spec).toBeNull();
		expect(detail.config.redirects).toBe(2);
		expect(detail.build).toBeNull();
		expect(detail.message).toBe('deploy v1');
	});

	test('an unpromoted deployment is served only at its preview host', async () => {
		const preview = await deploy('v2', false);
		const detail = core.deployments.detail(owner, row(), preview.id);
		expect(detail.isProduction).toBe(false);
		expect(detail.serving).toEqual([]);
		expect(detail.promotedAt).toBeNull();
	});

	test('a deleted or unknown deployment is not found', () => {
		expect(() => core.deployments.detail(owner, row(), 'dep_missing')).toThrow();
	});

	test.skipIf(!hasClickHouse)('traffic is read per host and refuses hosts the deployment does not serve', async () => {
		const preview = await deploy('v3', false);
		const host = `detail--${preview.shortId}.sites.test`;
		await telemetry.ingest([1, 2, 3].map((n) => bucket(host, clock - n * MINUTE, 10)));
		await telemetry.ingest([bucket('detail.sites.test', clock - MINUTE, 99)]);
		const window = { from: clock - 10 * MINUTE, to: clock, interval: '1m' as const };

		const view = await core.metrics.trafficForDeployment(owner, 'detail', preview.id, host, window);
		expect(view).toMatchObject({ permitted: true, available: true });
		expect(view.report.totals.requests).toBe(30);

		// Production's host does not serve this preview, so it is refused rather than leaked.
		await expect(
			core.metrics.trafficForDeployment(owner, 'detail', preview.id, 'detail.sites.test', window),
		).rejects.toThrow('does not serve');
		await expect(
			core.metrics.trafficForDeployment(owner, 'detail', preview.id, 'other--abc.sites.test', window),
		).rejects.toThrow('does not serve');
	});

	test.skipIf(!hasClickHouse)('a read-only viewer sees the detail and its traffic', async () => {
		const live = core.deployments.list(viewer, row()).find((item) => item.isProduction)!;
		expect(core.deployments.detail(viewer, row(), live.id).serving[0]!.host).toBe('detail.sites.test');
		const window = { from: clock - 10 * MINUTE, to: clock, interval: '1m' as const };
		const view = await core.metrics.trafficForDeployment(viewer, 'detail', live.id, 'detail.sites.test', window);
		expect(view).toMatchObject({ permitted: true, available: true });
		expect(view.report.totals.requests).toBe(99);
	});
});
