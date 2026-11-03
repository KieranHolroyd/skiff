import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
	CONTROL_PLANE,
	LITESTREAM,
	type Host,
	type Layout,
	type UpdateState,
	Updater,
	acquireLock,
	assembleRelease,
	layoutFromEnv,
	readLink,
	setLink,
	unitReleasePaths,
	verifyRelease,
} from './updater.ts';

const OLD = '0'.repeat(40);
const NEW = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

let root: string;
let layout: Layout;
let host: FakeHost;

/** Writes a release tree the way fetchSource + build would. */
function writeRepo(repoDir: string, migrations: string[]): void {
	mkdirSync(join(repoDir, 'apps', 'control-plane', 'build'), { recursive: true });
	mkdirSync(join(repoDir, 'apps', 'agent', 'dist'), { recursive: true });
	mkdirSync(join(repoDir, 'packages', 'db', 'migrations'), { recursive: true });
	writeFileSync(join(repoDir, 'apps', 'control-plane', 'package.json'), '{"version":"0.2.0"}');
	writeFileSync(join(repoDir, 'apps', 'control-plane', 'build', 'index.js'), '// app');
	writeFileSync(join(repoDir, 'apps', 'agent', 'dist', 'skiff-agent'), '#!/bin/sh');
	for (const id of migrations)
		writeFileSync(join(repoDir, 'packages', 'db', 'migrations', id), `CREATE TABLE IF NOT EXISTS t_${id.split('_')[0]} (x);`);
}

function makeRelease(name: string, commit: string, migrations = ['0001_init.sql']): string {
	const release = join(layout.releasesDir, name);
	writeRepo(join(release, 'repo'), migrations);
	assembleRelease(release, layout.bunBin);
	writeFileSync(join(release, 'meta.json'), JSON.stringify({ commit, ref: 'main', repo: 'owner/skiff' }));
	return release;
}

/** What the control plane does on boot: apply the migrations its release ships. */
function applyMigrations(release: string): void {
	const db = new Database(layout.dbPath);
	db.run('CREATE TABLE IF NOT EXISTS skiff_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
	for (const id of readdirSync(join(release, 'repo', 'packages', 'db', 'migrations')))
		db.run('INSERT OR IGNORE INTO skiff_migrations VALUES (?, ?)', [id, Date.now()]);
	db.close();
}

function migrationsInDb(): string[] {
	const db = new Database(layout.dbPath, { readonly: true });
	const rows = db.query<{ id: string }, []>('SELECT id FROM skiff_migrations ORDER BY id').all();
	db.close();
	return rows.map((row) => row.id);
}

function notes(): string[] {
	const db = new Database(layout.dbPath, { readonly: true });
	const rows = db.query<{ body: string }, []>('SELECT body FROM notes ORDER BY rowid').all();
	db.close();
	return rows.map((row) => row.body);
}

function writeNote(body: string): void {
	const db = new Database(layout.dbPath);
	db.run('INSERT INTO notes (body) VALUES (?)', [body]);
	db.close();
}

function state(): UpdateState {
	return JSON.parse(readFileSync(layout.stateFile, 'utf8'));
}

class FakeHost implements Host {
	logs: string[] = [];
	calls: string[] = [];
	active = new Map<string, boolean>([
		[CONTROL_PLANE, true],
		[LITESTREAM, true],
	]);
	commit = NEW;
	/** Migrations shipped by the next fetched source. */
	migrations = ['0001_init.sql'];
	buildFails = false;
	canaryFails = false;
	/** Release basenames that never become healthy when running. */
	unhealthy = new Set<string>();
	/** Release basename -> true when it is the commit currently fetched. */
	running: string | null = null;
	publicUp = false;
	canaryDbSeen = false;
	critical = 0;
	clock = Date.parse('2026-11-03T12:00:00Z');

	log = (text: string) => void this.logs.push(text);
	warn = (text: string) => void this.logs.push(`WARN ${text}`);
	now = () => new Date((this.clock += 1000));
	sleep = async () => {};
	resolveCommit = async () => this.commit;
	fetchSource = async (_repo: string, _commit: string, dest: string) => writeRepo(dest, this.migrations);
	build = async () => {
		this.calls.push('build');
		if (this.buildFails) throw new Error('bun install failed');
	};
	canary = async (_release: string, scratch: string) => {
		this.calls.push('canary');
		this.canaryDbSeen = existsSync(join(scratch, 'data', 'skiff.db'));
		if (this.canaryFails) throw new Error('migration 0003 failed\nstack…');
	};
	start = async (unit: string) => {
		this.calls.push(`start ${unit}`);
		this.active.set(unit, true);
		if (unit === CONTROL_PLANE) {
			const release = readLink(layout.currentLink)!;
			this.running = basename(release);
			applyMigrations(release);
		}
	};
	stop = async (unit: string) => {
		this.calls.push(`stop ${unit}`);
		this.active.set(unit, false);
		if (unit === CONTROL_PLANE) this.running = null;
	};
	restart = async (unit: string) => {
		await this.stop(unit);
		await this.start(unit);
	};
	isActive = async (unit: string) => this.active.get(unit) ?? false;
	restartCount = async () => 0;
	controlPlaneHealthy = async () =>
		Boolean(this.active.get(CONTROL_PLANE) && this.running && !this.unhealthy.has(this.running));
	publicHealthy = async () => this.publicUp;
	agentEnrolled = () => false;
	chownToSkiff = () => {};
	freeBytes = () => 100 * 1024 ** 3;
	enterCritical = () => void this.critical++;
	leaveCritical = () => void this.critical--;
}

let original: string;
let older: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), 'skiff-update-')));
	layout = layoutFromEnv({
		SKIFF_OPT_DIR: join(root, 'opt'),
		SKIFF_VAR_DIR: join(root, 'var'),
		SKIFF_SYSTEMD_DIR: join(root, 'systemd'),
		SKIFF_BUN_BIN: join(root, 'opt', 'runtime', 'bin', 'bun'),
	});
	mkdirSync(join(root, 'systemd'), { recursive: true });
	mkdirSync(join(root, 'var', 'data'), { recursive: true });
	mkdirSync(join(root, 'opt', 'runtime', 'bin'), { recursive: true });
	writeFileSync(layout.bunBin, '#!/bin/sh');
	writeFileSync(
		layout.controlPlaneUnitFile,
		`[Service]\nWorkingDirectory=${layout.optDir}/current/repo/apps/control-plane\nExecStart=${layout.optDir}/current/runtime/bun ${layout.optDir}/current/repo/apps/control-plane/build/index.js\n`,
	);
	host = new FakeHost();
	older = makeRelease('20260101000000-older', '9'.repeat(40));
	original = makeRelease('v0.1.0-20261001000000', OLD);
	setLink(layout.previousLink, older);
	setLink(layout.currentLink, original);
	const db = new Database(layout.dbPath);
	db.run('CREATE TABLE notes (body TEXT)');
	db.close();
	applyMigrations(original);
	writeNote('before update');
	host.running = basename(original);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('update', () => {
	test('does nothing when the current release is already at the latest commit', async () => {
		host.commit = OLD;
		const result = await new Updater(layout, host).update();
		expect(result.status).toBe('up-to-date');
		expect(host.calls).toEqual([]);
	});

	test('swaps in the new release, keeps the old one as previous, prunes the rest', async () => {
		const result = await new Updater(layout, host).update();
		expect(result.status).toBe('updated');
		const current = readLink(layout.currentLink)!;
		expect(basename(current)).toBe('20261103120001-aaaaaaaaaaaa');
		expect(readLink(layout.previousLink)).toBe(original);
		expect(readdirSync(layout.releasesDir).sort()).toEqual([basename(current), basename(original)].sort());
		expect(host.canaryDbSeen).toBe(true);
		expect(host.running).toBe(basename(current));
		expect(JSON.parse(readFileSync(join(current, 'meta.json'), 'utf8'))).toMatchObject({ commit: NEW, status: 'active' });
		const last = state().lastSwitch!;
		expect(last).toMatchObject({ kind: 'update', from: original, to: current });
		expect(existsSync(last.snapshot!)).toBe(true);
		expect(host.critical).toBe(0);
	});

	test('a second update drops the oldest release and its snapshot', async () => {
		const updater = new Updater(layout, host);
		await updater.update();
		const first = readLink(layout.currentLink)!;
		const firstSnapshot = state().lastSwitch!.snapshot!;
		host.commit = NEWER;
		await updater.update();
		expect(readLink(layout.previousLink)).toBe(first);
		expect(existsSync(original)).toBe(false);
		expect(existsSync(firstSnapshot)).toBe(false);
		expect(readdirSync(layout.backupsDir)).toEqual([basename(state().lastSwitch!.snapshot!)]);
	});

	test('a build failure never touches the running release', async () => {
		host.buildFails = true;
		const result = await new Updater(layout, host).update();
		expect(result.status).toBe('build-failed');
		expect(host.calls).toEqual(['build']);
		expect(readLink(layout.currentLink)).toBe(original);
		expect(readLink(layout.previousLink)).toBe(older);
		expect(readdirSync(layout.releasesDir).some((e) => e.startsWith('.staging-'))).toBe(false);
		// Transient (network, disk) failures are not remembered.
		expect(existsSync(layout.stateFile)).toBe(false);
	});

	test('a canary failure discards the release and remembers the commit', async () => {
		host.canaryFails = true;
		const updater = new Updater(layout, host);
		const result = await updater.update();
		expect(result.status).toBe('canary-failed');
		expect(host.calls).not.toContain(`stop ${CONTROL_PLANE}`);
		expect(readLink(layout.currentLink)).toBe(original);
		expect(readdirSync(layout.releasesDir).sort()).toEqual([basename(older), basename(original)].sort());
		expect(state().failedCommits[NEW]?.reason).toBe('canary: migration 0003 failed');

		expect((await updater.update()).status).toBe('skipped');
		host.canaryFails = false;
		expect((await updater.update({ force: true })).status).toBe('updated');
	});

	test('an unhealthy release is rolled back with its database changes undone', async () => {
		host.migrations = ['0001_init.sql', '0003_new.sql'];
		host.unhealthy.add('20261103120001-aaaaaaaaaaaa');
		const result = await new Updater(layout, host).update();
		expect(result).toMatchObject({ status: 'rolled-back', recovered: true });
		expect(readLink(layout.currentLink)).toBe(original);
		expect(readLink(layout.previousLink)).toBe(older);
		expect(host.running).toBe(basename(original));
		// The new release applied 0003 on boot; the snapshot restore removed it again.
		expect(migrationsInDb()).toEqual(['0001_init.sql']);
		expect(notes()).toEqual(['before update']);
		expect(host.calls).toContain(`stop ${LITESTREAM}`);
		expect(host.active.get(LITESTREAM)).toBe(true);
		expect(existsSync(join(layout.releasesDir, '20261103120001-aaaaaaaaaaaa'))).toBe(false);
		expect(state().failedCommits[NEW]).toBeDefined();
		expect(state().inProgress).toBeUndefined();
	});

	test('the public URL gates the swap only if it was healthy before', async () => {
		host.publicUp = true;
		const publicHealthy = host.publicHealthy;
		let calls = 0;
		host.publicHealthy = async () => (calls++ === 0 ? publicHealthy() : false);
		const result = await new Updater(layout, host).update();
		expect(result).toMatchObject({ status: 'rolled-back', reason: 'public platform URL stopped answering' });
		expect(readLink(layout.currentLink)).toBe(original);
	});

	test('dry run changes nothing', async () => {
		const result = await new Updater(layout, host).update({ dryRun: true });
		expect(result.status).toBe('dry-run');
		expect(host.calls).toEqual([]);
		expect(readdirSync(layout.releasesDir).length).toBe(2);
	});
});

describe('rollback', () => {
	test('swaps current and previous; running it again swaps back', async () => {
		const updater = new Updater(layout, host);
		await updater.update();
		const updated = readLink(layout.currentLink)!;
		expect((await updater.rollback()).status).toBe('rolled-back');
		expect(readLink(layout.currentLink)).toBe(original);
		expect(readLink(layout.previousLink)).toBe(updated);
		expect(host.running).toBe(basename(original));
		expect((await updater.rollback()).status).toBe('rolled-back');
		expect(readLink(layout.currentLink)).toBe(updated);
		expect(readLink(layout.previousLink)).toBe(original);
	});

	test('refuses when the schema moved on, unless told how to handle the database', async () => {
		host.migrations = ['0001_init.sql', '0003_new.sql'];
		const updater = new Updater(layout, host);
		await updater.update();
		const updated = readLink(layout.currentLink)!;
		writeNote('after update');

		await expect(updater.rollback()).rejects.toThrow(/0003_new\.sql/);
		expect(readLink(layout.currentLink)).toBe(updated);

		const result = await updater.rollback({ restoreDb: true });
		expect(result).toMatchObject({ status: 'rolled-back', restoredDb: true });
		expect(migrationsInDb()).toEqual(['0001_init.sql']);
		expect(notes()).toEqual(['before update']);

		// The rollback itself is reversible, including the database it replaced.
		await updater.rollback({ restoreDb: true });
		expect(readLink(layout.currentLink)).toBe(updated);
		expect(migrationsInDb()).toEqual(['0001_init.sql', '0003_new.sql']);
		expect(notes()).toEqual(['before update', 'after update']);
	});

	test('--keep-db runs the old code against the newer schema', async () => {
		host.migrations = ['0001_init.sql', '0003_new.sql'];
		const updater = new Updater(layout, host);
		await updater.update();
		const result = await updater.rollback({ keepDb: true });
		expect(result).toMatchObject({ status: 'rolled-back', restoredDb: false });
		expect(migrationsInDb()).toEqual(['0001_init.sql', '0003_new.sql']);
	});

	test('stays on the current release if the previous one is unhealthy', async () => {
		const updater = new Updater(layout, host);
		await updater.update();
		const updated = readLink(layout.currentLink)!;
		host.unhealthy.add(basename(original));
		const result = await updater.rollback();
		expect(result).toMatchObject({ status: 'reverted', recovered: true });
		expect(readLink(layout.currentLink)).toBe(updated);
		expect(readLink(layout.previousLink)).toBe(original);
		expect(host.running).toBe(basename(updated));
	});
});

describe('interrupted switches', () => {
	function interruptAfterSwap(): string {
		const release = makeRelease('20261103000000-cccccccccccc', NEW, ['0001_init.sql', '0003_new.sql']);
		mkdirSync(layout.backupsDir, { recursive: true });
		const snapshot = join(layout.backupsDir, 'pre-update-x.db');
		writeFileSync(snapshot, readFileSync(layout.dbPath));
		const sw = { kind: 'update', from: original, to: release, previousBefore: older, snapshot, commit: NEW, withAgent: false, at: 'then' };
		writeFileSync(layout.stateFile, JSON.stringify({ inProgress: sw, failedCommits: {} }));
		setLink(layout.previousLink, original);
		setLink(layout.currentLink, release);
		host.active.set(CONTROL_PLANE, false);
		host.running = null;
		return release;
	}

	test('keeps the new release if it turns out healthy', async () => {
		const release = interruptAfterSwap();
		host.commit = NEW;
		const result = await new Updater(layout, host).update();
		expect(result.status).toBe('up-to-date');
		expect(readLink(layout.currentLink)).toBe(release);
		expect(state().inProgress).toBeUndefined();
		expect(state().lastSwitch?.to).toBe(release);
	});

	test('reverts if the new release is unhealthy', async () => {
		const release = interruptAfterSwap();
		host.unhealthy.add(basename(release));
		host.commit = NEW;
		const result = await new Updater(layout, host).update();
		expect(result.status).toBe('skipped');
		expect(readLink(layout.currentLink)).toBe(original);
		expect(readLink(layout.previousLink)).toBe(older);
		expect(migrationsInDb()).toEqual(['0001_init.sql']);
	});
});

describe('helpers', () => {
	test('unitReleasePaths picks paths below current/ from ExecStart and WorkingDirectory', () => {
		const unit = '[Service]\nWorkingDirectory=/opt/skiff/current/repo/apps/control-plane\nExecStart=-/opt/skiff/current/runtime/bun /opt/skiff/current/repo/apps/control-plane/build/index.js --flag\nExecStartPost=/usr/bin/chmod 0660 /run/x\n';
		expect(unitReleasePaths(unit, '/opt/skiff').sort()).toEqual(
			['repo/apps/control-plane', 'repo/apps/control-plane/build/index.js', 'runtime/bun'].sort(),
		);
	});

	test('verifyRelease reports what the installed unit needs but the release lacks', () => {
		const release = makeRelease('x', NEW);
		rmSync(join(release, 'repo', 'apps', 'control-plane', 'build'), { recursive: true });
		expect(verifyRelease(release, layout)).toContain('repo/apps/control-plane/build/index.js');
	});

	test('the lock is exclusive while its owner lives and taken over after it dies', () => {
		const lock = join(root, 'lock');
		writeFileSync(lock, String(process.ppid));
		expect(() => acquireLock(lock)).toThrow(/Another update is running/);
		writeFileSync(lock, '2147483646');
		const release = acquireLock(lock);
		expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
		release();
		expect(existsSync(lock)).toBe(false);
	});
});
