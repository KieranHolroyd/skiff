/**
 * Deterministic fingerprint of a Skiff SQLite database.
 *
 * The restore drill compares the live database with the database restored from R2:
 * table names, row counts and a SHA-256 over every row (ordered by primary key).
 * The output is stable JSON so `cmp` can compare two runs without parsing SQL.
 *
 * Usage: bun skiff-db-fingerprint.ts <db-path>
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const dbPath = process.argv[2];
if (!dbPath) {
	console.error('usage: bun skiff-db-fingerprint.ts <db-path>');
	process.exit(2);
}
if (!existsSync(dbPath)) {
	console.error(`skiff-db-fingerprint: database not found: ${dbPath}`);
	process.exit(2);
}

// Open read-write: a WAL database needs to create/recover its -shm file even for a
// read-only query, and readonly opens fail with SQLITE_CANTOPEN when the sidecars are
// absent (as in a freshly restored snapshot).
const db = new Database(dbPath, { strict: true });
db.exec('PRAGMA query_only = ON');

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function encode(value: unknown): string {
	if (value === null || value === undefined) return 'N';
	if (typeof value === 'string') return `S${value.length}:${value}`;
	if (typeof value === 'number') return `D${value}`;
	if (typeof value === 'bigint') return `I${value.toString()}`;
	if (value instanceof Uint8Array) return `B${Buffer.from(value).toString('hex')}`;
	return `J${JSON.stringify(value)}`;
}

const tables = (
	db
		.query(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as Array<{ name: string }>
).map((row) => row.name);

const summary = createHash('sha256');
const result: Record<string, { rows: number; sha256: string }> = {};

for (const table of tables) {
	const info = db.query(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
		name: string;
		pk: number;
	}>;
	const columns = info.map((column) => column.name);
	const primaryKey = info
		.filter((column) => column.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((column) => quoteIdent(column.name));

	const orderBy = primaryKey.length > 0 ? `ORDER BY ${primaryKey.join(', ')}` : '';
	const statement = db.query(`SELECT * FROM ${quoteIdent(table)} ${orderBy}`);
	const hash = createHash('sha256');
	let rows = 0;

	for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
		for (const column of columns) {
			hash.update(column);
			hash.update('=');
			hash.update(encode(row[column]));
			hash.update(';');
		}
		hash.update('\n');
		rows += 1;
	}

	const digest = hash.digest('hex');
	result[table] = { rows, sha256: digest };
	summary.update(`${table}:${rows}:${digest}\n`);
}

db.close();

console.log(
	JSON.stringify(
		{
			tables: result,
			sha256: summary.digest('hex'),
		},
		null,
		2,
	),
);
