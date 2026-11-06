import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { D1DatabaseObject } from './d1.js';

const BASE = 'https://d1.internal';

/**
 * `bun:sqlite` adapter for workerd's `DurableObjectStorage.sql`.
 *
 * The real cursor exposes `columnNames`, `raw()` and `rowsRead`/`rowsWritten`; Bun gives us the
 * column names and rows, so `rowsRead` is the number of rows the statement returned (a SELECT's
 * result size, not the rows SQLite scanned) and `rowsWritten` is the `total_changes()` delta around
 * the statement. Both are close enough to exercise the worker's metadata arithmetic.
 */
class FakeSqlCursor {
	columnNames: string[];
	rowsRead: number;
	rowsWritten: number;
	#rows: unknown[][];

	constructor(columnNames: string[], rows: unknown[][], rowsWritten: number) {
		this.columnNames = columnNames;
		this.#rows = rows;
		this.rowsRead = rows.length;
		this.rowsWritten = rowsWritten;
	}

	raw() {
		return this.#rows[Symbol.iterator]();
	}

	toArray() {
		return this.#rows.map((row) =>
			Object.fromEntries(this.columnNames.map((name, index) => [name, row[index]])),
		);
	}
}

function toBunValue(value: unknown) {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return value;
	return value;
}

class FakeSqlStorage {
	db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	/** Page-based size, so it grows when a statement allocates pages like a real SQLite file. */
	get databaseSize() {
		const pageCount = (this.db.query('PRAGMA page_count').get() as { page_count: number }).page_count;
		const pageSize = (this.db.query('PRAGMA page_size').get() as { page_size: number }).page_size;
		return pageCount * pageSize;
	}

	exec(sql: string, ...params: unknown[]) {
		const before = this.totalChanges();
		const statement = this.db.query(sql);
		const rows = (statement.values(...params.map(toBunValue)) as unknown[][] | null) ?? [];
		const after = this.totalChanges();
		return new FakeSqlCursor([...statement.columnNames], rows, after - before);
	}

	totalChanges() {
		return (this.db.query('SELECT total_changes() AS n').get() as { n: number }).n;
	}
}

function makeObject() {
	const db = new Database(':memory:');
	const sql = new FakeSqlStorage(db);
	const storage = {
		sql,
		// The worker runs every request in one transaction; BEGIN/ROLLBACK gives the test the same
		// all-or-nothing behaviour workerd's `storage.transaction` gives the real object.
		async transaction(fn: () => unknown) {
			db.run('BEGIN');
			try {
				const result = await fn();
				db.run('COMMIT');
				return result;
			} catch (error) {
				try {
					db.run('ROLLBACK');
				} catch {
					// SQLite may already have rolled the transaction back for a fatal error.
				}
				throw error;
			}
		},
	};
	return { object: new D1DatabaseObject({ storage }, {}), db, sql };
}

function request(path: string, body: unknown, params: Record<string, string> = {}) {
	const search = new URLSearchParams(params);
	const suffix = search.toString();
	return new Request(`${BASE}${path}${suffix ? `?${suffix}` : ''}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

/** The raw reply: an array of success responses, or one failure object. */
async function query(
	object: InstanceType<typeof D1DatabaseObject>,
	body: unknown,
	format?: string,
): Promise<any> {
	const response = await object.fetch(
		request('/query', body, format === undefined ? {} : { resultsFormat: format }),
	);
	expect(response.status).toBe(200);
	return response.json();
}

/** The reply for exactly one statement, unwrapped from the one-element array. */
async function queryOne(
	object: InstanceType<typeof D1DatabaseObject>,
	body: unknown,
	format?: string,
): Promise<any> {
	const reply = await query(object, body, format);
	expect(Array.isArray(reply)).toBe(true);
	expect(reply).toHaveLength(1);
	return reply[0];
}

async function execute(
	object: InstanceType<typeof D1DatabaseObject>,
	body: unknown,
	format = 'NONE',
): Promise<any> {
	const response = await object.fetch(request('/execute', body, { resultsFormat: format }));
	expect(response.status).toBe(200);
	return response.json();
}

describe('D1DatabaseObject /query', () => {
	test('creates a table, inserts a row and selects it back as objects', async () => {
		const { object } = makeObject();
		const created = await queryOne(object, {
			sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)',
		});
		expect(created.success).toBe(true);
		expect(created.results).toEqual([]);

		const inserted = await queryOne(object, {
			sql: 'INSERT INTO users (name) VALUES (?)',
			params: ['ada'],
		});
		expect(inserted.success).toBe(true);
		expect(inserted.meta.changes).toBe(1);
		expect(inserted.meta.last_row_id).toBe(1);
		expect(inserted.meta.changed_db).toBe(true);
		expect(inserted.meta.rows_written).toBe(1);

		const selected = await queryOne(object, { sql: 'SELECT id, name FROM users' });
		expect(selected.success).toBe(true);
		expect(selected.results).toEqual([{ id: 1, name: 'ada' }]);
		expect(selected.meta.changed_db).toBe(false);
		expect(selected.meta.rows_read).toBe(1);
		expect(selected.meta.rows_written).toBe(0);
	});

	test('binds positional parameters, including blobs', async () => {
		const { object } = makeObject();
		await queryOne(object, { sql: 'CREATE TABLE blobs (id INTEGER, body BLOB)' });
		await queryOne(object, {
			sql: 'INSERT INTO blobs (id, body) VALUES (?, ?)',
			params: [7, [0, 1, 2, 255]],
		});

		const selected = await queryOne(object, { sql: 'SELECT id, body FROM blobs' });
		// D1 surfaces blobs as arrays of bytes in both result shapes (Miniflare's convertRows).
		expect(selected.results).toEqual([{ id: 7, body: [0, 1, 2, 255] }]);

		const raw = await queryOne(
			object,
			{ sql: 'SELECT id, body FROM blobs' },
			'ROWS_AND_COLUMNS',
		);
		expect(raw.results).toEqual({ columns: ['id', 'body'], rows: [[7, [0, 1, 2, 255]]] });
	});

	test('returns an array of responses for an array of statements, in order', async () => {
		const { object } = makeObject();
		const results = await query(object, [
			{ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)' },
			{ sql: 'INSERT INTO t (label) VALUES (?)', params: ['one'] },
			{ sql: 'INSERT INTO t (label) VALUES (?)', params: ['two'] },
			{ sql: 'SELECT label FROM t ORDER BY id' },
		]);
		expect(Array.isArray(results)).toBe(true);
		expect(results).toHaveLength(4);
		expect(results[0].success).toBe(true);
		expect(results[1].meta.changes).toBe(1);
		expect(results[2].meta.changes).toBe(1);
		expect(results[3].results).toEqual([{ label: 'one' }, { label: 'two' }]);
	});

	test('rolls the whole request back when a later statement fails', async () => {
		const { object } = makeObject();
		await queryOne(object, { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY)' });

		const failed = await query(object, [
			{ sql: 'INSERT INTO t (id) VALUES (1)' },
			{ sql: 'SELEC broken' },
		]);
		expect(failed.success).toBe(false);
		expect(failed.error).toContain('syntax error');
		// A failed batch answers one failure object, not an array: d1-api throws D1_ERROR on it.
		expect(Array.isArray(failed)).toBe(false);

		const after = await queryOne(object, { sql: 'SELECT COUNT(*) AS n FROM t' });
		expect(after.results).toEqual([{ n: 0 }]);
	});

	test('returns an empty results array for a statement with no rows', async () => {
		const { object } = makeObject();
		const created = await queryOne(object, { sql: 'CREATE TABLE empty (id INTEGER)' });
		expect(created.results).toEqual([]);
		const selected = await queryOne(object, { sql: 'SELECT * FROM empty' }, 'ROWS_AND_COLUMNS');
		expect(selected.results).toEqual({ columns: ['id'], rows: [] });
	});

	test('reports the metadata d1-api needs, including a duration', async () => {
		const { object, sql } = makeObject();
		await queryOne(object, { sql: 'CREATE TABLE meta (id INTEGER PRIMARY KEY)' });
		const inserted = await queryOne(object, {
			sql: 'INSERT INTO meta (id) VALUES (?)',
			params: [1],
		});

		expect(inserted.meta.served_by).toBe('skiff.d1');
		expect(inserted.meta.served_by_primary).toBe(true);
		expect(inserted.meta.total_attempts).toBe(1);
		expect(inserted.meta.changes).toBe(1);
		expect(inserted.meta.last_row_id).toBe(1);
		expect(inserted.meta.changed_db).toBe(true);
		expect(inserted.meta.size_after).toBe(sql.databaseSize);
		expect(inserted.meta.rows_written).toBe(1);
		expect(typeof inserted.meta.duration).toBe('number');
		expect(inserted.meta.duration).toBeGreaterThanOrEqual(0);
		expect(inserted.meta.timings.sql_duration_ms).toBe(inserted.meta.duration);
	});
});

describe('result formats', () => {
	async function seeded() {
		const made = makeObject();
		await queryOne(made.object, { sql: 'CREATE TABLE f (id INTEGER, label TEXT)' });
		await queryOne(made.object, {
			sql: 'INSERT INTO f (id, label) VALUES (?, ?)',
			params: [1, 'one'],
		});
		return made;
	}

	test('defaults to ARRAY_OF_OBJECTS when the format is missing or unknown', async () => {
		const { object } = await seeded();
		const missing = await queryOne(object, { sql: 'SELECT * FROM f' });
		expect(missing.results).toEqual([{ id: 1, label: 'one' }]);

		const unknown = await queryOne(object, { sql: 'SELECT * FROM f' }, 'SOMETHING_ELSE');
		expect(unknown.results).toEqual([{ id: 1, label: 'one' }]);
	});

	test('ARRAY_OF_OBJECTS and NONE both return objects, matching Miniflare', async () => {
		const { object } = await seeded();
		expect(
			(await queryOne(object, { sql: 'SELECT * FROM f' }, 'ARRAY_OF_OBJECTS')).results,
		).toEqual([{ id: 1, label: 'one' }]);
		// Miniflare's note: NONE is inconsistent with workerd and still returns rows here. D1's
		// run()/exec() only read meta, so this is harmless and kept for parity.
		expect((await queryOne(object, { sql: 'SELECT * FROM f' }, 'NONE')).results).toEqual([
			{ id: 1, label: 'one' },
		]);
	});

	test('ROWS_AND_COLUMNS returns the raw envelope with column names', async () => {
		const { object } = await seeded();
		const response = await queryOne(object, { sql: 'SELECT id, label FROM f' }, 'ROWS_AND_COLUMNS');
		expect(response.results).toEqual({ columns: ['id', 'label'], rows: [[1, 'one']] });
	});
});

describe('/execute', () => {
	test('runs an array of statements and returns one response per statement', async () => {
		const { object } = makeObject();
		const results = await execute(object, [
			{ sql: 'CREATE TABLE e (id INTEGER)' },
			{ sql: 'INSERT INTO e (id) VALUES (1)' },
			{ sql: 'INSERT INTO e (id) VALUES (2)' },
		]);
		expect(results).toHaveLength(3);
		expect(results.map((result: any) => result.meta.changes)).toEqual([0, 1, 1]);
	});

	test('accepts a single statement, as prepare().run() sends', async () => {
		const { object } = makeObject();
		await execute(object, { sql: 'CREATE TABLE one (id INTEGER PRIMARY KEY)' });
		const results = await execute(object, {
			sql: 'INSERT INTO one (id) VALUES (?)',
			params: [5],
		});
		expect(results).toHaveLength(1);
		expect(results[0].meta.changes).toBe(1);
		expect(results[0].meta.last_row_id).toBe(5);
	});
});

describe('errors', () => {
	test('turns a SQL error into a D1 failure body with HTTP 200', async () => {
		const { object } = makeObject();
		const response = await object.fetch(request('/query', { sql: 'NOT SQL AT ALL' }));
		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.success).toBe(false);
		expect(body.error).toContain('syntax error');
	});

	test('rejects a missing sql field, non-array params and a bad body', async () => {
		const { object } = makeObject();
		for (const [body, message] of [
			[{}, 'objects of the form'],
			[{ sql: 42 }, 'objects of the form'],
			[{ sql: 'SELECT 1', params: 'nope' }, 'params must be an array'],
		] as const) {
			const failed = await query(object, body);
			expect(failed.success).toBe(false);
			expect(failed.error).toContain(message);
		}

		const badJson = await object.fetch(request('/query', 'not json'));
		expect(badJson.status).toBe(200);
		expect((await badJson.json()) as any).toMatchObject({
			success: false,
			error: 'D1 request body is not valid JSON.',
		});
	});

	test('rejects a request with no executable statements', async () => {
		const { object } = makeObject();
		for (const body of [[], [{ sql: '   ' }], [{ sql: '-- only a comment' }]]) {
			const failed = await query(object, body);
			expect(failed.success).toBe(false);
			expect(failed.error).toBe('No SQL statements detected.');
		}
	});

	test('accepts a statement whose leading comment line is stripped for the emptiness check', async () => {
		const { object } = makeObject();
		const result = await queryOne(object, { sql: '-- a comment\nSELECT 1 AS one' });
		expect(result.results).toEqual([{ one: 1 }]);
	});

	test('refuses unknown endpoints and methods with 404 and a D1 failure body', async () => {
		const { object } = makeObject();
		for (const init of [
			new Request(`${BASE}/dump`, { method: 'POST', body: '{}' }),
			new Request(`${BASE}/query`, { method: 'GET' }),
		]) {
			const response = await object.fetch(init);
			expect(response.status).toBe(404);
			expect((await response.json()) as any).toMatchObject({ success: false });
		}
	});
});

describe('limits', () => {
	test('refuses a request body over the byte cap', async () => {
		const { object } = makeObject();
		object.maxRequestBytes = 16;
		const failed = await query(object, { sql: 'SELECT 1 AS one' });
		expect(failed.success).toBe(false);
		expect(failed.error).toContain('over the 16-byte limit');
	});

	test('refuses more statements than the batch cap', async () => {
		const { object } = makeObject();
		object.maxStatements = 1;
		const failed = await query(object, [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]);
		expect(failed.success).toBe(false);
		expect(failed.error).toBe('A D1 request can run at most 1 statement; this one has 2.');
	});

	test('refuses a result over the row cap and leaves the database usable', async () => {
		const { object } = makeObject();
		await queryOne(object, { sql: 'CREATE TABLE many (id INTEGER)' });
		await query(object, [
			{ sql: 'INSERT INTO many (id) VALUES (1)' },
			{ sql: 'INSERT INTO many (id) VALUES (2)' },
		]);

		object.maxResultRows = 1;
		const failed = await query(object, { sql: 'SELECT * FROM many' });
		expect(failed.success).toBe(false);
		expect(failed.error).toContain('over the per-query limit');

		object.maxResultRows = 10;
		const recovered = await queryOne(object, { sql: 'SELECT * FROM many' });
		expect(recovered.results).toHaveLength(2);
	});
});

describe('default export', () => {
	test('routes every request to the "default" Durable Object', async () => {
		const seen: Array<{ id: unknown; url: string }> = [];
		const env = {
			DO: {
				idFromName(name: string) {
					return { name };
				},
				get(id: { name: string }) {
					return {
						async fetch(request: Request) {
							seen.push({ id, url: request.url });
							return new Response('from-object');
						},
					};
				},
			},
		};

		const worker = (await import('./d1.js')).default;
		const target = request('/query?resultsFormat=NONE', { sql: 'SELECT 1' });
		const response = await worker.fetch(target, env);
		expect(await response.text()).toBe('from-object');
		expect(seen).toHaveLength(1);
		expect(seen[0]!.id).toEqual({ name: 'default' });
		expect(seen[0]!.url).toBe(target.url);
	});
});
