/**
 * MySQL/MariaDB studio plugin end-to-end (plan 22, Phase 2 track B): the shared conformance
 * suite plus engine-specific checks, against disposable `mysql:8.4` and `mariadb:11.8`
 * containers (and `mysql:9.7` / `mariadb:11.4` when those images are already present).
 *
 *   YOAL_E2E_STUDIO=1 YOAL_E2E_ENGINE=docker bun test tests/e2e/studio/mysql.e2e.test.ts
 *
 * Without `YOAL_E2E_STUDIO=1` it registers one skipped test, so the root `bun test` stays fast.
 *
 * Conformance runs twice per engine: read-only sessions on the owner credential (the interim
 * reality until track G lands), and on a `SELECT, SHOW VIEW` principal (the Phase 3 one).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, describeConformance, rowsOf } from '../../../packages/studio/src/conformance.ts';
import type { StudioSession, StudioTarget } from '../../../packages/studio/src/driver.ts';
import { mysqlPlugin } from '../../../packages/studio/src/plugins/mysql/index.ts';
import {
	createConnection,
	DEFAULT_STUDIO_LIMITS,
	type Connection,
	type RowDataPacket,
} from '../../../packages/studio/src/plugins/mysql/test-support.ts';
import { StudioError, type Cell, type StudioEvent } from '../../../packages/studio/src/protocol.ts';
import { ContainerRuntime, detectEngine, freePort, waitFor } from '../lib/containers.ts';

const ROW_COUNT = 250;
const ROOT_PASSWORD = 'root-pw';
const OWNER = { user: 'app', password: 'owner p@ss:/?' };
const READER = { user: 'yoal_studio_ro', password: 'reader-pw' };
const TABLE = 'studio_items';
const VIEW = 'studio_item_names';
const NO_KEY = 'studio_nokey';

interface Instance {
	engine: 'mysql' | 'mariadb';
	image: string;
	version: string;
	port: number;
	name: string;
}

/** Deterministic fixture rows; id 250 has `big` = 2.5e16, past 2^53. */
function fixtureValues(): string {
	const rows: string[] = [];
	for (let n = 1; n <= ROW_COUNT; n += 1) {
		const created = new Date(Date.UTC(2026, 0, 1, 0, 0, n, n)).toISOString().replace('T', ' ').replace('Z', '');
		const data = Buffer.from([n % 256, 0, 255]).toString('hex');
		rows.push(
			`(${n}, 'item ${String(n).padStart(3, '0')}', ${(n * 1.25).toFixed(2)}, ${BigInt(n) * 100_000_000_000_000n}, ` +
				`UNHEX('${data}'), '{"even": ${n % 2 === 0}, "n": ${n}}', '${created}')`,
		);
	}
	return rows.join(',\n');
}

const SEED = `
DROP PROCEDURE IF EXISTS esc;
DROP VIEW IF EXISTS ${VIEW};
DROP TABLE IF EXISTS ${TABLE}, ${NO_KEY}, studio_zero, ro_escape;
CREATE TABLE ${TABLE} (
	id INT PRIMARY KEY,
	name VARCHAR(100) NOT NULL,
	amount DECIMAL(12,2),
	big BIGINT,
	data VARBINARY(64),
	meta JSON,
	created DATETIME(3),
	KEY ${TABLE}_name (name)
);
INSERT INTO ${TABLE} VALUES ${fixtureValues()};
CREATE VIEW ${VIEW} AS SELECT id, name FROM ${TABLE};
CREATE TABLE ${NO_KEY} (a INT, b VARCHAR(10));
INSERT INTO ${NO_KEY} VALUES (1, 'one'), (2, 'two'), (3, 'three');
SET SESSION sql_mode = '';
CREATE TABLE studio_zero (id INT PRIMARY KEY, d DATETIME, dd DATE);
INSERT INTO studio_zero VALUES (1, '0000-00-00 00:00:00', '0000-00-00');
`;

/** A procedure that escapes a read-only transaction from inside one CALL (both engines). */
const ESCAPE_PROCEDURE =
	'CREATE PROCEDURE esc() BEGIN SET SESSION transaction_read_only = OFF; COMMIT; DELETE FROM studio_items WHERE id = 250; END';

const signal = () => new AbortController().signal;

function errorOf(events: StudioEvent[]): Extract<StudioEvent, { t: 'error' }> | undefined {
	return events.find((e): e is Extract<StudioEvent, { t: 'error' }> => e.t === 'error');
}

if (process.env.YOAL_E2E_STUDIO !== '1') {
	test.skip('mysql/mariadb studio e2e (set YOAL_E2E_STUDIO=1 to run)', () => {});
} else {
	setDefaultTimeout(60_000);
	const engine = await detectEngine();
	if (!engine) throw new Error('YOAL_E2E_STUDIO=1 needs Podman or Docker (or set YOAL_E2E_ENGINE).');
	const probe = new ContainerRuntime(engine, tmpdir());
	const hasImage = async (image: string) =>
		(await probe.exec(['image', 'inspect', image], { check: false, timeoutMs: 30_000 })).code === 0;

	const instances: Instance[] = [];
	for (const [kind, version, required] of [
		['mysql', '8.4', true],
		['mariadb', '11.8', true],
		['mysql', '9.7', false],
		['mariadb', '11.4', false],
	] as const) {
		const image = `${kind}:${version}`;
		// The plan's primary versions are required (pulled if needed); the others only when present.
		if (!required && !(await hasImage(image))) continue;
		instances.push({
			engine: kind,
			image,
			version,
			port: await freePort(),
			name: `studio-my-${kind}-${version.replace('.', '')}-${process.pid}`,
		});
	}

	let runtime: ContainerRuntime | null = null;
	let tempDir = '';
	const admins = new Map<string, Connection>();
	const admin = (instance: Instance): Connection => {
		const connection = admins.get(instance.name);
		if (!connection) throw new Error(`${instance.name} is not ready`);
		return connection;
	};

	const target = (instance: Instance, who: { user: string; password: string }): StudioTarget => ({
		engine: instance.engine,
		version: instance.version,
		host: '127.0.0.1',
		port: instance.port,
		database: 'app',
		user: who.user,
		password: who.password,
		tls: null,
	});

	const rootOptions = (instance: Instance) => ({
		host: '127.0.0.1',
		port: instance.port,
		user: 'root',
		password: ROOT_PASSWORD,
		database: 'app',
		multipleStatements: true,
		supportBigNumbers: true,
		bigNumberStrings: true,
	});

	async function reset(instance: Instance): Promise<void> {
		await admin(instance).query(`DELETE FROM ${TABLE}; INSERT INTO ${TABLE} VALUES ${fixtureValues()};`);
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'studio-my-'));
		runtime = new ContainerRuntime(engine, tempDir);
		const network = `studio-my-net-${process.pid}`;
		await runtime.createNetwork(network);
		await Promise.all(
			instances.map(async (instance) => {
				const prefix = instance.engine === 'mariadb' ? 'MARIADB' : 'MYSQL';
				await runtime?.runContainer({
					name: instance.name,
					image: instance.image,
					network,
					ports: [[instance.port, 3306]],
					env: {
						[`${prefix}_ROOT_PASSWORD`]: ROOT_PASSWORD,
						[`${prefix}_DATABASE`]: 'app',
						[`${prefix}_USER`]: OWNER.user,
						[`${prefix}_PASSWORD`]: OWNER.password,
					},
				});
				// The entrypoint runs a networkless bootstrap server first, so wait for a real login.
				await waitFor(
					`${instance.image} accepts connections`,
					async () => {
						const connection = await createConnection({ ...rootOptions(instance), connectTimeout: 2_000 });
						await connection.query('SELECT 1');
						admins.set(instance.name, connection);
						return true;
					},
					{ timeoutMs: 180_000, intervalMs: 1_000 },
				);
				const root = admin(instance);
				await root.query(SEED);
				await root.query(ESCAPE_PROCEDURE);
				await root.query(
					`CREATE USER '${READER.user}'@'%' IDENTIFIED BY '${READER.password}';
					GRANT SELECT, SHOW VIEW ON app.* TO '${READER.user}'@'%';`,
				);
			}),
		);
	}, 300_000);

	afterAll(async () => {
		for (const connection of admins.values()) await connection.end().catch(() => undefined);
		await runtime?.cleanup();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}, 120_000);

	for (const instance of instances) {
		const label = `${instance.engine} ${instance.version}`;
		const fixture = {
			object: { path: [TABLE], kind: 'table' as const },
			rowCount: ROW_COUNT,
			keyColumns: ['id'],
			editableColumn: 'name',
			selectAllInput: `SELECT * FROM ${TABLE}`,
			slowInput: 'SELECT SLEEP(10)',
			writeInput: `DELETE FROM ${TABLE}`,
			readOnlyEscapes: [
				`COMMIT; DELETE FROM ${TABLE}`,
				`SET SESSION transaction_read_only = OFF; DELETE FROM ${TABLE}`,
				'CREATE TABLE x (a INT)',
				`DROP TABLE ${TABLE}`,
				`TRUNCATE ${TABLE}`,
				`INSERT INTO ${TABLE} (id, name) VALUES (999, 'x')`,
				'CALL esc()',
				"PREPARE s FROM 'CALL esc()'; EXECUTE s",
				`SET STATEMENT transaction_read_only=0 FOR DELETE FROM ${TABLE}`,
				`BEGIN; DELETE FROM ${TABLE}; COMMIT`,
				`START TRANSACTION READ WRITE; DELETE FROM ${TABLE}`,
				'SET autocommit = 0; DELETE FROM studio_items; COMMIT',
				`/*!50000 DELETE FROM ${TABLE} */`,
			],
			reset: () => reset(instance),
			scratchCreate: {
				op: 'create-table' as const,
				parent: [],
				name: 'conformance_scratch',
				columns: [{ name: 'id', type: 'int', nullable: false, identity: true }],
				primaryKey: ['id'],
			},
		};

		describeConformance({ name: `${label} (owner, read-only session)`, plugin: mysqlPlugin, target: target(instance, OWNER), fixture });
		describeConformance({
			name: `${label} (read-only principal)`,
			plugin: mysqlPlugin,
			target: target(instance, OWNER),
			readOnlyTarget: target(instance, READER),
			fixture,
		});

		describe(`mysql plugin extras: ${label}`, () => {
			const open = (readOnly: boolean, who = OWNER) =>
				mysqlPlugin.connect(target(instance, who), { readOnly, limits: DEFAULT_STUDIO_LIMITS });
			const run = (session: StudioSession, input: string, timeoutMs = 10_000, abort = signal()) =>
				collect(session.run(input, { maxRows: 1_000, timeoutMs }, abort));
			const withSession = async (readOnly: boolean, fn: (session: StudioSession) => Promise<void>, who = OWNER) => {
				const session = await open(readOnly, who);
				try {
					await fn(session);
				} finally {
					await session.close();
				}
			};
			const processes = async (needle: string): Promise<number> => {
				const [rows] = await admin(instance).query<RowDataPacket[]>(
					'SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND ID <> CONNECTION_ID()',
					[`%${needle}%`],
				);
				return Number(rows[0]?.n ?? 0);
			};
			const tables = async (): Promise<string[]> => {
				const [rows] = await admin(instance).query<RowDataPacket[]>(
					"SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'app' ORDER BY TABLE_NAME",
				);
				return rows.map((row) => String(row.name));
			};

			test('capabilities name the dialect', () => {
				const caps = mysqlPlugin.capabilities(instance.engine, instance.version);
				expect(caps).toEqual({
					family: 'relational',
					language: 'sql',
					dialect: instance.engine,
					edit: 'primary-key',
					cancel: 'kill-connection',
					explain: true,
					schemas: false,
					structure: [
						'create-table',
						'rename',
						'drop',
						'truncate',
						'add-column',
						'drop-column',
						'rename-column',
						'alter-column',
						'create-index',
						'drop-index',
					],
				});
			});

			test('alter: column changes keep what MODIFY would otherwise drop', async () => {
				const PROBE = 'alter_probe';
				const object = { path: [PROBE], kind: 'table' as const };
				const root = admin(instance);
				const columnInfo = async (name: string) => {
					const [rows] = await root.query<RowDataPacket[]>(
						`SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, EXTRA AS extra,
							COLUMN_COMMENT AS comment, COLLATION_NAME AS collation
						FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = 'app' AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
						[PROBE, name],
					);
					return rows[0] as { type: string; nullable: string; def: string | null; extra: string; comment: string; collation: string | null } | undefined;
				};
				await root.query(`DROP TABLE IF EXISTS ${PROBE}`);
				await root.query(`CREATE TABLE ${PROBE} (
					id INT AUTO_INCREMENT PRIMARY KEY,
					label VARCHAR(20) COLLATE utf8mb4_bin NOT NULL DEFAULT 'it''s \\\\ ok' COMMENT 'the label',
					touched TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
					token VARCHAR(36) DEFAULT (uuid()),
					meta JSON
				)`);
				try {
					await withSession(false, async (session) => {
						const alter = (change: Parameters<NonNullable<StudioSession['alter']>>[0], dryRun = false) =>
							session.alter!(change, { dryRun }, signal());

						// A dry run renders the statement and changes nothing.
						const dry = await alter({ op: 'alter-column', object, column: 'label', nullable: true }, true);
						expect(dry.applied).toBe(false);
						expect(dry.statements[0]).toContain('MODIFY COLUMN');
						expect((await columnInfo('label'))?.nullable).toBe('NO');

						const label = await columnInfo('label');
						await alter({ op: 'alter-column', object, column: 'label', nullable: true });
						expect(await columnInfo('label')).toEqual({ ...label!, nullable: 'YES' });

						const touched = await columnInfo('touched');
						await alter({ op: 'alter-column', object, column: 'touched', nullable: true });
						const after = await columnInfo('touched');
						expect(after?.nullable).toBe('YES');
						expect(after?.extra.toLowerCase()).toContain('on update');
						expect(after?.def).toBe(touched?.def ?? null);

						const token = await columnInfo('token');
						await alter({ op: 'alter-column', object, column: 'token', type: 'varchar(64)' });
						expect(await columnInfo('token')).toMatchObject({ type: 'varchar(64)', def: token?.def ?? null });

						await alter({ op: 'alter-column', object, column: 'id', type: 'bigint' });
						expect((await columnInfo('id'))?.extra.toLowerCase()).toContain('auto_increment');

						await alter({ op: 'alter-column', object, column: 'label', default: null });
						const defaultOf = async (name: string) =>
							(await session.describe(object, signal())).columns.find((c) => c.name === name)?.default;
						// MariaDB prints a dropped default on a nullable column as NULL; describe maps both to null.
						expect(await defaultOf('label')).toBeNull();
						await alter({ op: 'alter-column', object, column: 'label', default: { literal: "o'k" } });
						expect(await defaultOf('label')).toBe("'o''k'");
						await alter({ op: 'alter-column', object, column: 'touched', default: null });
						expect((await columnInfo('touched'))?.extra.toLowerCase()).toContain('on update');
						await alter({ op: 'alter-column', object, column: 'touched', default: { expression: 'CURRENT_TIMESTAMP(3)' } });
						// MySQL stores the parenthesised form as now(3); either way a MODIFY must keep it.
						expect((await defaultOf('touched'))?.toLowerCase()).toMatch(/^(?:current_timestamp|now)\(3\)/);
						await alter({ op: 'alter-column', object, column: 'touched', nullable: false });
						expect((await defaultOf('touched'))?.toLowerCase()).toMatch(/^(?:current_timestamp|now)\(3\)/);
						expect((await columnInfo('touched'))?.extra.toLowerCase()).toContain('on update');
						await alter({ op: 'alter-column', object, column: 'token', default: { expression: 'uuid()' } });
						expect((await defaultOf('token'))?.toLowerCase()).toContain('uuid()');

						// MariaDB's JSON is a LONGTEXT with a CHECK; MODIFY must keep the check.
						await alter({ op: 'alter-column', object, column: 'meta', nullable: false });
						await expect(root.query(`INSERT INTO ${PROBE} (meta) VALUES ('not json')`)).rejects.toThrow();

						await alter({ op: 'add-column', object, column: { name: 'qty', type: 'int unsigned', nullable: false, default: { literal: 3 }, identity: false } });
						await alter({ op: 'rename-column', object, column: 'qty', name: 'quantity' });
						expect((await columnInfo('quantity'))?.def).toBe('3');
						const index = await alter({ op: 'create-index', object, columns: [{ name: 'quantity', dir: 'desc' }, { name: 'label', dir: 'asc' }], unique: false });
						expect(index.statements[0]).toContain('`alter_probe_quantity_label_idx`');
						expect((await session.describe(object, signal())).indexes.map((i) => i.name)).toContain('alter_probe_quantity_label_idx');
						await alter({ op: 'drop-index', object, name: 'alter_probe_quantity_label_idx' });
						await alter({ op: 'drop-column', object, column: 'quantity' });
						expect(await columnInfo('quantity')).toBeUndefined();

						await root.query(`INSERT INTO ${PROBE} (meta) VALUES ('{}'), ('[]')`);
						await alter({ op: 'truncate', object });
						const [count] = await root.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${PROBE}`);
						expect(Number(count[0]?.n)).toBe(0);

						// Engine errors come back as studio errors; generated columns are refused before running.
						await expect(alter({ op: 'drop-column', object, column: 'missing' })).rejects.toBeInstanceOf(StudioError);
						await root.query(`ALTER TABLE ${PROBE} ADD COLUMN gen VARCHAR(40) AS (concat(label, '!')) VIRTUAL`);
						await expect(alter({ op: 'alter-column', object, column: 'gen', nullable: false })).rejects.toMatchObject({
							code: 'bad_request',
						});
					});
					await withSession(true, async (session) => {
						await expect(session.alter!({ op: 'drop', object, cascade: false }, { dryRun: true }, signal())).rejects.toMatchObject({
							code: 'read_only',
						});
					});
				} finally {
					await root.query(`DROP TABLE IF EXISTS ${PROBE}`);
				}
			});

			test('alter: aborting a DDL stuck on a lock cancels it and the session recovers', async () => {
				const root = admin(instance);
				await root.query('DROP TABLE IF EXISTS alter_locked, alter_locked2');
				await root.query('CREATE TABLE alter_locked (id INT PRIMARY KEY)');
				const holder = await createConnection(rootOptions(instance));
				try {
					await holder.query('LOCK TABLES alter_locked WRITE');
					await withSession(false, async (session) => {
						const abort = new AbortController();
						const started = performance.now();
						setTimeout(() => abort.abort(), 500);
						await expect(
							session.alter!({ op: 'rename', object: { path: ['alter_locked'], kind: 'table' }, name: 'alter_locked2' }, { dryRun: false }, abort.signal),
						).rejects.toMatchObject({ code: 'cancelled' });
						expect(performance.now() - started).toBeLessThan(3_000);
						await holder.query('UNLOCK TABLES');
						expect(await tables()).toContain('alter_locked');
						// The killed run connection is replaced on the next call.
						await session.alter!({ op: 'truncate', object: { path: ['alter_locked'], kind: 'table' } }, { dryRun: false }, signal());
					});
				} finally {
					await holder.end().catch(() => undefined);
					await root.query('DROP TABLE IF EXISTS alter_locked, alter_locked2');
				}
			});

			test('alter: views rename and drop as views', async () => {
				const root = admin(instance);
				await root.query(`DROP VIEW IF EXISTS alter_view, alter_view2`);
				try {
					await withSession(false, async (session) => {
						// Created by the owner: a view defined by root needs SYSTEM_USER to rename on MySQL 9.
						const created = await run(session, `CREATE VIEW alter_view AS SELECT id FROM ${TABLE}`);
						expect(created.some((event) => event.t === 'error')).toBe(false);
						await session.alter!({ op: 'rename', object: { path: ['alter_view'], kind: 'view' }, name: 'alter_view2' }, { dryRun: false }, signal());
						const drop = await session.alter!(
							{ op: 'drop', object: { path: ['alter_view2'], kind: 'view' }, cascade: false },
							{ dryRun: false },
							signal(),
						);
						expect(drop.statements).toEqual(['DROP VIEW `alter_view2`']);
						expect(await tables()).not.toContain('alter_view2');
					});
				} finally {
					await root.query(`DROP VIEW IF EXISTS alter_view, alter_view2`);
				}
			});

			test('tree lists tables and views at the root, with estimates', async () => {
				await withSession(true, async (session) => {
					const nodes = await session.tree([], signal());
					const byName = new Map(nodes.map((node) => [node.name, node]));
					expect(byName.get(TABLE)).toMatchObject({ path: [TABLE], kind: 'table', browsable: true, hasChildren: false });
					expect(byName.get(VIEW)).toMatchObject({ kind: 'view', browsable: true });
					expect(byName.get(NO_KEY)?.kind).toBe('table');
					expect(byName.get(TABLE)?.detail?.bytes).toBeGreaterThan(0);
					expect(await session.tree([TABLE], signal())).toEqual([]);
				});
			});

			test('describe: types, keys, indexes, DDL and editability', async () => {
				await withSession(false, async (session) => {
					const items = await session.describe({ path: [TABLE], kind: 'table' }, signal());
					const kinds = Object.fromEntries(items.columns.map((c) => [c.name, c.kind]));
					expect(kinds).toEqual({
						id: 'number',
						name: 'text',
						amount: 'decimal',
						big: 'bigint',
						data: 'bytes',
						// MariaDB reports JSON as LONGTEXT; the json_valid CHECK marks it.
						meta: 'json',
						created: 'datetime',
					});
					expect(items.columns.find((c) => c.name === 'meta')?.nativeType).toBe('json');
					expect(items.primaryKey).toEqual(['id']);
					expect(items.columns.find((c) => c.name === 'id')?.key).toBe('primary');
					expect(items.indexes.map((i) => i.name).sort()).toEqual(['PRIMARY', `${TABLE}_name`]);
					expect(items.ddl).toContain('CREATE TABLE');
					expect(items.editable).toBe(true);
					const view = await session.describe({ path: [VIEW], kind: 'view' }, signal());
					expect(view.editable).toBe(false);
					expect(view.ddl).toContain('VIEW');
					const loose = await session.describe({ path: [NO_KEY], kind: 'table' }, signal());
					expect(loose.editable).toBe(false);
					expect(loose.primaryKey).toBeNull();
					await expect(session.describe({ path: ['missing'], kind: 'table' }, signal())).rejects.toThrow(StudioError);
				});
				await withSession(true, async (session) => {
					const items = await session.describe({ path: [TABLE], kind: 'table' }, signal());
					expect(items.editable).toBe(false);
					expect(items.reason).toContain('read-only');
				});
			});

			test('cells round-trip losslessly through browse, value and apply', async () => {
				await withSession(false, async (session) => {
					const object = { path: [TABLE], kind: 'table' as const };
					const events = await collect(
						session.browse(object, { limit: 1, sort: [{ column: 'id', dir: 'desc' }], filter: [] }, signal()),
					);
					const columns = events.find((e) => e.t === 'columns');
					const names = columns?.t === 'columns' ? columns.columns.map((c) => c.name) : [];
					const row = rowsOf(events)[0] ?? [];
					const cell = (name: string) => row[names.indexOf(name)];
					expect(cell('id')).toBe(250);
					expect(cell('big')).toEqual({ $t: 'bigint', v: '25000000000000000' });
					expect(cell('amount')).toEqual({ $t: 'decimal', v: '312.50' });
					expect(cell('data')).toEqual({ $t: 'bytes', v: Buffer.from([250, 0, 255]).toString('base64') });
					expect(cell('meta')).toEqual({ $t: 'json', v: { even: true, n: 250 } });
					expect(cell('created')).toEqual({ $t: 'datetime', v: '2026-01-01 00:04:10.250' });

					// Write awkward values, read them back exactly, then restore.
					const values: Record<string, Cell> = {
						big: { $t: 'bigint', v: '9007199254740993' },
						amount: { $t: 'decimal', v: '1234567890.12' },
						data: { $t: 'bytes', v: Buffer.from([0, 1, 2, 0xfe, 0xff]).toString('base64') },
						meta: { $t: 'json', v: { nested: { list: [1, 'two', null] }, big: 'x' } },
						created: { $t: 'datetime', v: '1999-12-31 23:59:59.999' },
					};
					const original = Object.fromEntries(Object.keys(values).map((k) => [k, cell(k) ?? null]));
					expect(await session.apply(object, [{ op: 'update', key: { id: 250 }, values, original }], signal())).toEqual({
						applied: 1,
						conflicts: [],
					});
					for (const [column, expected] of Object.entries(values))
						expect(await session.value?.(object, { id: 250 }, column, signal())).toEqual(expected);
					// The BIGINT key compare is exact: one past 2^53 must not match 2^53.
					const stale = await session.apply(
						object,
						[{ op: 'update', key: { id: 250 }, values: { name: 'x' }, original: { big: { $t: 'bigint', v: '9007199254740992' } } }],
						signal(),
					);
					expect(stale.applied).toBe(0);
					// A no-op update still counts as matched (CLIENT_FOUND_ROWS), so it is not a conflict.
					expect(
						await session.apply(object, [{ op: 'update', key: { id: 250 }, values, original: values }], signal()),
					).toEqual({ applied: 1, conflicts: [] });
					await session.apply(object, [{ op: 'update', key: { id: 250 }, values: original, original: values }], signal());
					expect(await session.value?.(object, { id: 250 }, 'big', signal())).toEqual({ $t: 'bigint', v: '25000000000000000' });
				});
			});

			test('run types result columns from the field packet (MariaDB JSON included)', async () => {
				await withSession(true, async (session) => {
					const events = await run(
						session,
						`SELECT big, amount, data, meta, created, JSON_OBJECT('k', 1) AS doc, CAST(9007199254740993 AS UNSIGNED) AS flag FROM ${TABLE} WHERE id = 250`,
					);
					const columns = events.find((e) => e.t === 'columns');
					expect(columns?.t === 'columns' && columns.columns.map((c) => c.kind)).toEqual([
						'bigint',
						'decimal',
						'bytes',
						'json',
						'datetime',
						'json',
						'bigint',
					]);
					expect(rowsOf(events)[0]).toEqual([
						{ $t: 'bigint', v: '25000000000000000' },
						{ $t: 'decimal', v: '312.50' },
						{ $t: 'bytes', v: Buffer.from([250, 0, 255]).toString('base64') },
						{ $t: 'json', v: { even: true, n: 250 } },
						{ $t: 'datetime', v: '2026-01-01 00:04:10.250' },
						{ $t: 'json', v: { k: 1 } },
						{ $t: 'bigint', v: '9007199254740993' },
					]);
				});
			});

			test('zero dates stay lossless', async () => {
				await withSession(true, async (session) => {
					const events = await collect(session.browse({ path: ['studio_zero'], kind: 'table' }, { limit: 10, sort: [], filter: [] }, signal()));
					expect(rowsOf(events)[0]).toEqual([1, { $t: 'datetime', v: '0000-00-00 00:00:00' }, { $t: 'date', v: '0000-00-00' }]);
				});
			});

			test('browse filters, sorts and pages by offset off the key', async () => {
				await withSession(true, async (session) => {
					const object = { path: [TABLE], kind: 'table' as const };
					const filtered = await collect(
						session.browse(object, { limit: 100, sort: [], filter: [{ column: 'name', op: 'like', value: 'item 00%' }] }, signal()),
					);
					expect(rowsOf(filtered).length).toBe(9);
					const seen: Cell[] = [];
					let cursor: string | undefined;
					for (let page = 0; page < 20; page += 1) {
						const events = await collect(
							session.browse(object, { limit: 40, cursor, sort: [{ column: 'name', dir: 'desc' }], filter: [{ column: 'id', op: 'gt', value: 100 }] }, signal()),
						);
						seen.push(...rowsOf(events).map((r) => r[0] ?? null));
						const next = events.find((e) => e.t === 'page');
						if (next?.t !== 'page' || next.next === null) break;
						cursor = next.next;
					}
					expect(seen.length).toBe(150);
					expect(seen[0]).toBe(250);
					expect(new Set(seen).size).toBe(150);
					await expect(collect(session.browse(object, { limit: 10, sort: [], filter: [], native: '{}' }, signal()))).rejects.toThrow(
						StudioError,
					);
					await expect(
						collect(session.browse(object, { limit: 10, sort: [{ column: 'nope`; DROP TABLE x', dir: 'asc' }], filter: [] }, signal())),
					).rejects.toThrow(StudioError);
					const loose = await collect(session.browse({ path: [NO_KEY], kind: 'table' }, { limit: 2, sort: [], filter: [] }, signal()));
					expect(rowsOf(loose)).toEqual([
						[1, 'one'],
						[2, 'two'],
					]);
				});
			});

			test('multi-statement runs yield one result per statement', async () => {
				await withSession(true, async (session) => {
					const events = await run(session, "SELECT 1 AS a; SELECT 'x' AS b, 2 AS c; SHOW TABLES");
					expect(events.filter((e) => e.t === 'columns').length).toBe(3);
					expect(events.filter((e) => e.t === 'result').length).toBe(3);
					expect(rowsOf(events).slice(0, 2)).toEqual([[1], ['x', 2]]);
					expect(events.at(-1)).toMatchObject({ t: 'done', truncated: false });
				});
				await withSession(false, async (session) => {
					const events = await run(
						session,
						`INSERT INTO ${NO_KEY} VALUES (9, 'nine'); SELECT COUNT(*) AS n FROM ${NO_KEY}; DELETE FROM ${NO_KEY} WHERE a = 9`,
					);
					const results = events.filter((e) => e.t === 'result');
					expect(results).toEqual([
						{ t: 'result', command: 'INSERT', affected: 1 },
						{ t: 'result', command: 'SELECT', affected: 1 },
						{ t: 'result', command: 'DELETE', affected: 1 },
					]);
					expect(rowsOf(events)).toEqual([[4]]);
				});
			});

			test('write sessions honour BEGIN/COMMIT within a run and roll back at the end', async () => {
				await withSession(false, async (session) => {
					const open = await run(session, `BEGIN; DELETE FROM ${NO_KEY}; SELECT COUNT(*) FROM ${NO_KEY}`);
					expect(rowsOf(open)).toEqual([[0]]);
					expect(open.some((e) => e.t === 'notice' && e.level === 'warn')).toBe(true);
					expect(rowsOf(await run(session, `SELECT COUNT(*) FROM ${NO_KEY}`))).toEqual([[3]]);
					await run(session, `BEGIN; INSERT INTO ${NO_KEY} VALUES (7, 'seven'); COMMIT`);
					expect(rowsOf(await run(session, `SELECT COUNT(*) FROM ${NO_KEY}`))).toEqual([[4]]);
					await run(session, `DELETE FROM ${NO_KEY} WHERE a = 7`);
				});
			});

			test('errors carry errno, SQLSTATE and a position', async () => {
				await withSession(true, async (session) => {
					const events = await run(session, 'SELECT 1;\nSELEC 2');
					const error = errorOf(events);
					expect(error?.code).toBe('engine_error');
					expect(error?.message).toContain('1064');
					expect(error?.message).toContain('42000');
					expect(error?.position).toBe(11);
					expect(events.at(-1)?.t).toBe('done');
					const missing = errorOf(await run(session, 'SELECT * FROM missing_table'));
					expect(missing?.code).toBe('not_found');
					const delimiter = errorOf(await run(session, 'DELIMITER //'));
					expect(delimiter?.code).toBe('unsupported');
				});
			});

			test('read-only: the server refuses DDL and writes; escapes leave data and schema unchanged', async () => {
				const before = await tables();
				for (const who of [OWNER, READER])
					await withSession(
						true,
						async (session) => {
							// These pass the classifier: the read-only transaction itself must refuse them.
							for (const input of ['CREATE TABLE x (a INT)', `DROP TABLE ${TABLE}`, `TRUNCATE ${TABLE}`, `DELETE FROM ${TABLE}`])
								expect(errorOf(await run(session, input))?.code, `${who.user}: ${input}`).toBe('read_only');
							for (const input of [
								'CALL esc()',
								"PREPARE s FROM 'CALL esc()'",
								'SET STATEMENT transaction_read_only=0 FOR CREATE TABLE ro_escape (a INT)',
								'SET SESSION transaction_read_only = OFF; CREATE TABLE ro_escape (a INT)',
								'/*!50000 CREATE TABLE ro_escape (a INT) */',
							])
								expect(errorOf(await run(session, input))?.code, `${who.user}: ${input}`).toBe('read_only');
						},
						who,
					);
				expect(await tables()).toEqual(before);
				const [rows] = await admin(instance).query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${TABLE}`);
				expect(Number(rows[0]?.n)).toBe(ROW_COUNT);
			});

			test('cancel kills the statement on the server within 2 s, and the next run works', async () => {
				await withSession(true, async (session) => {
					const controller = new AbortController();
					const started = performance.now();
					setTimeout(() => controller.abort(), 200);
					await expect(run(session, 'SELECT SLEEP(10)', 60_000, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
					expect(performance.now() - started).toBeLessThan(2_000);
					// KILL CONNECTION has landed: nothing is still sleeping on the server.
					await waitFor('the killed query to disappear', async () => (await processes('SLEEP(10)')) === 0, {
						timeoutMs: 2_000,
						intervalMs: 100,
					});
					expect(rowsOf(await run(session, 'SELECT 1 AS one'))).toEqual([[1]]);
				});
			});

			test('a run that replaces an aborted one gets a clean connection', async () => {
				await withSession(false, async (session) => {
					const controller = new AbortController();
					const first = run(session, 'SELECT SLEEP(10)', 60_000, controller.signal);
					await Bun.sleep(200);
					controller.abort();
					// Started at once, as the studio process does when a newer run replaces the old one.
					const second = run(session, `BEGIN; INSERT INTO ${NO_KEY} VALUES (8, 'eight'); COMMIT; SELECT COUNT(*) FROM ${NO_KEY}`);
					await expect(first).rejects.toMatchObject({ code: 'cancelled' });
					const events = await second;
					expect(errorOf(events)).toBeUndefined();
					expect(rowsOf(events)).toEqual([[4]]);
					await run(session, `DELETE FROM ${NO_KEY} WHERE a = 8`);
				});
			});

			test('a statement timeout returns the timeout code and the session recovers', async () => {
				await withSession(true, async (session) => {
					const started = performance.now();
					const events = await run(session, 'SELECT 1; SELECT SLEEP(5); SELECT 2', 1_000);
					expect(performance.now() - started).toBeLessThan(3_000);
					expect(errorOf(events)?.code).toBe('timeout');
					// The run stops at the failed statement.
					expect(rowsOf(events)).toEqual([[1]]);
					await waitFor('the timed-out query to disappear', async () => (await processes('SLEEP(5)')) === 0, {
						timeoutMs: 2_000,
						intervalMs: 100,
					});
					expect(rowsOf(await run(session, 'SELECT 2 AS two'))).toEqual([[2]]);
				});
			});

			test('a big result is cut at maxRows and the query is stopped', async () => {
				await withSession(true, async (session) => {
					// 250^3 ≈ 15.6M rows: only a kill ends it within the test timeout.
					const input = `SELECT a.id, b.id, c.id FROM ${TABLE} a, ${TABLE} b, ${TABLE} c; SELECT 'after'`;
					const started = performance.now();
					const events = await collect(session.run(input, { maxRows: 1_000, timeoutMs: 30_000 }, signal()));
					expect(performance.now() - started).toBeLessThan(5_000);
					expect(rowsOf(events).length).toBe(1_000);
					expect(events.at(-1)).toMatchObject({ t: 'done', truncated: true });
					expect(events.some((e) => e.t === 'notice' && e.message.includes('did not run'))).toBe(true);
					expect(rowsOf(await run(session, 'SELECT 3 AS three'))).toEqual([[3]]);
				});
			});

			test('explain returns a JSON plan', async () => {
				await withSession(true, async (session) => {
					const plan = await session.explain?.(`SELECT * FROM ${TABLE} WHERE id = 1`, signal());
					expect(plan?.format).toBe('json');
					expect(JSON.stringify(plan?.plan)).toContain(TABLE);
				});
				await withSession(false, async (session) => {
					// MariaDB write sessions use ANALYZE, which executes, so it runs in a rolled-back transaction.
					await session.explain?.(`DELETE FROM ${TABLE} WHERE id = 1`, signal());
					const [rows] = await admin(instance).query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${TABLE}`);
					expect(Number(rows[0]?.n)).toBe(ROW_COUNT);
				});
			});

			test('apply: insert and delete in one transaction; any conflict rolls back the batch', async () => {
				await withSession(false, async (session) => {
					const object = { path: [TABLE], kind: 'table' as const };
					expect(
						await session.apply(object, [{ op: 'insert', values: { id: 1000, name: 'new', meta: { $t: 'json', v: { a: 1 } } } }], signal()),
					).toEqual({ applied: 1, conflicts: [] });
					const batch = await session.apply(
						object,
						[
							{ op: 'delete', key: { id: 1000 } },
							{ op: 'insert', values: { id: 1, name: 'duplicate' } },
						],
						signal(),
					);
					expect(batch.applied).toBe(0);
					expect(batch.conflicts.map((c) => c.index)).toEqual([1]);
					expect(batch.conflicts[0]?.reason).toContain('1062');
					// The delete in the failed batch was rolled back.
					expect(await session.value?.(object, { id: 1000 }, 'name', signal())).toBe('new');
					expect(await session.apply(object, [{ op: 'delete', key: { id: 1000 }, original: { name: 'new' } }], signal())).toEqual({
						applied: 1,
						conflicts: [],
					});
					await expect(session.apply({ path: [NO_KEY], kind: 'table' }, [{ op: 'delete', key: { a: 1 } }], signal())).rejects.toThrow(
						StudioError,
					);
					await expect(
						session.apply(object, [{ op: 'update', key: { id: null }, values: { name: 'x' }, original: {} }], signal()),
					).rejects.toMatchObject({ code: 'bad_request' });
				});
			});
		});
	}
}
