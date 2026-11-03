import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate, migrations } from './index.ts';

/**
 * A v2 install that ran the promotion migration while it was numbered 0003 must not fail when the
 * renamed 0004 is embedded: ALTER TABLE would otherwise be a duplicate-column error.
 */
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
