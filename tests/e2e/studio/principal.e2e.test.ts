/**
 * Read-only studio principal end-to-end (plan 22, track G). For every engine, a container set up
 * the way Yoal runs it (owner env, MySQL root on the owner's password at localhost, Mongo's owner
 * in `admin`, the helper's generated Valkey/Redis config) gets `yoal_studio_ro` from the helper's
 * own statements (`apps/helper/src/studio-principal.ts`), executed with `docker exec` exactly as the
 * helper runs them with `podman exec`. Then:
 *
 * - the studio plugin, connected as the principal **without** its read-only session flags, can
 *   browse and read, and every write is refused by the database itself;
 * - re-applying is idempotent;
 * - Valkey/Redis: a restart without the generated config line loses the user, and with it keeps it.
 *
 *   YOAL_E2E_STUDIO=1 YOAL_E2E_ENGINE=docker bun test tests/e2e/studio/principal.e2e.test.ts
 *
 * `YOAL_E2E_STUDIO_RO_MATRIX=1` adds every other version Yoal ships. Without `YOAL_E2E_STUDIO=1`
 * it registers one skipped test.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { RedisClient, SQL } from 'bun';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	applyStudioPrincipal,
	containerExec,
	withKeyValueStudioUser,
	type StudioPrincipalOwner,
} from '../../../apps/helper/src/studio-principal.ts';
import { renderKeyValueConfig } from '../../../apps/helper/src/units.ts';
import { collect, rowsOf } from '../../../packages/studio/src/conformance.ts';
import type { StudioPlugin, StudioTarget } from '../../../packages/studio/src/driver.ts';
import { keyvaluePlugin } from '../../../packages/studio/src/plugins/keyvalue/index.ts';
import { MongoClient } from '../../../packages/studio/src/plugins/mongodb/test-support.ts';
import { mongodbPlugin } from '../../../packages/studio/src/plugins/mongodb/index.ts';
import { createConnection, DEFAULT_STUDIO_LIMITS } from '../../../packages/studio/src/plugins/mysql/test-support.ts';
import { mysqlPlugin } from '../../../packages/studio/src/plugins/mysql/index.ts';
import { postgresPlugin } from '../../../packages/studio/src/plugins/postgres/index.ts';
import type { StudioEvent } from '../../../packages/studio/src/protocol.ts';
import { ContainerRuntime, detectEngine, freePort, waitFor } from '../lib/containers.ts';

setDefaultTimeout(120_000);

/** Yoal passwords are 24 random bytes in base64url. */
const OWNER_PASSWORD = 'OwnerPw_0123456789-abcdefghijklm';
const RO_PASSWORD = 'StudioRo_0123456789-abcdefghijkl';
const RO_PASSWORD_2 = 'StudioRo_rotated_9876543210-zyxw';
const DB = 'shop_db';
const RO = 'yoal_studio_ro';

type Engine = StudioPrincipalOwner['engine'];

interface Case {
	engine: Engine;
	version: string;
	image: string;
	containerPort: number;
	plugin: StudioPlugin;
	/** Read the principal must be allowed. */
	read: string;
	/** Writes the database must refuse from the principal, even with no session flags. */
	writes: string[];
}

const cases: Case[] = [
	{
		engine: 'postgres',
		version: '17',
		image: 'postgres:17-alpine',
		containerPort: 5432,
		plugin: postgresPlugin,
		read: 'SELECT id, name FROM public.items ORDER BY id',
		writes: [
			"INSERT INTO public.items VALUES (9, 'x')",
			"UPDATE public.items SET name = 'x'",
			'DELETE FROM public.items',
			'CREATE TABLE public.evil (a int)',
			'DROP TABLE public.items',
			'TRUNCATE public.items',
		],
	},
	{
		engine: 'mysql',
		version: '8.4',
		image: 'mysql:8.4',
		containerPort: 3306,
		plugin: mysqlPlugin,
		read: 'SELECT id, name FROM items ORDER BY id',
		writes: [
			"INSERT INTO items VALUES (9, 'x')",
			"UPDATE items SET name = 'x'",
			'DELETE FROM items',
			'CREATE TABLE evil (a INT)',
			'DROP TABLE items',
			'TRUNCATE items',
		],
	},
	{
		engine: 'mariadb',
		version: '11.8',
		image: 'mariadb:11.8',
		containerPort: 3306,
		plugin: mysqlPlugin,
		read: 'SELECT id, name FROM items ORDER BY id',
		writes: [
			"INSERT INTO items VALUES (9, 'x')",
			"UPDATE items SET name = 'x'",
			'DELETE FROM items',
			'CREATE TABLE evil (a INT)',
			'DROP TABLE items',
			'TRUNCATE items',
		],
	},
	{
		engine: 'mongodb',
		version: '8.0',
		image: 'mongo:8.0',
		containerPort: 27017,
		plugin: mongodbPlugin,
		read: '{"find":"items","filter":{}}',
		writes: [
			'{"insert":"items","documents":[{"_id":9,"name":"x"}]}',
			'{"update":"items","updates":[{"q":{},"u":{"$set":{"name":"x"}},"multi":true}]}',
			'{"delete":"items","deletes":[{"q":{},"limit":0}]}',
			'{"drop":"items"}',
			'{"create":"evil"}',
		],
	},
	{
		engine: 'valkey',
		version: '9.1',
		image: 'valkey/valkey:9.1-alpine',
		containerPort: 6379,
		plugin: keyvaluePlugin,
		read: 'GET item:1',
		writes: ['SET item:1 x', 'DEL item:2', 'FLUSHALL', 'CONFIG SET appendonly no', 'ACL SETUSER evil on', 'EVAL "return 1" 0'],
	},
	{
		engine: 'redis',
		version: '8.10',
		image: 'redis:8.10-alpine',
		containerPort: 6379,
		plugin: keyvaluePlugin,
		read: 'GET item:1',
		writes: ['SET item:1 x', 'DEL item:2', 'FLUSHALL', 'CONFIG SET appendonly no', 'ACL SETUSER evil on', 'EVAL "return 1" 0'],
	},
];

if (process.env.YOAL_E2E_STUDIO_RO_MATRIX === '1') {
	const more: Array<[Engine, string, string]> = [
		['postgres', '16', 'postgres:16-alpine'],
		['mysql', '9.7', 'mysql:9.7'],
		['mariadb', '11.4', 'mariadb:11.4'],
		['mongodb', '9.0', 'mongo:9.0'],
		['valkey', '8.1', 'valkey/valkey:8.1-alpine'],
		['redis', '8.8', 'redis:8.8-alpine'],
	];
	for (const [engine, version, image] of more) {
		const base = cases.find((item) => item.engine === engine)!;
		cases.push({ ...base, version, image });
	}
}

const enabled = process.env.YOAL_E2E_STUDIO === '1';
const engine = enabled ? await detectEngine() : null;

if (!enabled || !engine) {
	test.skip('studio read-only principal e2e (set YOAL_E2E_STUDIO=1 and have Docker or Podman)', () => {});
} else {
	const tempDir = await mkdtemp(join(tmpdir(), 'studio-ro-'));
	const runtime = new ContainerRuntime(engine, tempDir);
	const network = `studio-ro-${runtime.runId}`;
	const instances = await Promise.all(
		cases.map(async (item) => ({
			...item,
			label: `${item.engine} ${item.version}`,
			name: `studio-ro-${item.engine}-${item.version.replace('.', '')}-${runtime.runId}`,
			port: await freePort(),
			configPath: join(tempDir, `${item.engine}-${item.version}.conf`),
		})),
	);
	type Instance = (typeof instances)[number];

	const owner = (instance: Instance): StudioPrincipalOwner => ({
		engine: instance.engine,
		user: DB,
		password: OWNER_PASSWORD,
		database: instance.engine === 'valkey' || instance.engine === 'redis' ? '' : DB,
	});
	const exec = (instance: Instance) => containerExec(runtime.engine.command, instance.name);
	const target = (instance: Instance, who: { user: string; password: string }): StudioTarget => ({
		engine: instance.engine,
		version: instance.version,
		host: '127.0.0.1',
		port: instance.port,
		database: instance.engine === 'valkey' || instance.engine === 'redis' ? '0' : DB,
		user: who.user,
		password: who.password,
		tls: null,
	});

	beforeAll(async () => {
		await runtime.createNetwork(network);
		await Promise.all(instances.map((instance) => start(instance)));
	}, 400_000);

	afterAll(async () => {
		await runtime.cleanup();
		await rm(tempDir, { recursive: true, force: true });
	}, 120_000);

	async function start(instance: Instance): Promise<void> {
		const common = { name: instance.name, image: instance.image, network, ports: [[instance.port, instance.containerPort]] as Array<[number, number]> };
		switch (instance.engine) {
			case 'postgres':
				// The image makes POSTGRES_USER the cluster owner, exactly as on a node.
				await runtime.runContainer({ ...common, env: { POSTGRES_USER: DB, POSTGRES_PASSWORD: OWNER_PASSWORD, POSTGRES_DB: DB } });
				break;
			case 'mysql':
			case 'mariadb': {
				// The helper's fixed env (D61): root on the owner's password, bound to localhost.
				const prefix = instance.engine === 'mysql' ? 'MYSQL' : 'MARIADB';
				await runtime.runContainer({
					...common,
					env: {
						[`${prefix}_USER`]: DB,
						[`${prefix}_PASSWORD`]: OWNER_PASSWORD,
						[`${prefix}_DATABASE`]: DB,
						[`${prefix}_ROOT_PASSWORD`]: OWNER_PASSWORD,
						[`${prefix}_ROOT_HOST`]: 'localhost',
					},
				});
				break;
			}
			case 'mongodb':
				await runtime.runContainer({
					...common,
					env: { MONGO_INITDB_ROOT_USERNAME: DB, MONGO_INITDB_ROOT_PASSWORD: OWNER_PASSWORD, MONGO_INITDB_DATABASE: DB },
				});
				break;
			case 'valkey':
			case 'redis':
				// The helper's generated config, mounted where the database unit mounts it.
				await writeConfig(instance, null);
				await runtime.runContainer({
					...common,
					volumes: [[instance.configPath, '/etc/yoal/server.conf']],
					command: [instance.engine === 'valkey' ? 'valkey-server' : 'redis-server', '/etc/yoal/server.conf'],
				});
				break;
		}
		await waitFor(`${instance.label} ready`, () => seed(instance), { timeoutMs: 240_000, intervalMs: 1_000 });
	}

	async function writeConfig(instance: Instance, studioPassword: string | null): Promise<void> {
		const base = renderKeyValueConfig({ user: DB, password: OWNER_PASSWORD, memoryMb: 256 });
		// Same inode, so the bind mount sees the new content on the next start.
		await writeFile(instance.configPath, studioPassword ? withKeyValueStudioUser(base, studioPassword) : base);
		await chmod(instance.configPath, 0o644);
	}

	/** Seed three rows as the owner; true once the engine accepts the owner over TCP. */
	async function seed(instance: Instance): Promise<boolean> {
		switch (instance.engine) {
			case 'postgres': {
				const sql = new SQL({ adapter: 'postgres', hostname: '127.0.0.1', port: instance.port, username: DB, password: OWNER_PASSWORD, database: DB, max: 1, connectionTimeout: 3, tls: false });
				try {
					await sql.unsafe('CREATE TABLE IF NOT EXISTS public.items (id int PRIMARY KEY, name text NOT NULL)');
					await sql.unsafe("INSERT INTO public.items VALUES (1, 'one'), (2, 'two'), (3, 'three') ON CONFLICT DO NOTHING");
					return true;
				} finally {
					await sql.close();
				}
			}
			case 'mysql':
			case 'mariadb': {
				const connection = await createConnection({ host: '127.0.0.1', port: instance.port, user: DB, password: OWNER_PASSWORD, database: DB, connectTimeout: 2_000 });
				try {
					await connection.query('CREATE TABLE IF NOT EXISTS items (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL)');
					await connection.query("INSERT IGNORE INTO items VALUES (1, 'one'), (2, 'two'), (3, 'three')");
					return true;
				} finally {
					await connection.end();
				}
			}
			case 'mongodb': {
				const client = new MongoClient(`mongodb://${DB}:${OWNER_PASSWORD}@127.0.0.1:${instance.port}/?authSource=admin`, { serverSelectionTimeoutMS: 2_000 });
				try {
					await client.connect();
					const items = client.db(DB).collection<{ _id: number; name: string }>('items');
					if ((await items.countDocuments()) === 0)
						await items.insertMany([{ _id: 1, name: 'one' }, { _id: 2, name: 'two' }, { _id: 3, name: 'three' }]);
					return true;
				} finally {
					await client.close();
				}
			}
			case 'valkey':
			case 'redis': {
				const client = new RedisClient(`redis://${DB}:${OWNER_PASSWORD}@127.0.0.1:${instance.port}/0`, { autoReconnect: false, connectionTimeout: 2_000 });
				try {
					await client.connect();
					await client.send('MSET', ['item:1', 'one', 'item:2', 'two', 'item:3', 'three']);
					return true;
				} finally {
					client.close();
				}
			}
		}
	}

	/** The owner's view of the data: three rows, untouched. */
	async function ownerSnapshot(instance: Instance): Promise<string> {
		switch (instance.engine) {
			case 'postgres': {
				const sql = new SQL({ adapter: 'postgres', hostname: '127.0.0.1', port: instance.port, username: DB, password: OWNER_PASSWORD, database: DB, max: 1, tls: false });
				try {
					const rows = await sql.unsafe("SELECT string_agg(id || ':' || name, ',' ORDER BY id) AS s, (SELECT count(*) FROM pg_tables WHERE tablename = 'evil') AS evil FROM public.items");
					return `${rows[0].s}|evil=${rows[0].evil}`;
				} finally {
					await sql.close();
				}
			}
			case 'mysql':
			case 'mariadb': {
				const connection = await createConnection({ host: '127.0.0.1', port: instance.port, user: DB, password: OWNER_PASSWORD, database: DB });
				try {
					const [rows] = await connection.query("SELECT GROUP_CONCAT(CONCAT(id, ':', name) ORDER BY id) AS s, (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'evil') AS evil FROM items");
					const row = (rows as Array<{ s: string; evil: number }>)[0]!;
					return `${row.s}|evil=${Number(row.evil)}`;
				} finally {
					await connection.end();
				}
			}
			case 'mongodb': {
				const client = new MongoClient(`mongodb://${DB}:${OWNER_PASSWORD}@127.0.0.1:${instance.port}/?authSource=admin`);
				try {
					await client.connect();
					const docs = await client.db(DB).collection<{ _id: number; name: string }>('items').find().sort({ _id: 1 }).toArray();
					const evil = (await client.db(DB).listCollections({ name: 'evil' }).toArray()).length;
					return `${docs.map((doc) => `${doc._id}:${doc.name}`).join(',')}|evil=${evil}`;
				} finally {
					await client.close();
				}
			}
			case 'valkey':
			case 'redis': {
				const client = new RedisClient(`redis://${DB}:${OWNER_PASSWORD}@127.0.0.1:${instance.port}/0`, { autoReconnect: false });
				try {
					await client.connect();
					const values = (await client.send('MGET', ['item:1', 'item:2', 'item:3'])) as string[];
					const evil = (await client.send('ACL', ['LIST'])) as string[];
					return `${values.map((value, i) => `${i + 1}:${value}`).join(',')}|evil=${evil.filter((line) => line.startsWith('user evil')).length}|aof=${(await client.send('CONFIG', ['GET', 'appendonly']) as string[])[1]}`;
				} finally {
					client.close();
				}
			}
		}
	}

	async function run(session: Awaited<ReturnType<StudioPlugin['connect']>>, input: string): Promise<StudioEvent[]> {
		try {
			return await collect(session.run(input, { maxRows: 100, timeoutMs: 10_000 }, new AbortController().signal));
		} catch (error) {
			return [{ t: 'error', code: 'thrown', message: error instanceof Error ? error.message : String(error) }];
		}
	}

	const errorOf = (events: StudioEvent[]) => events.find((event): event is Extract<StudioEvent, { t: 'error' }> => event.t === 'error');

	for (const instance of instances) {
		describe(`read-only principal: ${instance.label}`, () => {
			let before = '';

			test('the helper statements create it, and a re-apply is idempotent', async () => {
				before = await ownerSnapshot(instance);
				await applyStudioPrincipal(exec(instance), owner(instance), RO_PASSWORD);
				await applyStudioPrincipal(exec(instance), owner(instance), RO_PASSWORD);
			});

			test('the studio plugin reads as the principal; the database refuses every write without session flags', async () => {
				// `readOnly: false`: no BEGIN READ ONLY, no command gate. Only the account stands in the way.
				const session = await instance.plugin.connect(target(instance, { user: RO, password: RO_PASSWORD }), { readOnly: false, limits: DEFAULT_STUDIO_LIMITS });
				try {
					const roots = await session.tree([], new AbortController().signal);
					expect(roots.length).toBeGreaterThan(0);
					const read = await run(session, instance.read);
					expect(errorOf(read)).toBeUndefined();
					expect(rowsOf(read).length).toBeGreaterThanOrEqual(1);
					for (const input of instance.writes) {
						const events = await run(session, input);
						const error = errorOf(events);
						if (!error) throw new Error(`${instance.label}: "${input}" was not refused: ${JSON.stringify(events).slice(0, 300)}`);
					}
				} finally {
					await session.close();
				}
				expect(await ownerSnapshot(instance)).toBe(before);
			});

			test('a read-only studio session works as the principal (the plugin gate included)', async () => {
				const session = await instance.plugin.connect(target(instance, { user: RO, password: RO_PASSWORD }), { readOnly: true, limits: DEFAULT_STUDIO_LIMITS });
				try {
					const read = await run(session, instance.read);
					expect(errorOf(read)).toBeUndefined();
					expect(rowsOf(read).length).toBeGreaterThanOrEqual(1);
					expect(errorOf(await run(session, instance.writes[0]!))).toBeDefined();
				} finally {
					await session.close();
				}
			});

			if (instance.engine === 'postgres')
				test('postgres: lifting the read-only default does not help, and the connection limit is set', async () => {
					const sql = new SQL({ adapter: 'postgres', hostname: '127.0.0.1', port: instance.port, username: RO, password: RO_PASSWORD, database: DB, max: 1, tls: false });
					try {
						await sql.unsafe('SET default_transaction_read_only = off');
						await expect(sql.unsafe("INSERT INTO public.items VALUES (9, 'x')")).rejects.toThrow(/permission denied/);
						const [role] = await sql.unsafe("SELECT rolconnlimit, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'yoal_studio_ro'");
						expect(role).toEqual({ rolconnlimit: 4, rolsuper: false, rolcreaterole: false, rolcreatedb: false });
					} finally {
						await sql.close();
					}
				});

			if (instance.engine === 'mysql' || instance.engine === 'mariadb')
				test(`${instance.engine}: grants are exactly SELECT, SHOW VIEW on the database with a connection cap`, async () => {
					const connection = await createConnection({ host: '127.0.0.1', port: instance.port, user: RO, password: RO_PASSWORD, database: DB });
					try {
						const [rows] = await connection.query('SHOW GRANTS');
						const grants = (rows as Array<Record<string, string>>).map((row) => Object.values(row)[0]!).join('\n');
						expect(grants).toMatch(/GRANT SELECT, SHOW VIEW ON `shop_db`\.\* TO `yoal_studio_ro`@`%`/);
						expect(grants).not.toMatch(/INSERT|UPDATE|DELETE|ALL PRIVILEGES/);
						await expect(connection.query('SELECT * FROM mysql.user')).rejects.toThrow(/denied/);
					} finally {
						await connection.end();
					}
				});

			test('a new password replaces the old one on re-apply', async () => {
				await applyStudioPrincipal(exec(instance), owner(instance), RO_PASSWORD_2);
				await expect(instance.plugin.connect(target(instance, { user: RO, password: RO_PASSWORD }), { readOnly: true, limits: DEFAULT_STUDIO_LIMITS }).then((session) => session.tree([], new AbortController().signal).finally(() => session.close()))).rejects.toThrow();
				await applyStudioPrincipal(exec(instance), owner(instance), RO_PASSWORD);
			});

			if (instance.engine === 'valkey' || instance.engine === 'redis')
				test(`${instance.engine}: the ACL user survives a restart only through the generated config`, async () => {
					const login = async () => {
						const client = new RedisClient(`redis://${RO}:${RO_PASSWORD}@127.0.0.1:${instance.port}/0`, { autoReconnect: false, connectionTimeout: 2_000 });
						try {
							await client.connect();
							return (await client.send('DBSIZE', [])) as number;
						} finally {
							client.close();
						}
					};
					const restart = async () => {
						await runtime.exec(['restart', instance.name]);
						await waitFor(`${instance.label} back`, () => seed(instance), { timeoutMs: 60_000 });
					};
					expect(await login()).toBeGreaterThanOrEqual(3);
					// Live only: gone after a restart.
					await restart();
					await expect(login()).rejects.toThrow();
					// What the helper does: apply live and write the line into the generated config.
					await applyStudioPrincipal(exec(instance), owner(instance), RO_PASSWORD);
					await writeConfig(instance, RO_PASSWORD);
					await restart();
					expect(await login()).toBeGreaterThanOrEqual(3);
				});
		});
	}
}
