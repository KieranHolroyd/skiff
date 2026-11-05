import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, migrations } from './index.ts';

/**
 * A v2 install that ran the promotion migration while it was numbered 0003 must not fail when the
 * renamed 0004 is embedded: ALTER TABLE would otherwise be a duplicate-column error.
 */
describe('0023 org networks upgrade', () => {
	test('backfills built-in credentials and keeps existing attachments working', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
		const apply = (id: string) => {
			const migration = migrations.find((entry) => entry.id === id);
			if (!migration) throw new Error(`missing migration ${id}`);
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO skiff_migrations (id, applied_at) VALUES (?, ?)', [id, Date.now()]);
		};
		for (const migration of migrations) {
			if (Number(migration.id.slice(0, 4)) <= 18) apply(migration.id);
		}
		sqlite.run(
			`INSERT INTO databases
			 (id, org_id, name, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
			 VALUES ('db_old', 'org_1', 'old-db', '17', 'nod_1', 15432, 256, 'owner-sealed', 'monitor-sealed', 'user_1', 1, 1)`,
		);
		sqlite.run(
			`INSERT INTO database_attachments (id, org_id, database_id, project_id, created_by, created_at)
			 VALUES ('dba_old', 'org_1', 'db_old', 'prj_1', 'user_1', 1)`,
		);

		apply('0023_org_networks.sql');

		const credentials = sqlite
			.query<{ role: string; username: string; secret_sealed: string }, []>(
				"SELECT role, username, secret_sealed FROM database_credentials WHERE database_id = 'db_old' ORDER BY role",
			)
			.all();
		expect(credentials).toEqual([
			{ role: 'monitor', username: 'skiff_monitor', secret_sealed: 'monitor-sealed' },
			{ role: 'owner', username: 'old_db', secret_sealed: 'owner-sealed' },
		]);
		const attachment = sqlite
			.query<{ credential_id: string | null }, []>(
				"SELECT credential_id FROM database_attachments WHERE id = 'dba_old'",
			)
			.get();
		expect(attachment?.credential_id).toBeNull();
		expect(
			sqlite.query<{ name: string }, []>('PRAGMA table_info(storage_attachments)').all().some((row) => row.name === 'credential_id'),
		).toBe(true);
		sqlite.close();
	});
});

describe('migration aliases', () => {
	test('records a renamed migration as applied instead of rerunning it', () => {
		const sqlite = new Database(':memory:', { create: true, strict: true });
		sqlite.run('CREATE TABLE skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

		const apply = (id: string) => {
			const migration = migrations.find((entry) => entry.id === id);
			if (!migration) throw new Error(`missing migration ${id}`);
			sqlite.run(migration.sql);
			sqlite.run('INSERT INTO skiff_migrations (id, applied_at) VALUES (?, ?)', [id, Date.now()]);
		};

		apply('0001_init.sql');
		apply('0002_cli_login_codes.sql');
		// The pre-rename id, with the same schema change, already recorded.
		const promoted = migrations.find((entry) => entry.id === '0004_deployment_promoted_at.sql')!;
		sqlite.run(promoted.sql);
		sqlite.run("INSERT INTO skiff_migrations (id, applied_at) VALUES ('0003_deployment_promoted_at.sql', ?)", [Date.now()]);

		expect(() => migrate(sqlite)).not.toThrow();
		const ids = sqlite
			.query<{ id: string }, []>('SELECT id FROM skiff_migrations ORDER BY id')
			.all()
			.map((row) => row.id);
		expect(ids).toContain('0004_deployment_promoted_at.sql');
		expect(ids).toContain('0003_v2_backend.sql');
		const columns = sqlite
			.query<{ name: string }, []>('PRAGMA table_info(deployments)')
			.all()
			.filter((row) => row.name === 'promoted_at');
		expect(columns).toHaveLength(1);
		sqlite.close();
	});
});
