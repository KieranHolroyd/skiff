import { describe, expect, test } from 'bun:test';
import { databaseBackupFormat } from './database-backup.ts';
import {
	databaseConnectionSnippets,
	databaseConnectionUrl,
	databaseEngineRegistry,
	databaseEngines,
	databaseEnvNames,
	databaseExtensionAllowlist,
	databaseExtensionCatalog,
	databaseImage,
	databasePublicUrlSchema,
	databasePublicUrlSchemes,
	databaseUpdateSchema,
	databaseUrlDatabase,
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

describe('database engines (D95)', () => {
	test('every engine has an image per version, a default in its list and a backup format or none', () => {
		for (const engine of databaseEngines) {
			const info = databaseEngineRegistry[engine];
			expect(info.versions).toContain(info.defaultVersion);
			for (const version of info.versions) expect(databaseImage(engine, version)).toMatch(/^docker\.io\//);
			expect(databaseBackupFormat(engine) !== null).toBe(info.capabilities.backups);
			expect(info.defaultMemoryMb).toBeGreaterThanOrEqual(info.minMemoryMb);
		}
	});

	test('Postgres 18 runs the pgvector image; 16 and 17 stay on alpine (D124)', () => {
		expect(databaseImage('postgres', '17')).toBe('docker.io/library/postgres:17-alpine');
		expect(databaseImage('postgres', '18')).toBe('docker.io/pgvector/pgvector:0.8.7-pg18-trixie');
		expect(databaseEngineRegistry.postgres.defaultVersion).toBe('17');
	});

	test('URLs carry the engine query and the fixed Valkey database', () => {
		expect(
			databaseConnectionUrl({
				scheme: 'mongodb',
				user: 'shop',
				pass: 'p@ss',
				host: 'db-1',
				port: 27017,
				database: 'shop',
				query: 'authSource=admin',
			}),
		).toBe('mongodb://shop:p%40ss@db-1:27017/shop?authSource=admin');
		expect(databaseUrlDatabase('valkey', 'shop')).toBe('0');
		expect(databaseUrlDatabase('mysql', 'shop')).toBe('shop');
	});

	test('MongoDB attachments also get <PREFIX>_URI; snippets follow the engine', () => {
		expect(databaseEnvNames('MONGODB', { engine: 'mongodb' })).toContain('MONGODB_URI');
		expect(databaseEnvNames('DATABASE', { engine: 'mysql' })).not.toContain('DATABASE_URI');
		const redis = databaseConnectionSnippets({
			directUrl: 'redis://u:p@127.0.0.1:16000/0',
			poolerUrl: null,
			sslmode: 'disable',
			caPem: null,
			engine: 'valkey',
			envPrefix: 'REDIS',
		});
		expect(redis.valkeyCli).toBe('valkey-cli -u "redis://u:p@127.0.0.1:16000/0"');
		expect(redis.bullmq).toContain('process.env.REDIS_URL');
		expect(Object.keys(redis)).not.toContain('psql');
	});

	test('public URLs must use a scheme of the database engine family', () => {
		expect(databasePublicUrlSchema.safeParse('mongodb+srv://u:p@cluster.example.com/db').success).toBe(true);
		expect(databasePublicUrlSchema.safeParse('ftp://u:p@example.com').success).toBe(false);
		expect(databasePublicUrlSchemes('redis')).toEqual(['redis', 'rediss']);
	});
});
