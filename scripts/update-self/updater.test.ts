import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
	CONTROL_PLANE,
	LITESTREAM,
	STANDBY,
	type Host,
	type HookOutcome,
	type Layout,
	type SocketTarget,
	type UpdateState,
	Updater,
	acquireLock,
	assembleRelease,
	layoutFromEnv,
	readLink,
	readMeta,
	setLink,
	unitReleasePaths,
	verifyRelease,
} from './updater.ts';
import { prepareScratch } from '../release/canary.ts';
import { sha256File, signManifest } from './signing.ts';

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

function makeRelease(name: string, commit: string, migrations = ['0001_init.sql'], version = '0.1.0'): string {
	const release = join(layout.releasesDir, name);
	writeRepo(join(release, 'repo'), migrations);
	assembleRelease(release, layout.bunBin);
	writeFileSync(join(release, 'meta.json'), JSON.stringify({ commit, version, ref: 'main', repo: 'owner/skiff' }));
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
	/** Contents of VERSION at the resolved commit. */
	version = '0.2.0\n';
	phases: string[] = [];
	/** Migrations shipped by the next fetched source. */
	migrations = ['0001_init.sql'];
	buildFails = false;
	canaryFails = false;
	/** Release basenames that never become healthy when running. */
	unhealthy = new Set<string>();
	readyzFails = false;
	backupUnreachable = false;
	/** Release basename -> true when it is the commit currently fetched. */
	running: string | null = null;
	publicUp = false;
	canaryDbSeen = false;
	/** Directories under the canary scratch dir that existed when it was chowned to skiff. */
	canaryChowned: string[] = [];
	critical = 0;
	clock = Date.parse('2026-11-03T12:00:00Z');

	log = (text: string) => void this.logs.push(text);
	warn = (text: string) => void this.logs.push(`WARN ${text}`);
	now = () => new Date((this.clock += 1000));
	sleep = async () => {};
	resolveCommit = async () => this.commit;
	readVersionFile = async () => this.version;
	phase = (phase: string) => void this.phases.push(phase);
	fetchSource = async (_repo: string, _commit: string, dest: string) => writeRepo(dest, this.migrations);
	build = async () => {
		this.calls.push('build');
		if (this.buildFails) throw new Error('bun install failed');
	};
	/** Release hooks: `verdict` (default), `error` (crash/timeout), or `absent` (pre-hook release). */
	hookMode: 'verdict' | 'error' | 'absent' = 'verdict';
	/** Reason the next failing canary reports (overridable to simulate updater-caused failures). */
	canaryReason = 'migration 0003 failed';
	/** The release-owned canary hook: the real prepareScratch, with chown recorded instead of run. */
	releaseHook = async (_release: string, hook: string, args: string[]): Promise<HookOutcome> => {
		if (this.hookMode === 'absent') return { kind: 'absent' };
		this.calls.push(`hook ${hook}`);
		if (this.hookMode === 'error') return { kind: 'error', reason: 'canary hook timed out after 240s' };
		const scratch = args[args.indexOf('--scratch') + 1]!;
		const dbPath = args[args.indexOf('--db') + 1]!;
		prepareScratch({ scratch, dbPath }, (cmd) => {
			if (cmd[0] === 'chown') this.chownToSkiff(cmd[cmd.length - 1]!);
			return { code: 0, stdout: '', stderr: '' };
		});
		this.canaryDbSeen = existsSync(join(scratch, 'data', 'skiff.db'));
		return this.canaryFails
			? { kind: 'verdict', verdict: { protocol: 1, ok: false, step: 'health', reason: this.canaryReason, detail: 'journal…' } }
			: { kind: 'verdict', verdict: { protocol: 1, ok: true, step: 'stability' } };
	};
	canary = async (_release: string, scratch: string) => {
		this.calls.push('canary');
		this.canaryDbSeen = existsSync(join(scratch, 'data', 'skiff.db'));
		if (this.canaryFails) throw new Error(`${this.canaryReason}\nstack…`);
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
	ensureHelper = (_release: string) => void this.calls.push('ensure-helper');
	/** Release basename whose Caddy upgrade fails (simulates a bad binary or a failed restart). */
	caddyFailsFor: string | null = null;
	ensureCaddy = (release: string) => {
		this.calls.push(`ensure-caddy ${basename(release)}`);
		if (this.caddyFailsFor === basename(release)) throw new Error('caddy did not restart');
		return true;
	};
	controlPlaneHealthy = async () =>
		Boolean(this.active.get(CONTROL_PLANE) && this.running && !this.unhealthy.has(this.running));
	readyz = async () => {
		const running = this.running;
		if (this.readyzFails && running?.includes(NEW.slice(0, 12))) return false;
		return Boolean(this.active.get(CONTROL_PLANE) && running && !this.unhealthy.has(running));
	};
	backupTarget = async () => ({ ok: !this.backupUnreachable, kind: 'local', ...(this.backupUnreachable ? { error: 'connection refused' } : {}) });
	publicHealthy = async () => this.publicUp;
	agentEnrolled = () => false;
	chownToSkiff = (path: string) => {
		if (!path.includes('update-canary')) return;
		for (const dir of ['data', join('data', 'objects')]) if (existsSync(join(path, dir))) this.canaryChowned.push(dir);
	};
	freeBytes = () => 100 * 1024 ** 3;
	listReleases?: Host['listReleases'];
	fetchBytes?: Host['fetchBytes'];
	download?: Host['download'];
	extract?: Host['extract'];
	sha256?: Host['sha256'];
	trustedKeys?: Host['trustedKeys'];
	platform?: Host['platform'];
	updaterIdentity?: Host['updaterIdentity'];
	qualifyUpdater?: Host['qualifyUpdater'];
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
		SKIFF_UPDATER_DIR: join(root, 'updater'),
	});
	mkdirSync(join(root, 'systemd'), { recursive: true });
	mkdirSync(join(root, 'var', 'data'), { recursive: true });
	mkdirSync(join(root, 'var', 'data', 'objects'), { recursive: true });
	mkdirSync(join(root, 'var', 'backups'), { recursive: true });
	mkdirSync(join(root, 'opt', 'runtime', 'bin'), { recursive: true });
	writeFileSync(layout.bunBin, '#!/bin/sh');
	writeFileSync(
		layout.controlPlaneUnitFile,
		`[Service]\nWorkingDirectory=${layout.optDir}/current/repo/apps/control-plane\nExecStart=${layout.optDir}/current/runtime/bun ${layout.optDir}/current/repo/apps/control-plane/build/index.js\n`,
	);
	host = new FakeHost();
	older = makeRelease('20260101000000-older', '9'.repeat(40), ['0001_init.sql'], '0.0.9');
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
	test('does nothing when VERSION on GitHub is not newer, even at a different commit', async () => {
		host.version = '0.1.0\n';
		const result = await new Updater(layout, host).update();
		expect(result).toMatchObject({ status: 'up-to-date', version: '0.1.0', fromVersion: '0.1.0' });
		expect(host.calls).toEqual([]);
	});

	test('never downgrades unless forced', async () => {
		host.version = '0.0.5';
		const updater = new Updater(layout, host);
		expect((await updater.update()).status).toBe('up-to-date');
		expect(host.calls).toEqual([]);
		const forced = await updater.update({ force: true });
		expect(forced).toMatchObject({ status: 'updated', version: '0.0.5', fromVersion: '0.1.0' });
	});

	test('compares by semver precedence, not string order', async () => {
		host.version = '0.10.0';
		writeFileSync(join(original, 'meta.json'), JSON.stringify({ commit: OLD, version: '0.9.0' }));
		expect((await new Updater(layout, host).update()).status).toBe('updated');
	});

	test('a prerelease of the running version is older; its release is newer', async () => {
		writeFileSync(join(original, 'meta.json'), JSON.stringify({ commit: OLD, version: '1.0.0-rc.2' }));
		host.version = '1.0.0-rc.1';
		expect((await new Updater(layout, host).update()).status).toBe('up-to-date');
		host.version = '1.0.0';
		expect((await new Updater(layout, host).update()).status).toBe('updated');
	});

	test('refuses a VERSION that is not semver', async () => {
		host.version = 'latest';
		await expect(new Updater(layout, host).update()).rejects.toThrow(/not a semantic version/);
		expect(host.calls).toEqual([]);
	});

	test('an unversioned current release is always updated', async () => {
		writeFileSync(join(original, 'meta.json'), JSON.stringify({ commit: OLD }));
		const result = await new Updater(layout, host).update();
		expect(result).toMatchObject({ status: 'updated', fromVersion: null, version: '0.2.0' });
	});

	test('check reports what update would do without touching anything', async () => {
		const updater = new Updater(layout, host);
		expect(await updater.check()).toMatchObject({
			repo: 'owner/skiff',
			ref: 'main',
			commit: NEW,
			version: '0.2.0',
			fromVersion: '0.1.0',
			available: true,
		});
		host.version = '0.1.0';
		expect((await updater.check()).available).toBe(false);
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
		// The canary runs as skiff: its writable dirs must exist before the recursive chown.
		expect(host.canaryChowned).toEqual(['data', join('data', 'objects')]);
		expect(host.running).toBe(basename(current));
		expect(host.calls).toContain(`ensure-caddy ${basename(current)}`);
		expect(JSON.parse(readFileSync(join(current, 'meta.json'), 'utf8'))).toMatchObject({
			commit: NEW,
			version: '0.2.0',
			status: 'active',
		});
		expect(result).toMatchObject({ version: '0.2.0', fromVersion: '0.1.0' });
		expect(host.phases).toEqual(['checking', 'checking', 'building', 'canary', 'swapping', 'verifying']);
		const last = state().lastSwitch!;
		expect(last).toMatchObject({ kind: 'update', from: original, to: current });
		expect(existsSync(last.snapshot!)).toBe(true);
		expect(host.critical).toBe(0);
	});

	test('a failed Caddy upgrade reverts the release and keeps the old one serving', async () => {
		host.caddyFailsFor = '20261103120001-aaaaaaaaaaaa';
		await expect(new Updater(layout, host).update()).rejects.toThrow(/caddy did not restart/);
		expect(readLink(layout.currentLink)).toBe(original);
		expect(host.running).toBe(basename(original));
	});

	test('a second update drops the oldest release and keeps the last N snapshots', async () => {
		const updater = new Updater(layout, host);
		await updater.update();
		const first = readLink(layout.currentLink)!;
		const firstSnapshot = state().lastSwitch!.snapshot!;
		host.commit = NEWER;
		host.version = '0.3.0';
		await updater.update();
		expect(readLink(layout.previousLink)).toBe(first);
		expect(existsSync(original)).toBe(false);
		// Pre-update bundles are retained (pinned until the next success, then the last N).
		expect(existsSync(firstSnapshot)).toBe(true);
		const bundles = readdirSync(layout.backupsDir).filter((entry) => entry.startsWith('upgrade-'));
		expect(bundles).toHaveLength(2);
		expect(bundles).toContain(basename(dirname(dirname(state().lastSwitch!.snapshot!))));
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

	test('a release whose /readyz never becomes ready is rolled back', async () => {
		host.readyzFails = true;
		const result = await new Updater(layout, host).update();
		expect(result).toMatchObject({ status: 'rolled-back', recovered: true });
		expect(result.status === 'rolled-back' ? result.reason : '').toMatch(/readyz/);
		expect(readLink(layout.currentLink)).toBe(original);
		expect(host.running).toBe(basename(original));
	});

	test('refuses to start when the backup target is unreachable', async () => {
		host.backupUnreachable = true;
		await expect(new Updater(layout, host).update()).rejects.toThrow(
			/backup target \(local\) is unreachable/
		);
		expect(host.calls).toEqual([]);
		expect(readLink(layout.currentLink)).toBe(original);
	});

	test('refuses a destructive migration before the canary or the swap', async () => {
		host.migrations = ['0001_init.sql', '0003_drop.sql'];
		// Make the fetched release ship a destructive migration body.
		const originalFetch = host.fetchSource;
		host.fetchSource = async (repo, commit, dest) => {
			await originalFetch(repo, commit, dest);
			mkdirSync(join(dest, 'packages', 'db', 'migrations'), { recursive: true });
			writeFileSync(join(dest, 'packages', 'db', 'migrations', '0003_drop.sql'), 'DROP TABLE notes;');
		};
		await expect(new Updater(layout, host).update()).rejects.toThrow(/Destructive migration 0003_drop\.sql/);
		expect(host.calls).not.toContain('canary');
		expect(readLink(layout.currentLink)).toBe(original);
		expect(readdirSync(layout.releasesDir).some((entry) => entry.startsWith('202611031200'))).toBe(false);
	});

	test('plan returns the same preflight rules without changing anything', async () => {
		const planned = await new Updater(layout, host).plan();
		expect(planned.check).toMatchObject({ version: '0.2.0', fromVersion: '0.1.0' });
		expect(planned.preflight.ok).toBe(true);
		expect(host.calls).toEqual([]);
	});

	test('an unhealthy release is rolled back with its database changes undone', async () => {
		host.migrations = ['0001_init.sql', '0003_new.sql'];
		host.unhealthy.add('20261103120001-aaaaaaaaaaaa');
		const result = await new Updater(layout, host).update();
		expect(result).toMatchObject({ status: 'rolled-back', recovered: true });
		expect(host.phases).toContain('rolling-back');
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
		expect(host.calls).toContain(`ensure-caddy ${basename(original)}`);
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
		const release = makeRelease('20261103000000-cccccccccccc', NEW, ['0001_init.sql', '0003_new.sql'], '0.2.0');
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

	test('assembleRelease ships the CLI bundle when the build produced one', () => {
		const release = join(root, 'cli-release');
		mkdirSync(join(release, 'repo', 'apps', 'cli', 'dist'), { recursive: true });
		writeFileSync(join(release, 'repo', 'apps', 'cli', 'dist', 'skif.js'), '// cli');
		assembleRelease(release, layout.bunBin);
		expect(readFileSync(join(release, 'cli', 'skif.js'), 'utf8')).toBe('// cli');

		const bare = join(root, 'bare-release');
		mkdirSync(join(bare, 'repo'), { recursive: true });
		assembleRelease(bare, layout.bunBin);
		expect(existsSync(join(bare, 'cli'))).toBe(false);
	});

	test('verifyRelease reports what the installed unit needs but the release lacks', () => {
		const release = makeRelease('x', NEW);
		rmSync(join(release, 'repo', 'apps', 'control-plane', 'build'), { recursive: true });
		expect(verifyRelease(release, layout)).toContain('repo/apps/control-plane/build/index.js');
	});

	test('verifyRelease requires the Caddy binary when the unit executes it', () => {
		writeFileSync(
			layout.caddyUnitFile,
			`[Service]\nExecStart=${layout.optDir}/current/caddy/caddy run --resume\n`
		);
		const release = makeRelease('caddy-required', NEW);
		expect(verifyRelease(release, layout)).toContain('caddy/caddy');
		mkdirSync(join(release, 'caddy'), { recursive: true });
		writeFileSync(join(release, 'caddy', 'caddy'), 'caddy');
		expect(verifyRelease(release, layout)).toEqual([]);
	});

	test('a source build carries the running Caddy into the new release', async () => {
		mkdirSync(join(original, 'caddy'), { recursive: true });
		writeFileSync(join(original, 'caddy', 'caddy'), 'running-caddy');
		writeFileSync(
			layout.caddyUnitFile,
			`[Service]\nExecStart=${layout.optDir}/current/caddy/caddy run --resume\n`
		);
		const result = await new Updater(layout, host).update();
		expect(result.status).toBe('updated');
		const current = readLink(layout.currentLink)!;
		expect(readFileSync(join(current, 'caddy', 'caddy'), 'utf8')).toBe('running-caddy');
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

// --------------------------------------------------------------- failure attribution

describe('failure attribution', () => {
	test('a hook that gives no verdict is inconclusive: recorded, never skipped', async () => {
		host.hookMode = 'error';
		const updater = new Updater(layout, host);
		const result = await updater.update();
		expect(result).toMatchObject({ status: 'canary-failed', cause: 'inconclusive' });
		expect(state().failedCommits[NEW]).toMatchObject({ cause: 'inconclusive', phase: 'canary' });
		host.hookMode = 'verdict';
		expect((await updater.update()).status).toBe('updated');
	});

	test('two different releases failing the same way blame neither (the updater is suspected)', async () => {
		host.canaryFails = true;
		host.canaryReason = '/readyz: Data directory /var/lib/skiff/update-canary/20261105090503-82c6b19c8fa7/data/objects is not writable.';
		const updater = new Updater(layout, host);
		expect((await updater.update()).status).toBe('canary-failed');
		expect(state().failedCommits[NEW]?.cause).toBe('release');

		host.commit = NEWER;
		host.version = '0.3.0';
		host.canaryReason = '/readyz: Data directory /var/lib/skiff/update-canary/20261105112639-381ee8171ec7/data/objects is not writable.';
		expect(await updater.update()).toMatchObject({ status: 'canary-failed', cause: 'suspect' });
		expect(state().failedCommits[NEW]?.cause).toBe('suspect');
		expect(state().failedCommits[NEWER]?.cause).toBe('suspect');
		expect(host.logs.some((line) => line.includes('points at the updater'))).toBe(true);

		// Once the cause is fixed, the newest release installs without --force.
		host.canaryFails = false;
		expect((await updater.update()).status).toBe('updated');
	});

	test('a verdict recorded by another updater build does not skip the release', async () => {
		writeFileSync(
			layout.stateFile,
			JSON.stringify({ failedCommits: { [NEW]: { at: 'then', release: 'x', reason: 'canary: the new release did not become healthy in isolation' } } }),
		);
		expect((await new Updater(layout, host).update()).status).toBe('updated');
	});

	test('releases without hooks fall back to the built-in canary', async () => {
		host.hookMode = 'absent';
		expect((await new Updater(layout, host).update()).status).toBe('updated');
		expect(host.calls).toContain('canary');
	});
});

// --------------------------------------------------------------- zero-downtime cutover

/** Adds the standby unit and control.sock to the fake host. */
class BlueGreenHost extends FakeHost {
	socket: 'primary' | 'standby' | 'legacy' = 'primary';
	standbyRunning: string | null = null;
	/** The new release answers on its own socket but fails while serving real traffic. */
	failsUnderTraffic = false;
	unitsEnsured = 0;
	socketMoves: string[] = [];

	override start = async (unit: string) => {
		this.calls.push(`start ${unit}`);
		this.active.set(unit, true);
		if (unit === CONTROL_PLANE) {
			const release = readLink(layout.currentLink)!;
			this.running = basename(release);
			applyMigrations(release);
		}
		if (unit === STANDBY) {
			const release = readLink(layout.standbyLink)!;
			this.standbyRunning = basename(release);
			applyMigrations(release);
		}
	};
	override stop = async (unit: string) => {
		this.calls.push(`stop ${unit}`);
		this.active.set(unit, false);
		if (unit === CONTROL_PLANE) this.running = null;
		if (unit === STANDBY) this.standbyRunning = null;
	};
	override restart = async (unit: string) => {
		await this.stop(unit);
		await this.start(unit);
	};
	private serving(target: 'primary' | 'standby'): boolean {
		const name = target === 'primary' ? this.running : this.standbyRunning;
		const unit = target === 'primary' ? CONTROL_PLANE : STANDBY;
		return Boolean(this.active.get(unit) && name && !this.unhealthy.has(name));
	}
	probe = async (target: SocketTarget) => {
		if (target === 'public') {
			if (this.socket === 'standby' && this.failsUnderTraffic) return { ok: false, reason: '/readyz answered 503' };
			return { ok: this.serving(this.socket === 'standby' ? 'standby' : 'primary'), reason: 'down' };
		}
		return { ok: this.serving(target), reason: 'down' };
	};
	pointControlSocket = (target: 'primary' | 'standby') => {
		this.socket = target;
		this.socketMoves.push(target);
	};
	controlSocketTarget = () => this.socket;
	ensureControlPlaneUnits = () => void this.unitsEnsured++;
	override controlPlaneHealthy = async () => (await this.probe('public')).ok;
	override readyz = async () => (await this.probe('public')).ok;
}

describe('zero-downtime cutover', () => {
	let bg: BlueGreenHost;
	beforeEach(() => {
		bg = new BlueGreenHost();
		bg.running = basename(original);
		host = bg;
	});

	test('overlap: the old release serves until the new one is proven, then the primary moves', async () => {
		const result = await new Updater(layout, bg).update();
		expect(result.status).toBe('updated');
		const current = readLink(layout.currentLink)!;
		expect(basename(current)).toBe('20261103120001-aaaaaaaaaaaa');
		// The primary was never stopped before traffic moved to the proven standby.
		const standbyStart = bg.calls.indexOf(`start ${STANDBY}`);
		const firstPrimaryStop = bg.calls.indexOf(`stop ${CONTROL_PLANE}`);
		expect(standbyStart).toBeGreaterThanOrEqual(0);
		expect(firstPrimaryStop).toBeGreaterThan(standbyStart);
		// Cutover, re-asserted while the primary restarts behind the standby, then back.
		expect(bg.socketMoves).toEqual(['standby', 'standby', 'primary']);
		expect(bg.socket).toBe('primary');
		expect(bg.active.get(STANDBY)).toBe(false);
		expect(bg.running).toBe(basename(current));
		expect(existsSync(layout.standbyLink)).toBe(false);
		expect(state().lastSwitch).toMatchObject({ mode: 'overlap', stage: 'commit', from: original, to: current });
		expect(bg.unitsEnsured).toBe(1);
		expect(bg.critical).toBe(0);
	});

	test('fenced: a release with migrations stops the old release before migrating', async () => {
		bg.migrations = ['0001_init.sql', '0003_new.sql'];
		const result = await new Updater(layout, bg).update();
		expect(result.status).toBe('updated');
		expect(bg.calls.indexOf(`stop ${CONTROL_PLANE}`)).toBeLessThan(bg.calls.indexOf(`start ${STANDBY}`));
		expect(state().lastSwitch?.mode).toBe('fenced');
		expect(migrationsInDb()).toEqual(['0001_init.sql', '0003_new.sql']);
	});

	test('a standby that never becomes healthy never receives traffic', async () => {
		bg.unhealthy.add('20261103120001-aaaaaaaaaaaa');
		const result = await new Updater(layout, bg).update();
		expect(result).toMatchObject({ status: 'rolled-back', recovered: true });
		expect(bg.socketMoves).toEqual([]);
		expect(bg.calls).not.toContain(`stop ${CONTROL_PLANE}`);
		expect(readLink(layout.currentLink)).toBe(original);
		expect(state().failedCommits[NEW]).toMatchObject({ cause: 'release', phase: 'standby' });
	});

	test('a bake failure is a code-only revert: traffic back on the untouched primary', async () => {
		bg.failsUnderTraffic = true;
		writeNote('during bake');
		const result = await new Updater(layout, bg).update();
		expect(result).toMatchObject({ status: 'rolled-back', recovered: true });
		expect(bg.socketMoves).toEqual(['standby', 'primary']);
		expect(bg.calls).not.toContain(`stop ${CONTROL_PLANE}`);
		expect(readLink(layout.currentLink)).toBe(original);
		expect(bg.running).toBe(basename(original));
		expect(bg.active.get(STANDBY)).toBe(false);
		// No snapshot restore: writes made while the new release served are kept.
		expect(notes()).toEqual(['before update', 'during bake']);
		expect(state().failedCommits[NEW]).toMatchObject({ cause: 'release', phase: 'bake' });
	});

	test('a fenced bake failure restores the pre-update database', async () => {
		bg.migrations = ['0001_init.sql', '0003_new.sql'];
		bg.failsUnderTraffic = true;
		const result = await new Updater(layout, bg).update();
		expect(result).toMatchObject({ status: 'rolled-back', recovered: true });
		expect(migrationsInDb()).toEqual(['0001_init.sql']);
		expect(bg.running).toBe(basename(original));
		expect(bg.socket as string).toBe('primary');
	});

	test('the first update from a legacy single socket restarts the primary onto its new socket', async () => {
		bg.socket = 'legacy';
		bg.failsUnderTraffic = true;
		// A legacy primary listens on the old path, so its own socket does not answer.
		const probe = bg.probe;
		let legacyPrimary = true;
		bg.probe = async (target) => (target === 'primary' && legacyPrimary ? { ok: false, reason: 'no socket' } : probe(target));
		const start = bg.start;
		bg.start = async (unit) => {
			if (unit === CONTROL_PLANE) legacyPrimary = false;
			await start(unit);
		};
		// A legacy primary unlinks control.sock (its own SOCKET_PATH) when it stops.
		const stop = bg.stop;
		bg.stop = async (unit) => {
			if (unit === CONTROL_PLANE && legacyPrimary) bg.socket = 'legacy';
			await stop(unit);
		};
		const result = await new Updater(layout, bg).update();
		expect(result).toMatchObject({ status: 'rolled-back', recovered: true });
		// While the legacy primary restarted, traffic stayed on the standby.
		expect(bg.socketMoves).toEqual(['standby', 'standby', 'primary']);
		expect(bg.socket as string).toBe('primary');
		expect(bg.running).toBe(basename(original));
	});

	test('the boot guard reverts an update that never committed', async () => {
		const release = makeRelease('20261103000000-dddddddddddd', NEW, ['0001_init.sql'], '0.2.0');
		setLink(layout.standbyLink, release);
		const sw = { kind: 'update', mode: 'overlap', stage: 'cutover', from: original, to: release, previousBefore: older, snapshot: null, commit: NEW, withAgent: false, at: 'then' };
		writeFileSync(layout.stateFile, JSON.stringify({ inProgress: sw, failedCommits: {} }));
		expect(await new Updater(layout, bg).bootRecover()).toBe('reverted');
		expect(readLink(layout.currentLink)).toBe(original);
		expect(existsSync(layout.standbyLink)).toBe(false);
		expect(state().inProgress).toBeUndefined();
		expect(state().failedCommits[NEW]?.cause).toBe('inconclusive');
		expect(bg.calls).toEqual([]);
	});
});

// --------------------------------------------------------------- signed artifacts

describe('signed release artifacts', () => {
	const keys = generateKeyPairSync('ed25519');
	const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	let bytes: Map<string, Uint8Array>;
	let artifactPath: string;

	function publish(input: { version?: string; signWith?: string; tamper?: boolean; updater?: boolean } = {}) {
		const version = input.version ?? '0.2.0';
		const build = join(root, `artifact-${version}`);
		writeRepo(join(build, 'repo'), ['0001_init.sql']);
		if (input.updater) {
			mkdirSync(join(build, 'updater'), { recursive: true });
			writeFileSync(join(build, 'updater', 'skiff-updated'), '#!/bin/sh\necho stage0');
		}
		artifactPath = join(root, `skiff-${version}-linux-amd64.tar.gz`);
		execFileSync('tar', ['-czf', artifactPath, '-C', build, '.']);
		const manifest = {
			schema: 1,
			version,
			commit: NEW,
			repo: 'owner/skiff',
			channel: 'stable',
			createdAt: '2026-11-05T00:00:00Z',
			updaterVersion: '2.0.0',
			minUpdater: '2.0.0',
			hookProtocol: 1,
			artifacts: {
				'linux-amd64': {
					file: basename(artifactPath),
					sha256: input.tamper ? '0'.repeat(64) : sha256File(artifactPath),
					size: readFileSync(artifactPath).length,
				},
			},
		};
		const body = new TextEncoder().encode(JSON.stringify(manifest));
		bytes = new Map([
			['https://dl/manifest.json', body],
			['https://dl/manifest.json.sig', new TextEncoder().encode(signManifest(body, input.signWith ?? pem))],
		]);
		host.listReleases = async () => [
			{ tag: 'cli-v9.9.9', draft: false, prerelease: false, assets: [] },
			{
				tag: `v${version}`,
				draft: false,
				prerelease: false,
				assets: [
					{ name: 'manifest.json', url: 'https://dl/manifest.json', size: body.length },
					{ name: 'manifest.json.sig', url: 'https://dl/manifest.json.sig', size: 88 },
					{ name: basename(artifactPath), url: 'https://dl/artifact', size: 1 },
				],
			},
		];
	}

	beforeEach(() => {
		host.fetchBytes = async (url) => bytes.get(url)!;
		host.download = async (_url, path) => void writeFileSync(path, readFileSync(artifactPath));
		host.extract = async (archive, dest) => void execFileSync('tar', ['-xzf', archive, '-C', dest]);
		host.sha256 = sha256File;
		host.trustedKeys = () => new Map([['test', createPublicKey(keys.publicKey.export({ type: 'spki', format: 'pem' }))]]);
		host.platform = () => 'linux-amd64';
	});

	test('installs the newest signed release without building on the host', async () => {
		publish();
		const result = await new Updater(layout, host).update();
		expect(result).toMatchObject({ status: 'updated', version: '0.2.0' });
		expect(host.calls).not.toContain('build');
		expect(readMeta(readLink(layout.currentLink)!)).toMatchObject({ source: 'artifact', ref: 'v0.2.0', commit: NEW, status: 'active' });
	});

	test('a manifest signed by an untrusted key is refused and not held against the release', async () => {
		publish({ signWith: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
		await expect(new Updater(layout, host).update()).rejects.toThrow(/not trusted/);
		expect(readLink(layout.currentLink)).toBe(original);
		expect(existsSync(layout.stateFile)).toBe(false);
	});

	test('an artifact that does not match its signed checksum is never unpacked', async () => {
		publish({ tamper: true });
		const result = await new Updater(layout, host).update();
		expect(result.status).toBe('build-failed');
		expect(result.status === 'build-failed' ? result.reason : '').toMatch(/signed checksum/);
		expect(readdirSync(layout.releasesDir).sort()).toEqual([basename(older), basename(original)].sort());
		expect(existsSync(layout.stateFile)).toBe(false);
	});

	test('source: artifact refuses to build when nothing is published', async () => {
		host.listReleases = async () => [];
		await expect(new Updater(layout, host).update({ source: 'artifact' })).rejects.toThrow(/refusing to build/);
		expect(host.calls).toEqual([]);
	});

	test('a qualified stage-0 from the release becomes the active updater; an unqualified one does not', async () => {
		publish({ updater: true });
		host.updaterIdentity = async () => '2.1.0+abc123';
		host.qualifyUpdater = async () => ({ ok: false, reason: 'no release-signing keys' });
		const updater = new Updater(layout, host);
		expect((await updater.update()).status).toBe('updated');
		expect(existsSync(join(layout.updaterDir, 'current'))).toBe(false);
		expect(host.logs.some((line) => line.includes('failed its self-test'))).toBe(true);

		publish({ updater: true, version: '0.3.0' });
		host.commit = NEWER;
		host.qualifyUpdater = async () => ({ ok: true });
		expect((await updater.update()).status).toBe('updated');
		expect(basename(readLink(join(layout.updaterDir, 'current'))!)).toBe('2.1.0+abc123');
	});
});
