import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { databaseAlias, databaseEngineRegistry, DEFAULT_FEATURES } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

/** Engines beyond Postgres (docs/DATABASES.md §17, D95). */
const dir = mkdtempSync(join(tmpdir(), 'skiff-db-engines-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const clock = Date.parse('2026-11-05T10:00:00Z');

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
		// TLS and PITR on: neither may leak onto an engine that does not support them.
		features: { ...DEFAULT_FEATURES, DB_TLS: true, PITR: true },
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('database engines', () => {
	let edgeId = '';
	let edgeToken = '';

	test('every engine is created with its defaults and only the features it supports', () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		edgeId = joined.nodeId;
		edgeToken = joined.token;
		core.nodes.update(owner, edgeId, { sliceMemoryMb: 8192 });
		for (const [name, engine] of [
			['shop-sql', 'mysql'],
			['shop-maria', 'mariadb'],
			['shop-docs', 'mongodb'],
			['shop-cache', 'valkey'],
			['shop-redis', 'redis'],
		] as const) {
			const info = databaseEngineRegistry[engine];
			const db = core.databases.create(owner, { name, engine, memoryMb: info.minMemoryMb });
			expect(db).toMatchObject({
				engine,
				engineLabel: info.label,
				version: info.defaultVersion,
				capabilities: info.capabilities,
				// The schema defaults pooler to true; engines without PgBouncer never get one.
				pooler: { enabled: false, port: null },
				tls: { enabled: false, mode: 'disable' },
				internalHost: { container: `${databaseAlias(db.id)}:${info.containerPort}` },
			});
			expect(db.backup.enabled).toBe(info.capabilities.backups);
			// Only engines with the stats sampler get a monitor role.
			expect(core.databases.listCredentials(owner, name).map((item) => item.role)).toEqual(['owner']);
		}
		expect(core.databases.get(owner, 'shop-cache').databaseName).toBe('0');
	});

	test('engine names, reserved names and extensions are validated per engine', () => {
		expect(() => core.databases.create(owner, { name: 'x'.repeat(33), engine: 'mysql' })).toThrow(/at most 32/);
		expect(() => core.databases.create(owner, { name: 'admin', engine: 'mongodb' })).toThrow(/reserved/);
		expect(() => core.databases.create(owner, { name: 'root', engine: 'mariadb' })).toThrow(/reserved/);
		expect(() => core.databases.create(owner, { name: 'vec-db', engine: 'mysql', extensions: ['pgvector'] })).toThrow(
			/only available for PostgreSQL/,
		);
		expect(() => core.databases.create(owner, { name: 'old-sql', engine: 'mysql', version: '5.7' })).toThrow(/versions/);
		expect(() => core.databases.create(owner, { name: 'tiny-sql', engine: 'mysql', memoryMb: 256 })).toThrow(
			/at least 384 MB/,
		);
	});

	test('desired state and activation use each engine\'s image and env, with no monitor', async () => {
		const state = await core.nodes.desiredState(edgeToken);
		const mysql = state.workloads.find((workload) => workload.projectSlug === 'shop-sql')!;
		expect(mysql).toMatchObject({
			image: 'docker.io/library/mysql:8.4',
			database: { engine: 'mysql', version: '8.4' },
			env: { MYSQL_USER: 'shop_sql', MYSQL_DATABASE: 'shop_sql' },
		});
		expect(mysql.database).not.toHaveProperty('tls');
		expect(mysql).not.toHaveProperty('pooler');
		const activation = core.workloads.activation(edgeId, mysql.id);
		expect(Object.keys(activation.env)).toEqual(['MYSQL_PASSWORD']);
		expect(activation.monitor).toBeUndefined();
		expect(activation.databaseSetup).toBeUndefined();

		const valkey = state.workloads.find((workload) => workload.projectSlug === 'shop-cache')!;
		expect(valkey).toMatchObject({ image: 'docker.io/valkey/valkey:9.1-alpine', env: { VALKEY_USER: 'shop_cache' } });
		// Plus the read-only studio principal, which the helper renders into the generated ACL (track G).
		expect(Object.keys(core.workloads.activation(edgeId, valkey.id).env)).toEqual(['VALKEY_PASSWORD', 'SKIFF_STUDIO_RO_PASSWORD']);
		const mongo = state.workloads.find((workload) => workload.projectSlug === 'shop-docs')!;
		expect(mongo.env).toEqual({ MONGO_INITDB_ROOT_USERNAME: 'shop_docs', MONGO_INITDB_DATABASE: 'shop_docs' });
		expect(JSON.stringify(state)).not.toContain(core.databases.credentials(owner, 'shop-sql').password);
	});

	test('credentials and attachments speak each engine\'s URL dialect', async () => {
		const mongo = core.databases.credentials(owner, 'shop-docs');
		expect(mongo.url).toMatch(/^mongodb:\/\/shop_docs:[^@]+@127\.0\.0\.1:\d+\/shop_docs\?authSource=admin$/);
		expect(Object.keys(mongo.connectionSnippets)).toContain('mongoose');
		const valkey = core.databases.credentials(owner, 'shop-cache');
		expect(valkey.url).toMatch(/^redis:\/\/shop_cache:[^@]+@127\.0\.0\.1:\d+\/0$/);
		expect(valkey.connectionSnippets.ioredis).toContain('REDIS_URL');
		expect(valkey.note).toContain('unencrypted');
		const mysql = core.databases.credentials(owner, 'shop-sql');
		expect(mysql.url).toMatch(/^mysql:\/\//);
		expect(mysql.connectionSnippets.prisma).toContain('provider = "mysql"');

		await core.projects.create(owner, {
			name: 'shop',
			slug: 'shop',
			runtime: 'container',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const project = core.projects.requireRow(owner, 'shop');
		// Each engine's default prefix: REDIS for Valkey, MONGODB for MongoDB, DATABASE otherwise.
		const cache = core.databases.attach(owner, project, { database: 'shop-cache' });
		expect(cache.attachment.envPrefix).toBe('REDIS');
		expect(cache.attachment.envNames).toEqual([
			'REDIS_URL',
			'REDIS_HOST',
			'REDIS_PORT',
			'REDIS_USER',
			'REDIS_PASSWORD',
			'REDIS_NAME',
		]);
		const docs = core.databases.attach(owner, project, { database: 'shop-docs' });
		expect(docs.attachment.envPrefix).toBe('MONGODB');
		expect(docs.attachment.envNames).toContain('MONGODB_URI');
		core.databases.attach(owner, project, { database: 'shop-sql' });

		const env = core.databases.consumerEnv(project.id, edgeId, 'container');
		const cacheView = core.databases.get(owner, 'shop-cache');
		expect(env.REDIS_HOST).toBe(databaseAlias(cacheView.id));
		expect(env.REDIS_PORT).toBe('6379');
		expect(env.REDIS_URL).toBe(`redis://shop_cache:${encodeURIComponent(valkey.password)}@${databaseAlias(cacheView.id)}:6379/0`);
		expect(env.MONGODB_URI).toBe(env.MONGODB_URL);
		expect(env.MONGODB_URL).toContain(':27017/shop_docs?authSource=admin');
		expect(env.DATABASE_URL).toContain(':3306/shop_sql');
		// `sslmode` means nothing to these engines, even with DB_TLS on.
		expect(env.DATABASE_SSL_MODE).toBeUndefined();
		expect(env.REDIS_POOL_URL).toBeUndefined();
	});

	test('postgres-only features are refused with a clear message', () => {
		expect(() => core.databases.update(owner, 'shop-sql', { pooler: true })).toThrow(/only available for PostgreSQL/);
		expect(() => core.databases.update(owner, 'shop-sql', { extensions: ['pg_trgm'] })).toThrow(
			/only available for PostgreSQL/,
		);
		expect(() => core.databases.createCredential(owner, 'shop-sql', { role: 'readonly' })).toThrow(
			/Named credentials is not available for MySQL/,
		);
		expect(() => core.databases.rotateCredentials(owner, 'shop-sql', { role: 'monitor' })).toThrow(/monitor role/);
		expect(() => core.databases.upgradeDatabase(owner, 'shop-sql', { targetVersion: '9.7' })).toThrow(/upgrade planner/);
		expect(() => core.databases.createBackup(owner, 'shop-cache')).toThrow(/Backups is not available for Valkey/);
		expect(() => core.databases.setBackupPolicy(owner, 'shop-redis', { enabled: true })).toThrow(/Backups/);
		expect(() => core.databases.setPitrPolicy(owner, 'shop-docs', { enabled: true })).toThrow(/Point-in-time/);
		expect(() =>
			core.databases.setPublicUrl(owner, 'shop-cache', { url: 'postgres://user:pass@db.example.com:5432/x' }),
		).toThrow(/redis:\/\/ or rediss:\/\//);
		expect(core.databases.setPublicUrl(owner, 'shop-cache', { url: 'rediss://user:pass@cache.example.com:6380' }).configured).toBe(
			true,
		);
	});

	test('supported features work: owner rotation, backups and forward-only upgrades', () => {
		expect(core.databases.rotateCredentials(owner, 'shop-cache', { role: 'owner' }).status).toBe('pending');
		expect(core.databases.createBackup(owner, 'shop-sql').format).toBe('mysqldump-sql');
		expect(core.databases.createBackup(owner, 'shop-docs').format).toBe('mongodump-archive-gzip');

		// MySQL 8.4 → 9.7 is an in-place LTS upgrade; going back is refused.
		expect(core.databases.update(owner, 'shop-sql', { version: '9.7' }).version).toBe('9.7');
		expect(() => core.databases.update(owner, 'shop-sql', { version: '8.4' })).toThrow(/cannot be downgraded/);
		// MongoDB majors need feature-compatibility steps, so never in place.
		expect(() => core.databases.update(owner, 'shop-docs', { version: '9.0' })).toThrow(/cannot be changed in place/);
		// A version some other engine ships is still not this engine's.
		expect(() => core.databases.update(owner, 'shop-cache', { version: '17' })).toThrow(/Valkey versions/);
	});

	test('bulk backups skip engines without backups instead of failing', () => {
		const result = core.serviceActions.backupAllDatabases(owner);
		expect(result.queued).toContain('shop-maria');
		expect(result.queued).not.toContain('shop-cache');
		expect(result.skipped.map((item) => item.name)).not.toContain('shop-cache');
	});

	test('the engine survives a round trip through SQLite', () => {
		const row = opened.sqlite
			.query<{ engine: string; engine_name: string }, [string]>('SELECT engine, engine_name FROM databases WHERE name = ?')
			.get('shop-cache');
		// The legacy column keeps its Postgres-only CHECK and default (0028).
		expect(row).toEqual({ engine: 'postgres', engine_name: 'valkey' });
	});
});
