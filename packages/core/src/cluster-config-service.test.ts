import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-cluster-config-'));
const opened = createDb({ path: ':memory:' });
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
	},
});
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('cluster configuration', () => {
	test('defaults are the documented values', () => {
		expect(core.cluster.get()).toMatchObject({
			overlay: { cidr: '10.88.0.0/22', listenPort: 51820 },
			endpoints: { portMin: 21000, portMax: 21999, requireMtls: true },
			replicas: { max: 20, spread: 'node' },
			database: { maxReplicas: 2, defaultMode: 'async' },
			storage: { maxTargets: 2 },
			controlPlane: { leaseTtlSeconds: 30, renewSeconds: 5 },
			failover: { enabled: false, graceSeconds: 120 },
			shares: { mountRoot: '/run/skiff-shares' },
		});
	});

	test('merges a section patch and persists it', () => {
		const updated = core.cluster.update(owner, {
			overlay: { cidr: '10.99.0.0/22', mtu: 1380 },
			replicas: { max: 6, spread: 'zone' },
		});
		expect(updated.overlay.cidr).toBe('10.99.0.0/22');
		expect(updated.overlay.mtu).toBe(1380);
		expect(updated.replicas.spread).toBe('zone');
		expect(core.cluster.get().overlay.cidr).toBe('10.99.0.0/22');
	});

	test('refuses an inverted endpoint range', () => {
		expect(() => core.cluster.update(owner, { endpoints: { portMin: 22000, portMax: 21000 } })).toThrow(/min < max/);
	});
});
