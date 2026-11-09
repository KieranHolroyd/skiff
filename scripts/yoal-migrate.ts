/**
 * Forward-only SQL migration runner for the Yoal control-plane database.
 *
 * Used by scripts/restore.sh before the control plane starts. The control plane also
 * applies these migrations on open (packages/db), so this is intentionally the same
 * idempotent algorithm: sorted *.sql files tracked in yoal_migrations.
 *
 * Usage: bun yoal-migrate.ts <db-path> <migrations-dir>
 */
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dbPath, migrationsDir] = process.argv.slice(2);
if (!dbPath || !migrationsDir) {
	console.error('usage: bun yoal-migrate.ts <db-path> <migrations-dir>');
	process.exit(2);
}

const files = readdirSync(migrationsDir)
	.filter((file) => /^\d+_.*\.sql$/.test(file))
	.sort();

const db = new Database(dbPath, { create: true, strict: true });
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(
	'CREATE TABLE IF NOT EXISTS yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
);

const applied = new Set(
	(db.query('SELECT id FROM yoal_migrations').all() as Array<{ id: string }>).map((row) => row.id),
);

let count = 0;
for (const file of files) {
	if (applied.has(file)) continue;
	const sql = readFileSync(join(migrationsDir, file), 'utf8');
	const apply = db.transaction(() => {
		db.exec(sql);
		db.query('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)').run(file, Date.now());
	});
	apply();
	count += 1;
	console.log(`applied ${file}`);
}

db.close();
console.log(`migrations: ${count} applied, ${files.length - count} already present`);
