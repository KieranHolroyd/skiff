import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.ts';
import { migrations } from './migrations.ts';

export * from './schema.ts';
export { migrations } from './migrations.ts';

export type YoalDb = ReturnType<typeof createDb>['db'];

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
	// D126's variant migration first landed as 0053, before 0053_backup_locations took that
	// number; it then sat at 0067 until the unreleased 0052–0066 range was packed gap-free.
	// Every file below runs non-idempotent ALTERs, so an install (in practice a dev database)
	// that applied an old id must not run the new one.
	'0055_database_variant.sql': ['0053_database_variant.sql', '0067_database_variant.sql'],
	'0056_workload_restart.sql': ['0054_workload_restart.sql', '0068_workload_restart.sql'],
	'0057_storage_replication_runner.sql': ['0059_storage_replication_runner.sql'],
	'0058_failover_events.sql': ['0060_failover_events.sql'],
	'0059_jobs.sql': ['0061_jobs.sql'],
	'0060_log_drains.sql': ['0063_log_drains.sql'],
	'0061_app_volume_snapshots.sql': ['0064_app_volume_snapshots.sql'],
	'0062_oauth_client_usage.sql': ['0065_oauth_client_usage.sql'],
	'0063_email_sandbox_flows.sql': ['0066_email_sandbox_flows.sql'],
	'0064_database_replica_streaming.sql': ['0069_database_replica_streaming.sql'],
	'0065_database_pitr_window.sql': ['0070_database_pitr_window.sql'],
	'0066_blueprints.sql': ['0071_blueprints.sql'],
};

/**
 * Open the platform database. Migrations are forward-only and tracked in `yoal_migrations`.
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
		'CREATE TABLE IF NOT EXISTS yoal_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
	);
	const applied = new Set(
		sqlite.query<{ id: string }, []>('SELECT id FROM yoal_migrations').all().map((row) => row.id),
	);
	const ran: string[] = [];
	for (const migration of migrations) {
		if (applied.has(migration.id)) continue;
		const aliases = migrationAliases[migration.id] ?? [];
		if (aliases.some((alias) => applied.has(alias))) {
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [migration.id, Date.now()]);
			applied.add(migration.id);
			ran.push(`${migration.id} (already applied as ${aliases.find((alias) => applied.has(alias))})`);
			continue;
		}
		sqlite.transaction(() => {
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO yoal_migrations (id, applied_at) VALUES (?, ?)', [
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
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'yoal_migrations'",
		)
		.all();
	sqlite.run('PRAGMA foreign_keys = OFF');
	for (const { name } of tables) sqlite.run(`DELETE FROM "${name}"`);
	sqlite.run('PRAGMA foreign_keys = ON');
}

/**
 * The identity process's own database (docs/IAM.md §11.2, I27). One file per node, not per pool,
 * so a pool can move between nodes by syncing one projection; the auth tables are the existing
 * `user_pool_*` migrations. It is separate from the control plane's `yoal.db`, which must never
 * hold tenant users, and Litestream replicates it independently (`scripts/litestream-identity.yml`).
 *
 * `identity_pools` is the sync marker: the node's agent pushes the non-secret projection from
 * desired state, and the app mirrors it into `user_pools`/`user_pool_clients`, which is what
 * `UserPoolService` and `UserPoolEngineService` already read. Keeping the marker table makes the
 * last applied host/issuer/generation visible to an operator without inferring it from auth rows.
 */
export function openIdentityDb(options: OpenOptions) {
	const opened = createDb(options);
	opened.sqlite.run(`
CREATE TABLE IF NOT EXISTS identity_pools (
  pool_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  host TEXT NOT NULL,
  issuer TEXT NOT NULL,
  generation INTEGER NOT NULL,
  synced_at INTEGER NOT NULL
)`);
	return opened;
}
