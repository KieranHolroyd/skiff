import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-service-logs-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-05T10:00:00Z');

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
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });

let token = '';
let nodeId = '';
let storageId = '';
let databaseId = '';

const line = (message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') => ({
	ts: clock,
	stream: 'stdout' as const,
	level,
	message,
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('managed-service logs', () => {
	test('creates a storage instance and a database on the edge', () => {
		const edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		token = edge.token;
		nodeId = edge.nodeId;
		core.nodes.update(owner, nodeId, { sliceMemoryMb: 4096 });
		storageId = core.storage.create(owner, { name: 'media', buckets: ['uploads'] }).id;
		databaseId = core.databases.create(owner, { name: 'primary' }).id;
	});

	test('stores drained RustFS lines and pages them by cursor', () => {
		const stored = core.logs.appendRuntime(nodeId, {
			workloadId: storageId,
			lines: [line('rustfs starting'), line('listening on :9000', 'warn')],
		});
		expect(stored).toBe(2);

		const page = core.logs.queryService(owner, 'storage', storageId, { limit: 10 });
		expect(page.events.map((event) => event.message)).toEqual(['rustfs starting', 'listening on :9000']);
		expect(page.events.every((event) => event.kind === 'storage' && event.serviceId === storageId)).toBe(true);
		expect(page.events[1]!.level).toBe('warn');
		expect(page.cursor).toBeGreaterThan(0);

		const next = core.logs.queryService(owner, 'storage', storageId, {
			after: page.events[0]!.seq,
			limit: 10,
		});
		expect(next.events.map((event) => event.message)).toEqual(['listening on :9000']);

		expect(core.logs.queryService(viewer, 'storage', storageId).events).toHaveLength(2);
	});

	test('stores database lines in the same table, scoped to the service', () => {
		core.logs.appendRuntime(nodeId, {
			workloadId: databaseId,
			lines: [line('database system is ready to accept connections')],
		});
		const dbPage = core.logs.queryService(owner, 'database', databaseId);
		expect(dbPage.events.map((event) => event.message)).toEqual([
			'database system is ready to accept connections',
		]);
		// A storage query never sees the database stream.
		expect(core.logs.queryService(owner, 'storage', storageId).events).toHaveLength(2);
	});

	test('a restart writes a system breadcrumb into the same stream', () => {
		core.storage.restart(owner, 'media');
		const page = core.logs.queryService(owner, 'storage', storageId, { limit: 10 });
		const last = page.events.at(-1)!;
		expect(last.source).toBe('system');
		expect(last.message).toContain('Restart requested by user_1');

		core.databases.restart(owner, 'primary');
		const dbPage = core.logs.queryService(owner, 'database', databaseId, { limit: 10 });
		expect(dbPage.events.at(-1)?.message).toContain('Database restart requested');
	});

	test('rejects another org and another node', () => {
		expect(() => core.logs.queryService(otherOrg, 'storage', storageId)).toThrow(/not found/i);
		expect(() =>
			core.logs.appendRuntime('nod_other', { workloadId: storageId, lines: [line('nope')] }),
		).toThrow(/another node/);
		expect(core.logs.appendRuntime(nodeId, { workloadId: 'st_missing', lines: [line('nope')] })).toBe(0);
	});

	test('filters by level and message', () => {
		core.logs.appendRuntime(nodeId, {
			workloadId: storageId,
			lines: [line('disk full', 'error'), line('minor hiccup', 'warn'), line('all good')],
		});
		expect(
			core.logs.queryService(owner, 'storage', storageId, { level: 'warn' }).events.map((event) => event.message),
		).toEqual(expect.arrayContaining(['disk full', 'minor hiccup']));
		expect(
			core.logs.queryService(owner, 'storage', storageId, { q: 'DISK' }).events.map((event) => event.message),
		).toEqual(['disk full']);
	});

	test('extracts structured levels and messages from drained lines', () => {
		const embedded = Date.parse('2026-11-05T09:30:00Z');
		core.logs.appendRuntime(nodeId, {
			workloadId: storageId,
			lines: [
				line(`level=error msg="bucket missing" ts=${embedded}`),
				line('<11>Nov  5 10:00:00 host rustfs[7]: disk failure'),
			],
		});
		const page = core.logs.queryService(owner, 'storage', storageId, { limit: 10 });
		const [logfmt, syslog] = page.events.slice(-2);
		expect(logfmt?.level).toBe('error');
		expect(logfmt?.message).toBe('bucket missing');
		expect(logfmt?.ts).toBe(clock);
		expect(syslog?.level).toBe('error');
		expect(syslog?.message).toBe('disk failure');
	});

	test('prunes service logs with the same retention as runtime logs', () => {
		clock += 8 * 86_400_000;
		core.logs.prune();
		expect(core.logs.queryService(owner, 'storage', storageId).events).toHaveLength(0);
	});
});
