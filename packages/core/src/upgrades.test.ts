import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	buildReadyzReport,
	createUpgradeSnapshotBundle,
	evaluateUpgradePreflight,
	isPostgresMajorChange,
	listUpgradeSnapshotBundles,
	markUpgradeSnapshotUnpinned,
	pendingMigrations,
	postgresMajor,
	pruneUpgradeSnapshotBundles,
	retireUpgradeSnapshotBundles,
	selectRollbackSnapshot,
	type DataDirStatus
} from './upgrade-plan.ts';

const root = mkdtempSync(join(tmpdir(), 'yoal-upgrades-'));
const writableDir = (name: string, path: string): DataDirStatus => ({
	name,
	path,
	exists: true,
	writable: true
});
const dirs: DataDirStatus[] = [
	writableDir('data', join(root, 'data')),
	writableDir('objects', join(root, 'objects')),
	writableDir('backups', join(root, 'backups'))
];
for (const dir of dirs) mkdirSync(dir.path, { recursive: true });

afterAll(() => rmSync(root, { recursive: true, force: true }));

function migration(id: string, sql = 'CREATE TABLE IF NOT EXISTS x (id TEXT);') {
	return { id, sql };
}

describe('version comparison', () => {
	test('extracts PostgreSQL majors from tags', () => {
		expect(postgresMajor('17')).toBe('17');
		expect(postgresMajor('17.2')).toBe('17');
		expect(postgresMajor('16-alpine')).toBe('16');
		expect(postgresMajor('v15.4-bookworm')).toBe('15');
		expect(postgresMajor('latest')).toBeNull();
	});

	test('only a different major is a major change', () => {
		expect(isPostgresMajorChange('16', '17')).toBe(true);
		expect(isPostgresMajorChange('17.1', '17.4')).toBe(false);
		expect(isPostgresMajorChange('17-alpine', '17-bookworm')).toBe(false);
	});

	test('refuses a semver downgrade in the preflight', () => {
		const plan = evaluateUpgradePreflight({
			currentVersion: '1.5.0',
			targetVersion: '1.4.0',
			freeBytes: 10_000_000,
			controlDbBytes: 1,
			dataDirs: dirs,
			backupTarget: { kind: 'local', reachable: true }
		});
		expect(plan.ok).toBe(false);
		expect(plan.versionChange).toBe('downgrade');
		expect(plan.errors.join(' ')).toMatch(/older than the running/);
	});
});

describe('preflight rules', () => {
	const base = {
		currentVersion: '1.0.0',
		targetVersion: '1.1.0',
		controlDbBytes: 1_000,
		freeBytes: 10_000,
		dataDirs: dirs,
		backupTarget: { kind: 'local' as const, reachable: true }
	};

	test('passes a healthy upgrade and lists pending migrations', () => {
		const plan = evaluateUpgradePreflight({
			...base,
			migrations: [migration('0001_init.sql'), migration('0002_add.sql')],
			appliedMigrations: ['0001_init.sql']
		});
		expect(plan.ok).toBe(true);
		expect(plan.migrations.pending.map((item) => item.id)).toEqual(['0002_add.sql']);
		expect(plan.migrations.destructive).toBe(false);
		expect(plan.versionChange).toBe('upgrade');
	});

	test('refuses an unreachable backup target with an actionable message', () => {
		const plan = evaluateUpgradePreflight({
			...base,
			backupTarget: { kind: 'r2', reachable: false, error: '403 Forbidden' }
		});
		expect(plan.ok).toBe(false);
		expect(plan.errors.join(' ')).toMatch(/backup target \(r2\) is unreachable.*Settings → Backups/);
	});

	test('refuses less than 2× the control database in free space', () => {
		const plan = evaluateUpgradePreflight({ ...base, controlDbBytes: 5_000, freeBytes: 9_999 });
		expect(plan.ok).toBe(false);
		expect(plan.controlDb.requiredBytes).toBe(10_000);
		expect(plan.errors.join(' ')).toMatch(/snapshot needs 2×/);
	});

	test('refuses a missing or unwritable data directory', () => {
		const plan = evaluateUpgradePreflight({
			...base,
			dataDirs: [
				...dirs,
				{ name: 'volumes', path: join(root, 'missing'), exists: false, writable: false }
			]
		});
		expect(plan.ok).toBe(false);
		expect(plan.errors.join(' ')).toMatch(/Data directory .* is missing/);
	});

	test('marks destructive migrations and refuses without explicit approval', () => {
		const plan = evaluateUpgradePreflight({
			...base,
			migrations: [migration('0003_drop_old.sql', 'DROP TABLE old;')],
			appliedMigrations: []
		});
		expect(plan.ok).toBe(false);
		expect(plan.migrations.destructive).toBe(true);
		expect(plan.errors.join(' ')).toMatch(/Destructive migration 0003_drop_old\.sql \(DROP TABLE on line 1\)/);
		expect(plan.errors.join(' ')).toMatch(/Settings → Updates → Review and approve.*yoal-update-self --allow-destructive/);

		// Approving by id covers exactly the named migrations.
		const byId = (approved: string[]) =>
			evaluateUpgradePreflight({
				...base,
				migrations: [migration('0003_drop_old.sql', 'DROP TABLE old;'), migration('0004_drop_more.sql', 'ALTER TABLE t DROP COLUMN c;')],
				appliedMigrations: [],
				approvedDestructiveMigrations: approved
			});
		expect(byId(['0003_drop_old.sql']).errors.join(' ')).toMatch(/Destructive migration 0004_drop_more\.sql \(DROP COLUMN on line 1\)/);
		expect(byId(['0003_drop_old.sql', '0004_drop_more.sql']).ok).toBe(true);

		const approved = evaluateUpgradePreflight({
			...base,
			migrations: [migration('0003_drop_old.sql', 'DROP TABLE old;')],
			appliedMigrations: [],
			allowDestructiveMigrations: true
		});
		expect(approved.ok).toBe(true);
		expect(approved.warnings.join(' ')).toMatch(/explicitly approved/);
	});

	test('refuses a target that predates the applied schema', () => {
		const plan = evaluateUpgradePreflight({
			...base,
			migrations: [migration('0001_init.sql')],
			appliedMigrations: ['0001_init.sql', '0002_newer.sql']
		});
		expect(plan.ok).toBe(false);
		expect(plan.migrations.unknownApplied).toEqual(['0002_newer.sql']);
		expect(plan.errors.join(' ')).toMatch(/predates the current schema/);
	});

	test('refuses a requested PostgreSQL major change and points at the wizard', () => {
		const plan = evaluateUpgradePreflight({
			...base,
			managedDatabases: [{ name: 'main', version: '16', requestedVersion: '17' }]
		});
		expect(plan.ok).toBe(false);
		expect(plan.postgresWizardRequired).toBe(true);
		expect(plan.managedDatabases.majorChanges).toEqual([{ name: 'main', from: '16', to: '17' }]);
		expect(plan.errors.join(' ')).toMatch(/yoal db upgrade <name> --to <version> --plan/);
	});

	test('does not treat a same-major database as a change', () => {
		const plan = evaluateUpgradePreflight({
			...base,
			managedDatabases: [{ name: 'main', version: '17', requestedVersion: '17' }]
		});
		expect(plan.ok).toBe(true);
		expect(plan.postgresWizardRequired).toBe(false);
	});

	test('pendingMigrations classifies only unapplied files', () => {
		const pending = pendingMigrations(
			[
				migration('0001_init.sql'),
				migration('0002_drop.sql', '-- DROP TABLE in a comment\nALTER TABLE t DROP COLUMN c;')
			],
			['0001_init.sql']
		);
		expect(pending.map((item) => item.id)).toEqual(['0002_drop.sql']);
		expect(pending[0]?.destructive).toBe(true);
	});
});

describe('snapshot bundles', () => {
	function makeDb(path: string, value: string): void {
		mkdirSync(dirname(path), { recursive: true });
		const db = new Database(path, { create: true });
		db.run('CREATE TABLE IF NOT EXISTS notes (body TEXT)');
		db.run('DELETE FROM notes');
		db.run('INSERT INTO notes (body) VALUES (?)', [value]);
		db.close();
	}

	test('creates a sealed bundle with the control DB, env/APP_KEY and a manifest', () => {
		const backups = join(root, 'bundles-1');
		const data = join(root, 'data-1');
		const etc = join(root, 'etc-1');
		mkdirSync(data, { recursive: true });
		mkdirSync(etc, { recursive: true });
		makeDb(join(data, 'yoal.db'), 'before');
		writeFileSync(join(etc, 'yoal.env'), 'BETTER_AUTH_SECRET=abc\n', { mode: 0o600 });
		writeFileSync(join(etc, 'master.key'), 'app-key\n', { mode: 0o400 });
		writeFileSync(join(data, 'platform-settings.json'), '{"smtp":true}\n', { mode: 0o600 });

		const bundle = createUpgradeSnapshotBundle({
			backupsDir: backups,
			dbPath: join(data, 'yoal.db'),
			dataDir: data,
			envDir: etc,
			fromVersion: '1.0.0',
			targetVersion: '1.1.0',
			migrations: ['0002_add.sql'],
			agentVersion: '0.2.0',
			desiredStateVersion: 42,
			now: Date.parse('2026-01-02T03:04:05Z')
		});

		expect(existsSync(bundle.controlDb!)).toBe(true);
		expect(statSync(bundle.dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(bundle.dir, 'db', 'control.db')).mode & 0o777).toBe(0o600);
		expect(statSync(join(bundle.dir, 'config', 'master.key')).mode & 0o777).toBe(0o400);
		const manifest = JSON.parse(readFileSync(join(bundle.dir, 'manifest.json'), 'utf8'));
		expect(manifest).toMatchObject({
			format: 1,
			kind: 'pre-update',
			fromVersion: '1.0.0',
			targetVersion: '1.1.0',
			pinned: true,
			sealed: 'root-only',
			controlDb: 'db/control.db',
			versions: { agent: '0.2.0', desiredState: 42 }
		});
		expect(manifest.files.some((file: { path: string }) => file.path === 'config/yoal.env')).toBe(true);

		const restored = new Database(bundle.controlDb!);
		expect(restored.query<{ body: string }, []>('SELECT body FROM notes').get()?.body).toBe('before');
		restored.close();
	});

	test('keeps the pinned pre-update bundle and the newest N unpinned bundles', () => {
		const backups = join(root, 'bundles-2');
		const dbPath = join(root, 'data-2', 'yoal.db');
		makeDb(dbPath, 'x');
		const now = Date.parse('2026-02-01T00:00:00Z');
		const pinned = createUpgradeSnapshotBundle({
			backupsDir: backups,
			dbPath,
			targetVersion: '1.1.0',
			pinned: true,
			retain: 20,
			now
		});
		for (let index = 0; index < 4; index++)
			createUpgradeSnapshotBundle({
				backupsDir: backups,
				dbPath,
				targetVersion: `1.${index + 2}.0`,
				pinned: false,
				retain: 20,
				now: now + (index + 1) * 1_000
			});
		expect(listUpgradeSnapshotBundles(backups)).toHaveLength(5);
		const removed = pruneUpgradeSnapshotBundles(backups, { keep: 2 });
		expect(removed).toHaveLength(2);
		const left = listUpgradeSnapshotBundles(backups);
		expect(left).toHaveLength(3);
		expect(left.some((bundle) => bundle.dir === pinned.dir)).toBe(true);
		expect(left.map((bundle) => bundle.manifest.pinned)).toEqual([false, false, true]);
	});

	test('a successful upgrade unpins the bundle for normal retention', () => {
		const backups = join(root, 'bundles-3');
		const dbPath = join(root, 'data-3', 'yoal.db');
		makeDb(dbPath, 'x');
		const bundle = createUpgradeSnapshotBundle({
			backupsDir: backups,
			dbPath,
			targetVersion: '2.0.0',
			pinned: true,
			retain: 10,
			now: Date.parse('2026-03-01T00:00:00Z')
		});
		markUpgradeSnapshotUnpinned(bundle.dir);
		const manifest = JSON.parse(readFileSync(join(bundle.dir, 'manifest.json'), 'utf8'));
		expect(manifest.pinned).toBe(false);
	});

	test('retiring pins after a success makes the last N the only retained bundles', () => {
		const backups = join(root, 'bundles-3b');
		const dbPath = join(root, 'data-3b', 'yoal.db');
		makeDb(dbPath, 'x');
		const failed = createUpgradeSnapshotBundle({
			backupsDir: backups,
			dbPath,
			targetVersion: '1.0.1',
			pinned: true,
			retain: 10,
			now: Date.parse('2026-03-01T00:00:00Z')
		});
		const success = createUpgradeSnapshotBundle({
			backupsDir: backups,
			dbPath,
			targetVersion: '1.1.0',
			pinned: true,
			retain: 10,
			now: Date.parse('2026-03-02T00:00:00Z')
		});
		const retired = retireUpgradeSnapshotBundles(backups, success.dir);
		expect(retired).toEqual([failed.dir]);
		expect(listUpgradeSnapshotBundles(backups).every((bundle) => !bundle.manifest.pinned)).toBe(true);
		pruneUpgradeSnapshotBundles(backups, { keep: 1 });
		expect(listUpgradeSnapshotBundles(backups).map((bundle) => bundle.dir)).toEqual([success.dir]);
	});

	test('rollback selection prefers the newest pinned bundle with a control DB', () => {
		const backups = join(root, 'bundles-4');
		const dbPath = join(root, 'data-4', 'yoal.db');
		makeDb(dbPath, 'x');
		const old = createUpgradeSnapshotBundle({
			backupsDir: backups,
			dbPath,
			targetVersion: '1.0.0',
			pinned: true,
			retain: 10,
			now: Date.parse('2026-04-01T00:00:00Z')
		});
		const recent = createUpgradeSnapshotBundle({
			backupsDir: backups,
			dbPath,
			targetVersion: '1.1.0',
			pinned: false,
			retain: 10,
			now: Date.parse('2026-04-02T00:00:00Z')
		});
		const bundles = listUpgradeSnapshotBundles(backups);
		expect(selectRollbackSnapshot(bundles)?.dir).toBe(old.dir);
		markUpgradeSnapshotUnpinned(old.dir);
		expect(selectRollbackSnapshot(listUpgradeSnapshotBundles(backups))?.dir).toBe(recent.dir);
	});
});

describe('readyz output', () => {
	const schema = { latest: '0017_scheduler.sql', expected: '0017_scheduler.sql', applied: 17, pending: [] };

	test('reports ok with versions, dirs, disk and backup target', () => {
		const report = buildReadyzReport({
			version: '1.4.0',
			schema,
			dbOk: true,
			dataDirs: dirs,
			disk: { path: dirs[0]!.path, freeBytes: 1_000, totalBytes: 10_000, requiredBytes: 500 },
			backupTarget: { kind: 'r2', reachable: true, checkedAt: '2026-01-01T00:00:00.000Z' },
			agent: { desiredVersion: '0.2.0', nodes: [{ id: 'nod_1', name: 'edge', version: '0.2.0' }] },
			helperVersion: '0.2.0',
			now: Date.parse('2026-01-01T00:00:00Z')
		});
		expect(report.ok).toBe(true);
		expect(report.status).toBe('ok');
		expect(report.version).toBe('1.4.0');
		expect(report.schema.latest).toBe('0017_scheduler.sql');
		expect(report.helper.version).toBe('0.2.0');
		expect(report.agent.nodes[0]).toEqual({ id: 'nod_1', name: 'edge', version: '0.2.0' });
		expect(JSON.stringify(report)).not.toContain('secret');
	});

	test('fails when migrations are pending', () => {
		const report = buildReadyzReport({
			version: '1.4.0',
			schema: { ...schema, pending: ['0018_new.sql'] },
			dbOk: true,
			dataDirs: dirs,
			disk: { path: dirs[0]!.path, freeBytes: 1_000, totalBytes: 10_000, requiredBytes: 500 },
			backupTarget: { kind: 'local', reachable: true },
			agent: { desiredVersion: null, nodes: [] }
		});
		expect(report.ok).toBe(false);
		expect(report.status).toBe('failed');
		expect(report.checks.find((check) => check.id === 'schema')?.status).toBe('error');
	});

	test('stays ready but degrades when the backup target is down', () => {
		const report = buildReadyzReport({
			version: '1.4.0',
			schema,
			dbOk: true,
			dataDirs: dirs,
			disk: { path: dirs[0]!.path, freeBytes: 100, totalBytes: 10_000, requiredBytes: 500 },
			backupTarget: { kind: 'r2', reachable: false, error: '403' },
			agent: { desiredVersion: null, nodes: [] }
		});
		expect(report.ok).toBe(true);
		expect(report.status).toBe('degraded');
		expect(report.warnings.join(' ')).toMatch(/backup target is unreachable/);
		expect(report.disk.headroom).toBe(false);
	});
});
