import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { AuditInput } from '@yoal/core';
import {
	ResetThrottle,
	deleteResetTokens,
	discardResetToken,
	hashRequestIp,
	recordPasswordReset
} from './password-reset';

const MINUTE = 60_000;

describe('ResetThrottle', () => {
	function throttle() {
		let now = 1_000_000;
		const limiter = new ResetThrottle({ perMinute: 1, perHour: 5, now: () => now });
		return { limiter, advance: (ms: number) => (now += ms) };
	}

	test('one email a minute per address', () => {
		const { limiter, advance } = throttle();
		expect(limiter.take('ada@example.com')).toBe(true);
		expect(limiter.take('ada@example.com')).toBe(false);
		advance(MINUTE - 1);
		expect(limiter.take('ada@example.com')).toBe(false);
		advance(1);
		expect(limiter.take('ada@example.com')).toBe(true);
	});

	test('five an hour per address, then none until the oldest is an hour old', () => {
		const { limiter, advance } = throttle();
		for (let i = 0; i < 5; i++) {
			expect(limiter.take('ada@example.com')).toBe(true);
			advance(MINUTE);
		}
		expect(limiter.take('ada@example.com')).toBe(false);
		advance(55 * MINUTE - 1); // 59:59 after the first email
		expect(limiter.take('ada@example.com')).toBe(false);
		advance(1);
		expect(limiter.take('ada@example.com')).toBe(true);
	});

	test('refused attempts do not count against the address', () => {
		const { limiter, advance } = throttle();
		expect(limiter.take('ada@example.com')).toBe(true);
		for (let i = 0; i < 20; i++) expect(limiter.take('ada@example.com')).toBe(false);
		advance(MINUTE);
		expect(limiter.take('ada@example.com')).toBe(true);
	});

	test('addresses are counted case-insensitively and separately from each other', () => {
		const { limiter } = throttle();
		expect(limiter.take('Ada@Example.com')).toBe(true);
		expect(limiter.take(' ada@example.com ')).toBe(false);
		expect(limiter.take('grace@example.com')).toBe(true);
	});
});

function authDb() {
	const sqlite = new Database(':memory:');
	sqlite.run(
		'CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt TEXT)'
	);
	sqlite.run(
		'CREATE TABLE member (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT, createdAt TEXT)'
	);
	return sqlite;
}

describe('reset tokens', () => {
	test('deleteResetTokens voids every reset link of the user and nothing else', () => {
		const sqlite = authDb();
		const insert = sqlite.prepare(
			'INSERT INTO verification (id, identifier, value) VALUES (?, ?, ?)'
		);
		insert.run('1', 'reset-password:aaa', 'usr_1');
		insert.run('2', 'reset-password:bbb', 'usr_1');
		insert.run('3', 'reset-password:ccc', 'usr_2');
		insert.run('4', 'magic-link:ddd', 'usr_1');
		insert.run('5', 'reset-passwordx', 'usr_1');
		expect(deleteResetTokens(sqlite, 'usr_1')).toBe(2);
		const left = sqlite
			.query<{ id: string }, []>('SELECT id FROM verification ORDER BY id')
			.all()
			.map((row) => row.id);
		expect(left).toEqual(['3', '4', '5']);
	});

	test('discardResetToken deletes one link', () => {
		const sqlite = authDb();
		sqlite.run(
			"INSERT INTO verification (id, identifier, value) VALUES ('1', 'reset-password:aaa', 'usr_1'), ('2', 'reset-password:bbb', 'usr_1')"
		);
		discardResetToken(sqlite, 'aaa');
		expect(sqlite.query<{ id: string }, []>('SELECT id FROM verification').all()).toEqual([
			{ id: '2' }
		]);
	});
});

describe('recordPasswordReset', () => {
	function recorder() {
		const entries: AuditInput[] = [];
		return { entries, audit: { record: (entry: AuditInput) => void entries.push(entry) } };
	}

	test('writes one entry per organisation, as the user for an email reset', () => {
		const sqlite = authDb();
		sqlite.run(
			"INSERT INTO member (id, organizationId, userId, role) VALUES ('m1', 'org_a', 'usr_1', 'owner'), ('m2', 'org_b', 'usr_1', 'viewer'), ('m3', 'org_a', 'usr_2', 'viewer')"
		);
		const { entries, audit } = recorder();
		expect(
			recordPasswordReset(audit, sqlite, { userId: 'usr_1', method: 'email', ipHash: 'abc' })
		).toBe(2);
		expect(entries.map((entry) => entry.principal?.orgId).sort()).toEqual(['org_a', 'org_b']);
		for (const entry of entries) {
			expect(entry.action).toBe('user.password_reset');
			expect(entry.resource).toBe('user');
			expect(entry.resourceId).toBe('usr_1');
			expect(entry.principal?.kind).toBe('user');
			expect(entry.principal?.userId).toBe('usr_1');
			expect(entry.principal?.ipHash).toBe('abc');
			expect(entry.args).toEqual({ method: 'email' });
		}
	});

	test('an operator reset is recorded as the system', () => {
		const sqlite = authDb();
		sqlite.run(
			"INSERT INTO member (id, organizationId, userId, role) VALUES ('m1', 'org_a', 'usr_1', 'owner')"
		);
		const { entries, audit } = recorder();
		recordPasswordReset(audit, sqlite, { userId: 'usr_1', method: 'operator', sessionsRevoked: 3 });
		expect(entries).toHaveLength(1);
		expect(entries[0]!.principal?.kind).toBe('system');
		expect(entries[0]!.args).toEqual({ method: 'operator', sessionsRevoked: 3 });
	});

	test('a user in no organisation has no audit log to write to', () => {
		const { entries, audit } = recorder();
		expect(recordPasswordReset(audit, authDb(), { userId: 'usr_9', method: 'email' })).toBe(0);
		expect(
			recordPasswordReset(audit, new Database(':memory:'), { userId: 'usr_9', method: 'email' })
		).toBe(0);
		expect(entries).toHaveLength(0);
	});
});

describe('hashRequestIp', () => {
	test('hashes the client address and never returns it raw', () => {
		const hash = hashRequestIp(
			new Request('https://x', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } })
		);
		expect(hash).toMatch(/^[0-9a-f]{16}$/);
		expect(hash).toBe(
			hashRequestIp(new Request('https://x', { headers: { 'x-real-ip': '203.0.113.7' } }))
		);
		expect(hashRequestIp(new Request('https://x'))).toBeUndefined();
		expect(hashRequestIp(undefined)).toBeUndefined();
	});
});
