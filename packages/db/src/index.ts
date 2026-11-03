import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.ts';
import { migrations } from './migrations.ts';

export * from './schema.ts';
export { migrations } from './migrations.ts';

export type SkiffDb = ReturnType<typeof createDb>['db'];

export interface OpenOptions {
	/** SQLite file path, or `:memory:` for tests. */
	path: string;
	/** Run pending SQL migrations on open. Default true. */
	migrate?: boolean;
}

/**
 * Migration ids that were published under an earlier name. An install that already applied the
 * old id has the schema change, so the renamed migration is recorded as applied instead of rerun
 * (SQLite's `ALTER TABLE` is not idempotent). Forward-only: aliases never remove history.
 */
export const migrationAliases: Readonly<Record<string, readonly string[]>> = {
	// v2 shipped this as 0003 before the v2 backend migration took that number.
	'0004_deployment_promoted_at.sql': ['0003_deployment_promoted_at.sql'],
};

/**
 * Open the platform database. Migrations are forward-only and tracked in `skiff_migrations`.
 * SQL is embedded at build time (`src/migrations.ts`) so the bundled control plane does not need
 * a migrations directory next to it. Better Auth runs its own stream in the control plane.
 */
export function createDb(options: OpenOptions) {
	if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
	const sqlite = new Database(options.path, { create: true, strict: true });
	for (const pragma of ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 5000'])
		sqlite.run(`PRAGMA ${pragma}`);
	if (options.migrate !== false) migrate(sqlite);
	return { sqlite, db: drizzle(sqlite, { schema }) };
}

export function migrate(sqlite: Database): string[] {
	sqlite.run(
		'CREATE TABLE IF NOT EXISTS skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
	);
	const applied = new Set(
		sqlite.query<{ id: string }, []>('SELECT id FROM skiff_migrations').all().map((row) => row.id),
	);
	const ran: string[] = [];
	for (const migration of migrations) {
		if (applied.has(migration.id)) continue;
		const aliases = migrationAliases[migration.id] ?? [];
		if (aliases.some((alias) => applied.has(alias))) {
			sqlite.run('INSERT INTO skiff_migrations (id, applied_at) VALUES (?, ?)', [migration.id, Date.now()]);
			applied.add(migration.id);
			ran.push(`${migration.id} (already applied as ${aliases.find((alias) => applied.has(alias))})`);
			continue;
		}
		sqlite.transaction(() => {
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO skiff_migrations (id, applied_at) VALUES (?, ?)', [
				migration.id,
				Date.now(),
			]);
		})();
		ran.push(migration.id);
	}
	return ran;
}

/** Reset helper for tests / the monthly restore drill. */
export function truncateAll(sqlite: Database): void {
	const tables = sqlite
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'skiff_migrations'",
		)
		.all();
	sqlite.run('PRAGMA foreign_keys = OFF');
	for (const { name } of tables) sqlite.run(`DELETE FROM "${name}"`);
	sqlite.run('PRAGMA foreign_keys = ON');
}
