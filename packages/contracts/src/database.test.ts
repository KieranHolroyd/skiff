import { describe, expect, test } from 'bun:test';
import {
	databaseConnectionSnippets,
	databaseConnectionUrl,
	databaseEnvNames,
	databaseExtensionAllowlist,
	databaseExtensionCatalog,
	databaseUpdateSchema,
} from './database.ts';

describe('database connection URLs', () => {
	test('omits sslmode when TLS is disabled', () => {
		expect(
			databaseConnectionUrl({
				scheme: 'postgres',
				user: 'main_db',
				pass: 'p@ss word',
				host: '127.0.0.1',
				port: 15432,
				database: 'main_db',
				sslmode: 'disable',
			}),
		).toBe('postgres://main_db:p%40ss%20word@127.0.0.1:15432/main_db');
	});

	test('appends sslmode=require for TLS connections', () => {
		const url = databaseConnectionUrl({
			scheme: 'postgres',
			user: 'main_db',
			pass: 'secret',
			host: 'db-abc',
			port: 5432,
			database: 'main_db',
			sslmode: 'require',
		});
		expect(url).toBe('postgres://main_db:secret@db-abc:5432/main_db?sslmode=require');
	});
});

describe('database env names', () => {
	test('adds TLS and pooled names only when the features are on', () => {
		expect(databaseEnvNames('DATABASE')).toContain('DATABASE_URL');
		expect(databaseEnvNames('DATABASE')).not.toContain('DATABASE_CA_CERT');
		const names = databaseEnvNames('APP_DB', { pooler: true, tls: true });
		expect(names).toEqual(
			expect.arrayContaining([
				'APP_DB_URL',
				'APP_DB_SSL_MODE',
				'APP_DB_CA_CERT',
				'APP_DB_POOL_URL',
				'APP_DB_POOL_HOST',
				'APP_DB_POOL_PORT',
			]),
		);
	});
});

describe('connection snippets', () => {
	test('covers the documented clients and prefers the pooled URL', () => {
		const snippets = databaseConnectionSnippets({
			directUrl: 'postgres://u:p@127.0.0.1:15432/db?sslmode=require',
			poolerUrl: 'postgres://u:p@127.0.0.1:16432/db?sslmode=require',
			sslmode: 'require',
			caPem: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n',
		});
		for (const key of [
			'psql',
			'direct',
			'prisma',
			'drizzle',
			'kysely',
			'django',
			'rails',
			'pgx',
			'nodePostgres',
			'verifyFull',
		])
			expect(snippets[key]).toBeTruthy();
		expect(snippets.psql).toContain(':16432/');
		expect(snippets.direct).toContain(':15432/');
		expect(snippets.verifyFull).toContain('sslmode=verify-full');
	});

	test('says TLS is disabled when there is no CA', () => {
		const snippets = databaseConnectionSnippets({
			directUrl: 'postgres://u:p@127.0.0.1:15432/db',
			poolerUrl: null,
			sslmode: 'disable',
			caPem: null,
		});
		expect(snippets.verifyFull).toContain('TLS is disabled');
	});
});

describe('database extensions', () => {
	test('every allowlisted extension has a catalog entry with a safe SQL name', () => {
		expect(Object.keys(databaseExtensionCatalog).sort()).toEqual([...databaseExtensionAllowlist].sort());
		for (const info of Object.values(databaseExtensionCatalog)) {
			expect(info.sqlName).toMatch(/^[a-z0-9_-]+$/);
		}
		expect(databaseExtensionCatalog.pgvector.sqlName).toBe('vector');
	});

	test('network, filesystem and procedural-language extensions stay off the allowlist', () => {
		const refused = ['dblink', 'postgres_fdw', 'file_fdw', 'adminpack', 'plpython3u', 'plperlu', 'plperl', 'pg_surgery'];
		for (const name of refused) {
			expect(databaseUpdateSchema.safeParse({ extensions: [name] }).success).toBe(false);
		}
	});

	test('the whole allowlist can be enabled at once', () => {
		expect(databaseUpdateSchema.safeParse({ extensions: [...databaseExtensionAllowlist] }).success).toBe(true);
	});
});
