/**
 * Postgres studio plugin e2e (plan 22, Phase 2 track A). Starts disposable Postgres containers,
 * seeds the standard fixture and runs the shared conformance suite twice per version:
 *
 *   1. Interim reality: the owner credential with read-only *sessions* (the flag is the only
 *      read-only layer until the Phase 3 principal lands).
 *   2. Phase 3: a real role granted `pg_read_all_data` only.
 *
 * Opt-in, because it needs a container engine and a few seconds per image:
 *
 *   SKIFF_E2E_STUDIO=1 SKIFF_E2E_ENGINE=docker bun test tests/e2e/studio/postgres.e2e.test.ts
 *
 * `SKIFF_E2E_STUDIO_PG=17,16` picks the images (default both). Needs Bun ≥ 1.4.4.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { DEFAULT_STUDIO_LIMITS } from '../../../packages/contracts/src/database-studio.ts';
import { collect, describeConformance, rowsOf } from '../../../packages/studio/src/conformance.ts';
import type { StudioSession, StudioTarget } from '../../../packages/studio/src/driver.ts';
import { postgresPlugin } from '../../../packages/studio/src/plugins/postgres/index.ts';
import type { Cell, ObjectRef, StudioEvent } from '../../../packages/studio/src/protocol.ts';
import { ContainerRuntime, detectEngine, freePort, postgresHealthProbe, waitFor } from '../lib/containers.ts';

const ROW_COUNT = 250;
const SUPER_PASSWORD = 'studio-super';
const OWNER = { user: 'app_owner', password: 'owner-pw' };
const READER = { user: 'skiff_studio_ro', password: 'reader-pw' };
const ITEMS: ObjectRef = { path: ['public', 'studio_items'], kind: 'table' };

if (process.env.SKIFF_E2E_STUDIO !== '1') {
	test.skip('postgres studio e2e (set SKIFF_E2E_STUDIO=1 to run)', () => {});
} else {
	const versions = (process.env.SKIFF_E2E_STUDIO_PG ?? '17,16')
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
	const instances = await Promise.all(versions.map(async (version) => ({ version, port: await freePort() })));
	let runtime: ContainerRuntime | null = null;
	let tempDir = '';

	beforeAll(async () => {
		const engine = await detectEngine();
		if (!engine) throw new Error('No container engine (set SKIFF_E2E_ENGINE=docker or podman).');
		tempDir = await mkdtemp(join(tmpdir(), 'studio-pg-'));
		runtime = new ContainerRuntime(engine, tempDir);
		const rt = runtime;
		const network = `studio-pg-${rt.runId}`;
		await rt.createNetwork(network);
		await Promise.all(
			instances.map(async ({ version, port }) => {
				await rt.runContainer({
					name: `studio-pg-${version}-${rt.runId}`,
					image: `postgres:${version}-alpine`,
					network,
					ports: [[port, 5432]],
					env: { POSTGRES_PASSWORD: SUPER_PASSWORD },
				});
				// The probe's socket timeout does not fire while the port forwarder holds an early
				// connection open (Bun), so bound each attempt here.
				await waitFor(`postgres ${version}`, () => Promise.race([postgresHealthProbe(port), Bun.sleep(3_500).then(() => false)]), {
					timeoutMs: 120_000,
				});
				// The entrypoint restarts the server after init; wait for a real login.
				await waitFor(`postgres ${version} login`, async () => {
					const sql = superSql(port, 'postgres');
					try {
						await sql.unsafe('SELECT 1');
						return true;
					} finally {
						await sql.close({ timeout: 0 });
					}
				});
				await bootstrap(port);
			}),
		);
	}, 300_000);

	afterAll(async () => {
		await runtime?.cleanup();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	}, 120_000);

	for (const { version, port } of instances) {
		const owner = target(version, port, OWNER);
		const reader = target(version, port, READER);
		const fixture = {
			object: ITEMS,
			rowCount: ROW_COUNT,
			keyColumns: ['id'],
			editableColumn: 'name',
			selectAllInput: 'SELECT * FROM studio_items ORDER BY id',
			slowInput: 'SELECT pg_sleep(10)',
			writeInput: 'DELETE FROM studio_items',
			readOnlyEscapes: [
				'COMMIT; DELETE FROM studio_items',
				'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; DELETE FROM studio_items',
				'SET default_transaction_read_only = off; DELETE FROM studio_items',
				'BEGIN READ WRITE; DELETE FROM studio_items; COMMIT',
				'CREATE TABLE x (a int)',
				'DROP TABLE studio_items',
				// Beyond the required list.
				'SET transaction_read_only = off; DELETE FROM studio_items',
				'ROLLBACK; DELETE FROM studio_items',
				'COMMIT AND CHAIN; DELETE FROM studio_items',
				'START TRANSACTION READ WRITE; DELETE FROM studio_items; COMMIT',
				"SELECT set_config('default_transaction_read_only', 'off', false); DELETE FROM studio_items",
				'DO $$ BEGIN SET LOCAL transaction_read_only = off; DELETE FROM studio_items; END $$',
				'WITH d AS (DELETE FROM studio_items RETURNING *) SELECT count(*) FROM d',
				'TRUNCATE studio_items',
				'CREATE TEMP TABLE t AS SELECT 1',
				'SELECT 1; /* ; */ DELETE FROM studio_items',
			],
			reset: () => seedItems(port),
		};
		describeConformance({ name: `postgres ${version} (owner, read-only sessions)`, plugin: postgresPlugin, target: owner, fixture });
		describeConformance({
			name: `postgres ${version} (pg_read_all_data role)`,
			plugin: postgresPlugin,
			target: owner,
			readOnlyTarget: reader,
			fixture,
		});
		describeEngineTests(version, port, owner, reader);
	}
}

function target(version: string, port: number, who: { user: string; password: string }): StudioTarget {
	return { engine: 'postgres', version, host: '127.0.0.1', port, database: 'app', user: who.user, password: who.password, tls: null };
}

function superSql(port: number, database: string): SQL {
	return new SQL({
		adapter: 'postgres',
		hostname: '127.0.0.1',
		port,
		username: 'postgres',
		password: SUPER_PASSWORD,
		database,
		max: 1,
		connectionTimeout: 5,
		tls: false,
	});
}

function ownerSql(port: number): SQL {
	return new SQL({
		adapter: 'postgres',
		hostname: '127.0.0.1',
		port,
		username: OWNER.user,
		password: OWNER.password,
		database: 'app',
		max: 1,
		tls: false,
	});
}

/** A non-superuser owner (as on a real node) and the Phase 3 read-only role. */
async function bootstrap(port: number): Promise<void> {
	const admin = superSql(port, 'postgres');
	try {
		await admin.unsafe(`CREATE ROLE ${OWNER.user} LOGIN PASSWORD '${OWNER.password}'`);
		await admin.unsafe(`CREATE DATABASE app OWNER ${OWNER.user}`);
		await admin.unsafe(`CREATE ROLE ${READER.user} LOGIN PASSWORD '${READER.password}'`);
		await admin.unsafe(`GRANT pg_read_all_data TO ${READER.user}`);
	} finally {
		await admin.close();
	}
	const sql = ownerSql(port);
	try {
		await sql.unsafe(`CREATE TABLE public.studio_items (
			id int PRIMARY KEY,
			name text NOT NULL,
			amount numeric(12,2),
			big bigint,
			data bytea,
			meta jsonb,
			created timestamptz
		)`);
		await sql.unsafe('CREATE INDEX studio_items_name ON public.studio_items (name)');
		await sql.unsafe('CREATE VIEW public.studio_items_view AS SELECT id, name, amount FROM public.studio_items');
		await sql.unsafe('CREATE TABLE public.studio_nokey (a int, b text)');
		await sql.unsafe("INSERT INTO public.studio_nokey SELECT g, 'row ' || g FROM generate_series(1, 95) g");
		await sql.unsafe('CREATE SCHEMA other');
		await sql.unsafe(`CREATE TABLE other.studio_types (
			id int PRIMARY KEY,
			big bigint,
			amount numeric,
			data bytea,
			ts timestamptz,
			local_ts timestamp,
			day date,
			meta jsonb,
			doc json,
			ints int[],
			bigs bigint[],
			stamps timestamptz[],
			tags text[],
			label text,
			generated_len int GENERATED ALWAYS AS (length(label)) STORED,
			parent int REFERENCES public.studio_items (id)
		)`);
		await sql.unsafe(`INSERT INTO other.studio_types (id, label) VALUES (1, 'seed')`);
		await sql.unsafe(`INSERT INTO other.studio_types (id, label) VALUES (2, repeat('x', 100000))`);
	} finally {
		await sql.close();
	}
	await seedItems(port);
}

async function seedItems(port: number): Promise<void> {
	const sql = ownerSql(port);
	try {
		// DELETE, not TRUNCATE … CASCADE: other.studio_types references this table.
		await sql.unsafe('DELETE FROM public.studio_items');
		// Every 7th amount is NULL so sorted keyset paging meets NULLs; created has microseconds.
		await sql.unsafe(`INSERT INTO public.studio_items
			SELECT g, 'item ' || lpad(g::text, 3, '0'),
				CASE WHEN g % 7 = 0 THEN NULL ELSE ((g * 37) % 101 * 1.25)::numeric(12,2) END,
				g * 100000000000000::bigint,
				decode(md5(g::text), 'hex'),
				jsonb_build_object('even', g % 2 = 0, 'n', g),
				timestamptz '2026-01-01 00:00:00+00' + g * interval '1 second' + g * interval '1 microsecond'
			FROM generate_series(1, ${ROW_COUNT}) g`);
		await sql.unsafe('ANALYZE public.studio_items');
	} finally {
		await sql.close();
	}
}

// ---------------------------------------------------------------- engine-specific tests

function describeEngineTests(version: string, port: number, owner: StudioTarget, reader: StudioTarget): void {
	const limits = DEFAULT_STUDIO_LIMITS;
	const signal = () => new AbortController().signal;
	const open = (readOnly: boolean, who = owner) => postgresPlugin.connect(who, { readOnly, limits });
	const runOpts = { maxRows: 1_000, timeoutMs: 10_000 };
	const types: ObjectRef = { path: ['other', 'studio_types'], kind: 'table' };

	async function withSession<T>(readOnly: boolean, fn: (s: StudioSession) => Promise<T>, who = owner): Promise<T> {
		const session = await open(readOnly, who);
		try {
			return await fn(session);
		} finally {
			await session.close();
		}
	}

	async function browseAll(session: StudioSession, object: ObjectRef, query: Partial<Parameters<StudioSession['browse']>[1]> = {}) {
		const rows: Cell[][] = [];
		let cursor: string | undefined;
		let names: string[] = [];
		for (let pages = 0; pages < 100; pages += 1) {
			const events = await collect(session.browse(object, { limit: 40, sort: [], filter: [], ...query, ...(cursor ? { cursor } : {}) }, signal()));
			const columns = events.find((e) => e.t === 'columns');
			if (columns?.t === 'columns') names = columns.columns.map((c) => c.name);
			rows.push(...rowsOf(events));
			const page = events.find((e) => e.t === 'page');
			if (page?.t !== 'page' || page.next === null) break;
			cursor = page.next;
		}
		return { names, rows };
	}

	async function browseRow(session: StudioSession, object: ObjectRef, id: number): Promise<Record<string, Cell>> {
		const events = await collect(session.browse(object, { limit: 1, sort: [], filter: [{ column: 'id', op: 'eq', value: id }] }, signal()));
		const columns = events.find((e) => e.t === 'columns');
		const row = rowsOf(events)[0];
		if (columns?.t !== 'columns' || !row) throw new Error(`row ${id} not found`);
		return Object.fromEntries(columns.columns.map((c, i) => [c.name, row[i] ?? null]));
	}

	const groups = (events: StudioEvent[]) => events.filter((e) => e.t === 'columns' || e.t === 'result').map((e) => e.t);

	describe(`postgres ${version} plugin specifics`, () => {
		test('tree lists user schemas and relation kinds with estimates', async () => {
			await withSession(true, async (session) => {
				const root = await session.tree([], signal());
				const names = root.map((n) => n.name);
				expect(names).toContain('public');
				expect(names).toContain('other');
				for (const hidden of ['pg_catalog', 'information_schema', 'pg_toast']) expect(names).not.toContain(hidden);
				const objects = await session.tree(['public'], signal());
				const items = objects.find((n) => n.name === 'studio_items');
				expect(items?.kind).toBe('table');
				expect(items?.detail?.rows).toBe(ROW_COUNT);
				expect(items?.detail?.bytes).toBeGreaterThan(0);
				expect(objects.find((n) => n.name === 'studio_items_view')?.kind).toBe('view');
			}, reader);
		});

		test('describe: types, keys, indexes, foreign keys, generated columns and DDL', async () => {
			await withSession(false, async (session) => {
				const items = await session.describe(ITEMS, signal());
				const kinds = Object.fromEntries(items.columns.map((c) => [c.name, c.kind]));
				expect(kinds).toEqual({ id: 'number', name: 'text', amount: 'decimal', big: 'bigint', data: 'bytes', meta: 'json', created: 'datetime' });
				expect(items.columns.find((c) => c.name === 'amount')?.nativeType).toBe('numeric(12,2)');
				expect(items.columns.find((c) => c.name === 'id')?.key).toBe('primary');
				expect(items.primaryKey).toEqual(['id']);
				expect(items.indexes.map((i) => i.name).sort()).toEqual(['studio_items_name', 'studio_items_pkey']);
				expect(items.ddl).toContain('CREATE TABLE "public"."studio_items"');
				expect(items.editable).toBe(true);
				const typed = await session.describe(types, signal());
				expect(typed.columns.find((c) => c.name === 'generated_len')?.editable).toBe(false);
				expect(typed.columns.find((c) => c.name === 'bigs')?.kind).toBe('array');
				expect(typed.foreignKeys).toEqual([
					{ name: 'studio_types_parent_fkey', columns: ['parent'], references: { path: ['public', 'studio_items'], columns: ['id'] } },
				]);
			});
		});

		test('views and key-less tables are not editable', async () => {
			await withSession(false, async (session) => {
				const view = await session.describe({ path: ['public', 'studio_items_view'], kind: 'view' }, signal());
				expect(view.editable).toBe(false);
				expect(view.reason).toBeString();
				expect(view.ddl).toStartWith('CREATE VIEW');
				await expect(
					session.apply({ path: ['public', 'studio_items_view'], kind: 'view' }, [{ op: 'delete', key: { id: 1 } }], signal()),
				).rejects.toMatchObject({ code: 'unsupported' });
				const noKey = await session.describe({ path: ['public', 'studio_nokey'], kind: 'table' }, signal());
				expect(noKey.editable).toBe(false);
				expect(noKey.primaryKey).toBeNull();
			});
		});

		test('lossless round trips: browse → apply → browse', async () => {
			await withSession(false, async (session) => {
				const values: Record<string, Cell> = {
					id: 10,
					big: { $t: 'bigint', v: '9223372036854775807' },
					amount: { $t: 'decimal', v: '12345678901234567890.123456789' },
					data: { $t: 'bytes', v: Buffer.from([0, 1, 2, 254, 255]).toString('base64') },
					ts: { $t: 'datetime', v: '2026-05-06T07:08:09.123456Z' },
					local_ts: { $t: 'datetime', v: '2026-05-06T07:08:09.654321' },
					day: { $t: 'date', v: '2026-02-28' },
					meta: { $t: 'json', v: { a: [1, { b: null }], s: 'x"y', n: 1.5 } },
					doc: { $t: 'json', v: 'just a string' },
					ints: [1, null, 3],
					bigs: [1, { $t: 'bigint', v: '9007199254740993' }],
					stamps: [{ $t: 'datetime', v: '2026-01-01T00:00:00.000001Z' }, null],
					tags: ['a,b', 'quote"d', 'back\\slash', '{brace}', 'NULL'],
					label: 'ünïcødé 😀',
				};
				expect(await session.apply(types, [{ op: 'insert', values }], signal())).toEqual({ applied: 1, conflicts: [] });
				const row = await browseRow(session, types, 10);
				for (const [name, cell] of Object.entries(values)) expect(row[name], name).toEqual(cell);
				expect(row.generated_len).toBe(9);

				// Every browsed cell must work as an optimistic-concurrency original.
				const edited = Object.keys(values).filter((name) => name !== 'id');
				const update = await session.apply(
					types,
					[
						{
							op: 'update',
							key: { id: 10 },
							values: { label: 'edited', big: { $t: 'bigint', v: '-9223372036854775808' } },
							original: Object.fromEntries(edited.map((name) => [name, row[name] ?? null])),
						},
					],
					signal(),
				);
				expect(update).toEqual({ applied: 1, conflicts: [] });
				const after = await browseRow(session, types, 10);
				expect(after.label).toBe('edited');
				expect(after.big).toEqual({ $t: 'bigint', v: '-9223372036854775808' });
				expect(after.generated_len).toBe(6);
				expect(await session.apply(types, [{ op: 'delete', key: { id: 10 }, original: { label: 'edited' } }], signal())).toEqual({
					applied: 1,
					conflicts: [],
				});
			});
		});

		test('apply refuses generated columns, NULL keys and partial keys; conflicts roll back the batch', async () => {
			await withSession(false, async (session) => {
				await expect(session.apply(types, [{ op: 'update', key: { id: 1 }, values: { generated_len: 1 }, original: {} }], signal())).rejects.toMatchObject({ code: 'bad_request' });
				await expect(session.apply(types, [{ op: 'delete', key: { id: null } }], signal())).rejects.toMatchObject({ code: 'bad_request' });
				await expect(session.apply(types, [{ op: 'delete', key: {} }], signal())).rejects.toMatchObject({ code: 'bad_request' });
				const result = await session.apply(
					types,
					[
						{ op: 'update', key: { id: 1 }, values: { label: 'batch' }, original: { label: 'seed' } },
						{ op: 'update', key: { id: 1 }, values: { label: 'batch 2' }, original: { label: 'stale' } },
						{ op: 'delete', key: { id: 999 } },
					],
					signal(),
				);
				expect(result.applied).toBe(0);
				expect(result.conflicts.map((c) => c.index)).toEqual([1, 2]);
				expect(result.conflicts[1]?.reason).toContain('no longer exists');
				expect((await browseRow(session, types, 1)).label).toBe('seed');
				// A duplicate key is a conflict, not an engine error.
				const duplicate = await session.apply(types, [{ op: 'insert', values: { id: 1, label: 'dup' } }], signal());
				expect(duplicate.applied).toBe(0);
				expect(duplicate.conflicts[0]?.reason).toContain('pg:23505');
			});
		});

		test('read-only sessions refuse apply with read_only', async () => {
			await withSession(true, async (session) => {
				await expect(session.apply(ITEMS, [{ op: 'delete', key: { id: 1 } }], signal())).rejects.toMatchObject({ code: 'read_only' });
			});
		});

		test('keyset paging with a nullable sort column visits every row once, in order', async () => {
			await withSession(true, async (session) => {
				for (const dir of ['asc', 'desc'] as const) {
					const { names, rows } = await browseAll(session, ITEMS, { sort: [{ column: 'amount', dir }] });
					const ids = rows.map((r) => r[names.indexOf('id')]);
					expect(new Set(ids).size).toBe(ROW_COUNT);
					const amounts = rows.map((r) => {
						const cell = r[names.indexOf('amount')];
						return cell === null ? null : Number((cell as { v: string }).v);
					});
					const nulls = amounts.filter((a) => a === null).length;
					expect(nulls).toBe(Math.floor(ROW_COUNT / 7));
					// asc: NULLs last; desc: NULLs first.
					if (dir === 'asc') expect(amounts.slice(-nulls).every((a) => a === null)).toBe(true);
					else expect(amounts.slice(0, nulls).every((a) => a === null)).toBe(true);
					const present = amounts.filter((a): a is number => a !== null);
					const sorted = [...present].sort((a, b) => (dir === 'asc' ? a - b : b - a));
					expect(present).toEqual(sorted);
				}
			});
		});

		test('key-less tables page by ctid and views by offset', async () => {
			await withSession(true, async (session) => {
				const noKey = await browseAll(session, { path: ['public', 'studio_nokey'], kind: 'table' });
				expect(new Set(noKey.rows.map((r) => r[0])).size).toBe(95);
				const view = await browseAll(session, { path: ['public', 'studio_items_view'], kind: 'view' }, { sort: [{ column: 'id', dir: 'desc' }] });
				expect(view.rows.map((r) => r[0])).toEqual(Array.from({ length: ROW_COUNT }, (_, i) => ROW_COUNT - i));
			});
		});

		test('filters', async () => {
			await withSession(true, async (session) => {
				const count = async (filter: Parameters<StudioSession['browse']>[1]['filter']) => (await browseAll(session, ITEMS, { filter })).rows.length;
				expect(await count([{ column: 'name', op: 'ilike', value: 'ITEM 01%' }])).toBe(10);
				expect(await count([{ column: 'id', op: 'in', value: [1, 2, 3, 999] }])).toBe(3);
				expect(await count([{ column: 'amount', op: 'is-null' }])).toBe(Math.floor(ROW_COUNT / 7));
				expect(await count([{ column: 'id', op: 'gt', value: 200 }, { column: 'id', op: 'lte', value: 210 }])).toBe(10);
				expect(await count([{ column: 'big', op: 'eq', value: { $t: 'bigint', v: '25000000000000000' } }])).toBe(1);
				expect(await count([{ column: 'meta', op: 'eq', value: { $t: 'json', v: { even: true, n: 2 } } }])).toBe(1);
				expect(await count([{ column: 'created', op: 'lt', value: { $t: 'datetime', v: '2026-01-01T00:00:05Z' } }])).toBe(4);
				await expect(collect(session.browse(ITEMS, { limit: 10, sort: [], filter: [], native: '{}' }, signal()))).rejects.toMatchObject({
					code: 'unsupported',
				});
			});
		});

		test('large values are previewed in browse and loaded whole by value', async () => {
			await withSession(true, async (session) => {
				const row = await browseRow(session, types, 2);
				expect(row.label).toMatchObject({ $t: 'truncated', bytes: 100_000 });
				const full = await session.value?.(types, { id: 2 }, 'label', signal());
				expect(typeof full === 'string' && full.length).toBe(100_000);
			});
		});

		test('run: one columns…result group per statement, with command tags', async () => {
			await withSession(false, async (session) => {
				const events = await collect(
					session.run('SELECT 1 AS a; SELECT 2 AS b, 3 AS c; VALUES (4); UPDATE studio_items SET name = name WHERE id <= 3; SHOW TimeZone', runOpts, signal()),
				);
				expect(groups(events)).toEqual(['columns', 'result', 'columns', 'result', 'columns', 'result', 'result', 'columns', 'result']);
				expect(rowsOf(events)).toEqual([[1], [2, 3], [4], ['UTC']]);
				const results = events.filter((e) => e.t === 'result');
				expect(results[3]).toEqual({ t: 'result', command: 'UPDATE', affected: 3 });
				const returning = await collect(session.run('UPDATE studio_items SET name = name WHERE id = 5 RETURNING id, big', runOpts, signal()));
				expect(rowsOf(returning)).toEqual([[5, 500_000_000_000_000]]);
				// Duplicate column names survive (rows are arrays, not objects).
				expect(rowsOf(await collect(session.run('SELECT 1 AS x, 2 AS x', runOpts, signal())))).toEqual([[1, 2]]);
			});
		});

		test('run: write transactions work within a run and never span runs', async () => {
			await withSession(false, async (session) => {
				const committed = await collect(
					session.run("BEGIN; UPDATE studio_items SET name = 'tx' WHERE id = 7; SELECT name FROM studio_items WHERE id = 7; COMMIT", runOpts, signal()),
				);
				expect(rowsOf(committed)).toEqual([['tx']]);
				const open = await collect(session.run("BEGIN; UPDATE studio_items SET name = 'lost' WHERE id = 7", runOpts, signal()));
				expect(open.some((e) => e.t === 'notice')).toBe(true);
				const check = await collect(session.run('SELECT name FROM studio_items WHERE id = 7', runOpts, signal()));
				expect(rowsOf(check)).toEqual([['tx']]);
				// Session state does persist between runs.
				await collect(session.run('SET search_path = other, public', runOpts, signal()));
				expect(rowsOf(await collect(session.run('SELECT count(*)::int FROM studio_types', runOpts, signal())))).toEqual([[2]]);
			});
			await seedItems(port);
		});

		test('run: errors carry the SQLSTATE and the position in the whole input', async () => {
			await withSession(true, async (session) => {
				const input = 'SELECT 1;\nSELECT nope FROM studio_items';
				const events = await collect(session.run(input, runOpts, signal()));
				const error = events.find((e) => e.t === 'error');
				expect(error).toMatchObject({ t: 'error', code: 'engine_error' });
				expect(error?.t === 'error' && error.message).toContain('pg:42703');
				expect(error?.t === 'error' && error.position).toBe(input.indexOf('nope') + 1);
				expect(events.at(-1)?.t).toBe('done');
				const syntax = await collect(session.run('SELECT 1; INSERT INTO', runOpts, signal()));
				expect(syntax.find((e) => e.t === 'error')).toMatchObject({ position: 'SELECT 1; INSERT INTO'.length + 1 });
				const write = await collect(session.run('DELETE FROM studio_items', runOpts, signal()));
				expect(write.find((e) => e.t === 'error')).toMatchObject({ code: 'read_only' });
			});
		});

		test('run: statement timeout becomes a timeout error', async () => {
			await withSession(true, async (session) => {
				const started = performance.now();
				const events = await collect(session.run('SELECT pg_sleep(5)', { maxRows: 10, timeoutMs: 300 }, signal()));
				expect(events.find((e) => e.t === 'error')).toMatchObject({ code: 'timeout' });
				expect(performance.now() - started).toBeLessThan(3_000);
				// The session is still usable afterwards.
				expect(rowsOf(await collect(session.run('SELECT 1', runOpts, signal())))).toEqual([[1]]);
			});
		});

		test('run: abort cancels on the server and leaves the session usable', async () => {
			await withSession(false, async (session) => {
				const controller = new AbortController();
				setTimeout(() => controller.abort(), 200);
				await expect(collect(session.run('SELECT 1; SELECT pg_sleep(10)', runOpts, controller.signal))).rejects.toMatchObject({ code: 'cancelled' });
				expect(rowsOf(await collect(session.run('SELECT 2', runOpts, signal())))).toEqual([[2]]);
			});
		});

		test('explain returns a JSON plan; ANALYZE needs a write session', async () => {
			await withSession(true, async (session) => {
				const plan = await session.explain?.('SELECT * FROM studio_items WHERE id = 1', signal());
				expect(plan?.format).toBe('json');
				expect(JSON.stringify(plan?.plan)).toContain('studio_items');
				await expect(session.explain?.('EXPLAIN ANALYZE SELECT 1', signal()) ?? Promise.resolve()).rejects.toMatchObject({ code: 'read_only' });
			});
			await withSession(false, async (session) => {
				const plan = await session.explain?.('EXPLAIN (ANALYZE, BUFFERS) DELETE FROM studio_items', signal());
				expect(JSON.stringify(plan?.plan)).toContain('Actual Rows');
				// ANALYZE ran the DELETE inside a transaction that was rolled back.
				expect(rowsOf(await collect(session.run('SELECT count(*)::int FROM studio_items', runOpts, signal())))).toEqual([[ROW_COUNT]]);
			});
		});
	});
}
