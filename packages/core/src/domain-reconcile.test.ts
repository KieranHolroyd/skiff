import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createDb } from '@skiff/db';
import { reconcilePlatformDomains } from './domain-reconcile.ts';

/** Only the columns the reconcile touches. */
function db(): Database {
	const sqlite = new Database(':memory:');
	sqlite.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
	sqlite.run('CREATE TABLE deployments (id TEXT PRIMARY KEY, preview_host TEXT NOT NULL)');
	sqlite.run('CREATE TABLE storage_instances (id TEXT PRIMARY KEY, public_host TEXT)');
	return sqlite;
}

const hosts = (sqlite: Database, table: string, column: string) =>
	sqlite.query<{ host: string | null }, []>(`SELECT ${column} AS host FROM ${table} ORDER BY id`).all().map((row) => row.host);
const stateVersion = (sqlite: Database) =>
	sqlite.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'state_version'").get()?.value ?? null;

const ip = { platformOrigin: 'http://203.0.113.7', contentDomain: '203-0-113-7.sslip.io' };

describe('reconcilePlatformDomains', () => {
	test('the first boot only records the current domains', () => {
		const sqlite = db();
		sqlite.run("INSERT INTO deployments VALUES ('d1', 'blog--abc.203-0-113-7.sslip.io')");
		expect(reconcilePlatformDomains(sqlite, ip).changed).toBe(false);
		expect(hosts(sqlite, 'deployments', 'preview_host')).toEqual(['blog--abc.203-0-113-7.sslip.io']);
		expect(stateVersion(sqlite)).toBeNull();
		expect(reconcilePlatformDomains(sqlite, ip).changed).toBe(false);
	});

	test('a new content domain rewrites stored preview and storage hosts and bumps desired state', () => {
		const sqlite = db();
		reconcilePlatformDomains(sqlite, ip);
		sqlite.run("INSERT INTO deployments VALUES ('d1', 'blog--abc.203-0-113-7.sslip.io'), ('d2', 'shop--def.203-0-113-7.sslip.io')");
		// A row under some other suffix (an older domain nobody migrated) is left alone.
		sqlite.run("INSERT INTO deployments VALUES ('d3', 'old--ghi.legacy.example')");
		sqlite.run("INSERT INTO storage_instances VALUES ('s1', 'media--s3.203-0-113-7.sslip.io'), ('s2', NULL)");
		sqlite.run("INSERT INTO settings VALUES ('state_version', '7', 0)");

		const result = reconcilePlatformDomains(sqlite, { platformOrigin: 'https://control.example.com', contentDomain: 'example.dev' });
		expect(result).toEqual({ changed: true, previousContentDomain: '203-0-113-7.sslip.io', previews: 2, storage: 1 });
		expect(hosts(sqlite, 'deployments', 'preview_host')).toEqual(['blog--abc.example.dev', 'shop--def.example.dev', 'old--ghi.legacy.example']);
		expect(hosts(sqlite, 'storage_instances', 'public_host')).toEqual(['media--s3.example.dev', null]);
		expect(stateVersion(sqlite)).toBe('8');
		expect(reconcilePlatformDomains(sqlite, { platformOrigin: 'https://control.example.com', contentDomain: 'example.dev' }).changed).toBe(false);
	});

	test('a suffix match is on whole labels only', () => {
		const sqlite = db();
		reconcilePlatformDomains(sqlite, { platformOrigin: 'http://x.test', contentDomain: 'example.dev' });
		sqlite.run("INSERT INTO deployments VALUES ('d1', 'a--1.notexample.dev'), ('d2', 'a--2.example.dev')");
		reconcilePlatformDomains(sqlite, { platformOrigin: 'http://x.test', contentDomain: 'sites.example.org' });
		expect(hosts(sqlite, 'deployments', 'preview_host')).toEqual(['a--1.notexample.dev', 'a--2.sites.example.org']);
	});

	test('a platform-origin change alone bumps desired state without touching hosts', () => {
		const sqlite = db();
		reconcilePlatformDomains(sqlite, ip);
		sqlite.run("INSERT INTO deployments VALUES ('d1', 'blog--abc.203-0-113-7.sslip.io')");
		const result = reconcilePlatformDomains(sqlite, { ...ip, platformOrigin: 'http://control.example.com' });
		expect(result).toMatchObject({ changed: true, previews: 0 });
		expect(stateVersion(sqlite)).toBe('1');
		expect(hosts(sqlite, 'deployments', 'preview_host')).toEqual(['blog--abc.203-0-113-7.sslip.io']);
	});

	test('runs against the real schema', () => {
		const { sqlite } = createDb({ path: ':memory:' });
		reconcilePlatformDomains(sqlite, ip);
		expect(reconcilePlatformDomains(sqlite, { ...ip, contentDomain: 'example.dev' })).toMatchObject({ changed: true });
	});
});
