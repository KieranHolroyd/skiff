import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { MAX_AUDIT_PAGE, parseAuditTime } from './audit.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-audit-'));
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
		now: () => Date.now(),
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
const noRead = buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', granted: ['logs:read'], keyId: 'key_1' });

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Entries at fixed times: one per day from Nov 1 to Nov 7 (noon), plus two at the same instant. */
function seed() {
	for (let day = 0; day < 7; day += 1) {
		core.audit.record({ principal: owner, action: 'project.update', resource: 'project', resourceId: `day${day}`, result: 'ok' });
		opened.sqlite.run("UPDATE audit_log SET created_at = ? WHERE resource_id = ?", [T0 + day * DAY + DAY / 2, `day${day}`]);
	}
	for (const id of ['tie_a', 'tie_b']) {
		core.audit.record({ principal: owner, action: 'secret.create', resource: 'secret', resourceId: id, result: 'ok' });
		opened.sqlite.run('UPDATE audit_log SET created_at = ? WHERE resource_id = ?', [T0 + 3 * DAY + DAY / 2, id]);
	}
	core.audit.record({ principal: otherOrg, action: 'project.update', resource: 'project', resourceId: 'other', result: 'ok' });
}
seed();

describe('audit paging', () => {
	test('walks every entry once, newest first, across same-instant ties', () => {
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page = core.audit.page({ principal: viewer, limit: 2, cursor });
			seen.push(...page.entries.map((entry) => entry.resourceId!));
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor && pages < 20);
		expect(seen).toHaveLength(9);
		expect(new Set(seen).size).toBe(9);
		expect(seen[0]).toBe('day6');
		expect(seen.at(-1)).toBe('day0');
		expect(seen).not.toContain('other');
		expect(pages).toBe(5);
	});

	test('the last page has no cursor; an exact fit does not promise another page', () => {
		const page = core.audit.page({ principal: owner, limit: 9 });
		expect(page.entries).toHaveLength(9);
		expect(page.nextCursor).toBeNull();
	});

	test('from/to are inclusive and combine with filters and the cursor', () => {
		const range = core.audit.page({
			principal: owner,
			from: parseAuditTime('2026-11-03', 'from'),
			to: parseAuditTime('2026-11-04', 'to'),
		});
		expect(range.entries.map((entry) => entry.resourceId).sort()).toEqual(['day2', 'day3', 'tie_a', 'tie_b']);

		const first = core.audit.page({ principal: owner, from: T0 + 3 * DAY, to: T0 + 4 * DAY, resource: 'secret', limit: 1 });
		expect(first.entries).toHaveLength(1);
		const second = core.audit.page({ principal: owner, from: T0 + 3 * DAY, to: T0 + 4 * DAY, resource: 'secret', limit: 1, cursor: first.nextCursor });
		expect([first.entries[0]!.resourceId, second.entries[0]!.resourceId].sort()).toEqual(['tie_a', 'tie_b']);
		expect(second.nextCursor).toBeNull();
	});

	test('rejects an inverted range, a bad cursor and a principal without project:read', () => {
		expect(() => core.audit.page({ principal: owner, from: T0 + DAY, to: T0 })).toThrow(/after its end/);
		expect(() => core.audit.page({ principal: owner, cursor: 'not a cursor!' })).toThrow(/cursor/);
		expect(() => core.audit.page({ principal: owner, cursor: Buffer.from('123.notaud').toString('base64url') })).toThrow(/cursor/);
		expect(() => core.audit.page({ principal: noRead })).toThrow();
	});

	test('caps the page size', () => {
		expect(MAX_AUDIT_PAGE).toBe(200);
		expect(core.audit.page({ principal: owner, limit: 10_000 }).entries).toHaveLength(9);
		expect(core.audit.page({ principal: owner, limit: 0 }).entries).toHaveLength(9);
	});
});

describe('parseAuditTime', () => {
	test('accepts epoch ms, ISO timestamps and calendar dates', () => {
		expect(parseAuditTime('1793491200000', 'from')).toBe(1793491200000);
		expect(parseAuditTime(42, 'to')).toBe(42);
		expect(parseAuditTime('2026-11-07T10:00:00Z', 'from')).toBe(Date.parse('2026-11-07T10:00:00Z'));
		expect(parseAuditTime('2026-11-07', 'from')).toBe(Date.parse('2026-11-07T00:00:00Z'));
		expect(parseAuditTime('2026-11-07', 'to')).toBe(Date.parse('2026-11-08T00:00:00Z') - 1);
	});

	test('empty is undefined; anything else is a validation error', () => {
		expect(parseAuditTime(undefined, 'from')).toBeUndefined();
		expect(parseAuditTime(null, 'from')).toBeUndefined();
		expect(parseAuditTime('', 'to')).toBeUndefined();
		for (const bad of ['yesterday', '2026-13-45', '11/07/2026', '-5'])
			expect(() => parseAuditTime(bad, 'from')).toThrow(/not a date/);
	});
});

describe('audit actor columns (IAM.md §7.1)', () => {
	const sessionUser: Principal = { ...owner, credential: 'session' };
	const job: Principal = {
		...buildPrincipal({ kind: 'job', userId: 'job_1', orgId: 'org_1', role: 'owner' }),
		credential: 'job',
		actingFor: { kind: 'user', id: 'user_1' },
	};
	const keyUser: Principal = {
		...buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', keyId: 'key_9' }),
		credential: 'apiKey',
	};

	interface ActorRow {
		actor_type: string;
		credential_id: string | null;
		acting_for_type: string | null;
		acting_for_id: string | null;
	}

	function actorRow(resourceId: string): ActorRow {
		const row = opened.sqlite
			.query('SELECT actor_type, credential_id, acting_for_type, acting_for_id FROM audit_log WHERE resource_id = ?')
			.get(resourceId) as ActorRow | null;
		expect(row).not.toBeNull();
		return row!;
	}

	test('a session user records the credential and no acting-for', () => {
		core.audit.record({ principal: sessionUser, action: 'project.update', resource: 'project', resourceId: 'actor_session', result: 'ok' });
		expect(actorRow('actor_session')).toEqual({
			actor_type: 'user',
			credential_id: 'session',
			acting_for_type: null,
			acting_for_id: null,
		});
	});

	test('a machine kind records credential and acting-for as system', () => {
		core.audit.record({ principal: job, action: 'job.run', resource: 'job', resourceId: 'actor_job', result: 'ok' });
		// `job` is not in actor_type's CHECK yet, so it is stored as `system` (migration 0081).
		expect(actorRow('actor_job')).toEqual({
			actor_type: 'system',
			credential_id: 'job',
			acting_for_type: 'user',
			acting_for_id: 'user_1',
		});
	});

	test('a key id wins over the credential kind', () => {
		core.audit.record({ principal: keyUser, action: 'project.update', resource: 'project', resourceId: 'actor_key', result: 'ok' });
		expect(actorRow('actor_key')).toMatchObject({ actor_type: 'apiKey', credential_id: 'key_9' });
	});

	test('a session principal records its credential kind; acting-for stays NULL', () => {
		expect(actorRow('day0')).toEqual({ actor_type: 'user', credential_id: 'session', acting_for_type: null, acting_for_id: null });
	});
});
