import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import {
	appFrames,
	fingerprintFor,
	normalizeMessage,
	scrubPath,
	scrubText,
	SERVER_ERROR_LIMITS,
} from './server-errors.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-server-errors-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-08T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '1.2.3',
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

const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_a', role: 'owner', platformAdmin: true });
const owner = buildPrincipal({ kind: 'user', userId: 'user_a', orgId: 'org_a', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function boom(message: string): Error {
	// Same call site every time, so the stack frames match.
	return new TypeError(message);
}

describe('scrubbing', () => {
	test('removes credentials from text', () => {
		const text = scrubText(
			'connect postgres://app:hunter2@db:5432/x failed; Authorization: Bearer abcdefghijklmnop; key skif_live_1234567890abcdef password=letmein',
		);
		expect(text).not.toContain('hunter2');
		expect(text).not.toContain('abcdefghijklmnop');
		expect(text).not.toContain('1234567890abcdef');
		expect(text).not.toContain('letmein');
		expect(text).toContain('postgres://app:[redacted]@db');
	});

	test('drops query strings and masks token segments in paths', () => {
		expect(scrubPath('/projects/shop?token=abc#x')).toBe('/projects/shop');
		expect(scrubPath('/invite/abcdefghijklmnopqrstuvwxyz0123456789')).toBe('/invite/:token');
		expect(scrubPath(null)).toBeNull();
	});
});

describe('fingerprinting', () => {
	test('masks ids and numbers so one bug is one issue', () => {
		expect(normalizeMessage('Project prj_abc123def not found after 3 tries')).toBe(
			normalizeMessage('Project prj_zzz999yyy not found after 12 tries'),
		);
		expect(normalizeMessage('row "a" missing')).toBe('row <str> missing');
	});

	test('ignores line numbers and build hashes in frames', () => {
		const a = 'TypeError: x\n    at load (/opt/skiff/build/server/chunks/page-B3kd9fQ2.js:10:5)\n    at node_modules/kit/x.js:1:1';
		const b = 'TypeError: x\n    at load (/opt/skiff/build/server/chunks/page-Zx81kLm0.js:99:2)';
		expect(appFrames(a)).toEqual([{ fn: 'load', file: 'build/server/chunks/page.js' }]);
		expect(appFrames(a)).toEqual(appFrames(b));
	});

	test('different sources or names do not merge', () => {
		const error = boom('same');
		expect(fingerprintFor({ source: 'api', error })).not.toBe(fingerprintFor({ source: 'request', error }));
		expect(fingerprintFor({ source: 'api', error })).not.toBe(fingerprintFor({ source: 'api', error: new RangeError('same') }));
	});
});

describe('ServerErrorService', () => {
	test('groups repeated errors into one issue with exact counts', () => {
		for (let i = 0; i < 5; i++) {
			clock += 10; // inside the sample window: counted, mostly not stored
			core.serverErrors.capture({
				source: 'request',
				error: boom(`Cannot read properties of undefined (reading 'id') for prj_abc${i}xyz`),
				method: 'GET',
				path: '/projects/shop?secret=1',
				routeId: '/(dashboard)/projects/[slug]',
				userId: 'user_a',
			});
		}
		const list = core.serverErrors.list(admin);
		expect(list.issues).toHaveLength(1);
		const issue = list.issues[0]!;
		expect(issue.count).toBe(5);
		expect(issue.count24h).toBe(5);
		expect(issue.name).toBe('TypeError');
		expect(issue.culprit).toBe('GET /(dashboard)/projects/[slug]');
		expect(issue.firstVersion).toBe('1.2.3');
		expect(list.summary.unresolved).toBe(1);
		expect(list.hourly.at(-1)).toBe(5);

		const detail = core.serverErrors.get(admin, issue.id);
		// Sampled: one stored event inside the one-second window.
		expect(detail.events).toHaveLength(1);
		expect(detail.events[0]!.path).toBe('/projects/shop');
		expect(detail.events[0]!.stack).toContain('TypeError');
		expect(detail.hourly.reduce((a, b) => a + b, 0)).toBe(5);
	});

	test('caps stored events per issue', () => {
		for (let i = 0; i < SERVER_ERROR_LIMITS.eventsPerIssue + 5; i++) {
			clock += 61_000; // past the sample window and the per-minute budget
			core.serverErrors.capture({ source: 'background', error: new Error('tick failed'), culprit: 'jobs' });
		}
		const issue = core.serverErrors.list(admin, { source: 'background' }).issues[0]!;
		expect(issue.count).toBe(SERVER_ERROR_LIMITS.eventsPerIssue + 5);
		expect(core.serverErrors.get(admin, issue.id).events).toHaveLength(SERVER_ERROR_LIMITS.eventsPerIssue);
	});

	test('a resolved issue reopens when it happens again; ignored stays quiet', () => {
		const issue = core.serverErrors.list(admin, { source: 'background' }).issues[0]!;
		core.serverErrors.setStatus(admin, [issue.id], 'resolved');
		expect(core.serverErrors.list(admin, { status: 'resolved' }).issues.map((i) => i.id)).toContain(issue.id);

		clock += 2_000;
		core.serverErrors.capture({ source: 'background', error: new Error('tick failed'), culprit: 'jobs' });
		const reopened = core.serverErrors.get(admin, issue.id).issue;
		expect(reopened.status).toBe('unresolved');
		expect(reopened.regressedAt).toBe(clock);

		core.serverErrors.setStatus(admin, [issue.id], 'ignored');
		clock += 2_000;
		core.serverErrors.capture({ source: 'background', error: new Error('tick failed'), culprit: 'jobs' });
		expect(core.serverErrors.get(admin, issue.id).issue.status).toBe('ignored');
	});

	test('records bare 5xx responses grouped by status and route', () => {
		core.serverErrors.capture({ source: 'response', name: 'HTTP 502', message: 'Bad gateway', status: 502, method: 'GET', routeId: '/api/v1/x' });
		clock += 2_000;
		core.serverErrors.capture({ source: 'response', name: 'HTTP 502', message: 'Bad gateway', status: 502, method: 'GET', routeId: '/api/v1/x' });
		const issues = core.serverErrors.list(admin, { source: 'response' }).issues;
		expect(issues).toHaveLength(1);
		expect(issues[0]!.count).toBe(2);
	});

	test('search, filters and pagination', () => {
		expect(core.serverErrors.list(admin, { status: 'all', q: 'tick' }).issues).toHaveLength(1);
		expect(core.serverErrors.list(admin, { status: 'all', q: 'nothing like it' }).issues).toHaveLength(0);
		const first = core.serverErrors.list(admin, { status: 'all', limit: 1 });
		expect(first.issues).toHaveLength(1);
		expect(first.nextBefore).not.toBeNull();
		const second = core.serverErrors.list(admin, { status: 'all', limit: 1, before: first.nextBefore! });
		expect(second.issues[0]!.id).not.toBe(first.issues[0]!.id);
	});

	test('only platform admins can read or change issues', () => {
		expect(() => core.serverErrors.list(owner)).toThrow();
		const id = core.serverErrors.list(admin, { status: 'all' }).issues[0]!.id;
		expect(() => core.serverErrors.setStatus(owner, [id], 'resolved')).toThrow();
		expect(() => core.serverErrors.delete(owner, [id])).toThrow();
	});

	test('capture never throws, even for odd values', () => {
		expect(() => core.serverErrors.capture({ source: 'api', error: { weird: true } })).not.toThrow();
		expect(() => core.serverErrors.capture({ source: 'api', error: 'a string' })).not.toThrow();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => core.serverErrors.capture({ source: 'api', error: circular })).not.toThrow();
	});

	test('delete and prune', () => {
		const id = core.serverErrors.list(admin, { status: 'all', source: 'response' }).issues[0]!.id;
		expect(core.serverErrors.delete(admin, [id])).toBe(1);
		expect(() => core.serverErrors.get(admin, id)).toThrow();

		clock += SERVER_ERROR_LIMITS.issueRetentionMs + 1;
		const pruned = core.serverErrors.prune(clock);
		expect(pruned.issues).toBeGreaterThan(0);
		expect(core.serverErrors.list(admin, { status: 'all' }).issues).toHaveLength(0);
	});
});
