import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../packages/db/src/index.ts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '../packages/core/src/index.ts';
import { fakeCredsBinary } from './install/fake-systemd-creds.ts';
import { defaultCredsRunner, generateMasterKey, sealMasterKey, unsealMasterKey, writePlainMasterKey } from './install/master-key.ts';
import { keyBytes, main, rewrapDatabase, rotateMasterKey, RotationError, verifyDatabase, type RotateHost } from './rotate-master-key.ts';
import { PRIMARY_UNIT, STANDBY_UNIT } from './systemd/control-plane.ts';
import { TRIGGER_SERVICE_UNIT } from './update-self/units.ts';

const root = mkdtempSync(join(tmpdir(), 'skiff-rotate-'));
let counter = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const WEBHOOK_SECRET = 'webhook-secret-0123456789';
const PUSH = JSON.stringify({ ref: 'refs/heads/main', after: 'abc123', head_commit: { message: 'push' } });

function openCore(dataDir: string, dbPath: string, key: string): { core: Core; close: () => void } {
	const opened = createDb({ path: dbPath });
	const core = createCore({
		db: opened.db,
		sqlite: opened.sqlite,
		version: '0.1.0',
		config: {
			dataDir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dataDir, 'objects'), 'https://control.test', 'object-secret-123'),
			masterKey: keyBytes(key),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
		},
	});
	return { core, close: () => opened.sqlite.close() };
}

/**
 * A control-plane host: /etc/skiff + /var/lib/skiff/data/skiff.db with two org data keys (one
 * from a secret, one from a sealed database credential) and one GitHub webhook secret.
 */
async function seededHost(options: { sealed?: boolean } = {}) {
	const dir = join(root, `host-${++counter}`);
	const etc = join(dir, 'etc');
	const dataDir = join(dir, 'var', 'data');
	mkdirSync(etc, { recursive: true });
	const dbPath = join(dataDir, 'skiff.db');
	const plainPath = join(etc, 'master.key');
	const credsBin = fakeCredsBinary(dir);
	const key = generateMasterKey();
	if (options.sealed) sealMasterKey(key, `${plainPath}.cred`, { tpm2: false, bin: credsBin });
	else writePlainMasterKey(plainPath, key);

	const { core, close } = openCore(dataDir, dbPath, key);
	await core.secrets.set(owner, { name: 'API_KEY', value: 'org-1-secret' });
	const sealedCredential = core.secrets.seal('org_2', 'db-password');
	await core.projects.create(owner, { name: 'app', slug: 'app', runtime: 'static', placement: 'edge', productionAccess: 'public', previewAccess: 'platform' });
	core.builds.upsertGitSource(owner, core.projects.requireRow(owner, 'app'), {
		repoUrl: 'https://github.com/acme/app.git',
		branch: 'main',
		rootDir: '.',
		buildCommand: 'bun run build',
		outputDir: 'dist',
		webhookSecret: WEBHOOK_SECRET,
		enabled: true,
	});
	close();
	return {
		dir,
		dbPath,
		plainPath,
		sealedPath: `${plainPath}.cred`,
		backupsDir: join(dir, 'var', 'backups'),
		credsBin,
		key,
		/** Everything the master key protects opens with `key`, through the real services. */
		async opensWith(candidate: string): Promise<boolean> {
			const { core, close } = openCore(dataDir, dbPath, candidate);
			try {
				if (core.secrets.getValue('org_1', 'API_KEY')?.value !== 'org-1-secret') return false;
				if (core.secrets.open('org_2', sealedCredential) !== 'db-password') return false;
				const signature = `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(PUSH).digest('hex')}`;
				const build = await core.builds.handleGithubWebhook(core.projects.requireRow(owner, 'app'), PUSH, signature, 'push');
				return build !== null;
			} catch {
				return false;
			} finally {
				close();
			}
		},
		wrapped(): string[] {
			const db = new Database(dbPath);
			try {
				return [
					...db.query<{ v: string }, []>('SELECT wrapped_key AS v FROM org_keys ORDER BY org_id').all(),
					...db.query<{ v: string }, []>('SELECT webhook_secret AS v FROM git_sources ORDER BY id').all(),
				].map((row) => row.v);
			} finally {
				db.close();
			}
		},
		leftovers(): string[] {
			return readdirSync(etc).filter((name) => /\.(new|old)$|\.tmp-/.test(name));
		},
	};
}

function fakeHost(options: { healthy?: boolean; active?: string[]; confirm?: boolean } = {}) {
	const active = new Set(options.active ?? [PRIMARY_UNIT]);
	const events: string[] = [];
	const host: RotateHost = {
		log: () => {},
		isActive: (unit) => active.has(unit),
		stop: (unit) => {
			active.delete(unit);
			events.push(`stop ${unit}`);
		},
		start: (unit) => {
			active.add(unit);
			events.push(`start ${unit}`);
		},
		healthy: () => options.healthy ?? true,
		confirm: async () => {
			events.push('confirm');
			return options.confirm ?? true;
		},
	};
	return { host, events, active };
}

describe('rotateMasterKey', () => {
	test('plaintext store: the new key opens everything, the old one nothing', async () => {
		const h = await seededHost();
		const { host, events } = fakeHost({ active: [PRIMARY_UNIT, STANDBY_UNIT] });
		const result = await rotateMasterKey({ plainPath: h.plainPath, dbPath: h.dbPath, backupsDir: h.backupsDir }, host);
		expect(result).toMatchObject({ status: 'rotated', store: { kind: 'plain', path: h.plainPath }, counts: { orgKeys: 2, webhookSecrets: 1 }, resumed: false });

		const newKey = readFileSync(h.plainPath, 'utf8').trim();
		expect(newKey).not.toBe(h.key);
		expect(statSync(h.plainPath).mode & 0o777).toBe(0o400);
		expect(await h.opensWith(newKey)).toBe(true);
		expect(await h.opensWith(h.key)).toBe(false);
		expect(h.leftovers()).toEqual([]);

		// Both slots stop before the re-wrap; only the primary comes back.
		expect(events).toEqual(['confirm', `stop ${PRIMARY_UNIT}`, `stop ${STANDBY_UNIT}`, `start ${PRIMARY_UNIT}`]);

		// The snapshot is the pre-rotation database, still on the old key.
		expect(result.snapshot).toStartWith(join(h.backupsDir, 'pre-key-rotation-'));
		expect(statSync(result.snapshot!).mode & 0o777).toBe(0o600);
		const snapshot = new Database(result.snapshot!);
		expect(verifyDatabase(snapshot, keyBytes(h.key))).toEqual({ orgKeys: 2, webhookSecrets: 1 });
		snapshot.close();
	});

	test('sealed store: the new key is sealed with systemd-creds and no plaintext is written', async () => {
		const h = await seededHost({ sealed: true });
		const { host } = fakeHost();
		const result = await rotateMasterKey({ plainPath: h.plainPath, dbPath: h.dbPath, backupsDir: h.backupsDir, yes: true, credsBin: h.credsBin }, host);
		expect(result.store).toEqual({ kind: 'sealed', path: h.sealedPath });
		expect(readFileSync(h.sealedPath, 'utf8')).toStartWith('FAKECRED name=master-key');
		const newKey = unsealMasterKey(h.sealedPath, defaultCredsRunner, h.credsBin);
		expect(newKey).not.toBe(h.key);
		expect(await h.opensWith(newKey)).toBe(true);
		expect(await h.opensWith(h.key)).toBe(false);
		expect(existsSync(h.plainPath)).toBe(false);
		expect(h.leftovers()).toEqual([]);
	});

	test('a control plane that does not come back rolls the database and the key back', async () => {
		const h = await seededHost();
		const before = h.wrapped();
		const { host, events, active } = fakeHost({ healthy: false });
		await expect(rotateMasterKey({ plainPath: h.plainPath, dbPath: h.dbPath, backupsDir: h.backupsDir, yes: true }, host)).rejects.toThrow(
			'rolled back, the old key is in use again',
		);
		expect(readFileSync(h.plainPath, 'utf8').trim()).toBe(h.key);
		expect(await h.opensWith(h.key)).toBe(true);
		expect(h.wrapped()).not.toEqual(before); // re-wrapped back, with fresh nonces
		expect(h.leftovers()).toEqual([]);
		expect(active.has(PRIMARY_UNIT)).toBe(true);
		expect(events.at(-1)).toBe(`start ${PRIMARY_UNIT}`);
	});

	test('resumes a rotation that committed the database but crashed before the switch', async () => {
		const h = await seededHost();
		const newKey = generateMasterKey();
		writePlainMasterKey(`${h.plainPath}.new`, newKey);
		const db = new Database(h.dbPath);
		rewrapDatabase(db, keyBytes(h.key), keyBytes(newKey));
		db.close();

		const { host, events } = fakeHost();
		const result = await rotateMasterKey({ plainPath: h.plainPath, dbPath: h.dbPath, backupsDir: h.backupsDir }, host);
		expect(result).toMatchObject({ status: 'rotated', resumed: true, snapshot: null });
		expect(events[0]).toBe(`stop ${PRIMARY_UNIT}`); // no confirmation needed to finish
		expect(readFileSync(h.plainPath, 'utf8').trim()).toBe(newKey);
		expect(await h.opensWith(newKey)).toBe(true);
		expect(h.leftovers()).toEqual([]);
	});

	test('discards a staged key from a run that never committed, then rotates', async () => {
		const h = await seededHost();
		const stale = generateMasterKey();
		writePlainMasterKey(`${h.plainPath}.new`, stale);
		writePlainMasterKey(`${h.plainPath}.old`, generateMasterKey());
		const result = await rotateMasterKey({ plainPath: h.plainPath, dbPath: h.dbPath, backupsDir: h.backupsDir, yes: true }, fakeHost().host);
		expect(result).toMatchObject({ status: 'rotated', resumed: false });
		const newKey = readFileSync(h.plainPath, 'utf8').trim();
		expect([h.key, stale]).not.toContain(newKey);
		expect(await h.opensWith(newKey)).toBe(true);
		expect(h.leftovers()).toEqual([]);
	});

	test('dry run checks the key and changes nothing', async () => {
		const h = await seededHost();
		const before = h.wrapped();
		const { host, events } = fakeHost();
		const result = await rotateMasterKey({ plainPath: h.plainPath, dbPath: h.dbPath, backupsDir: h.backupsDir, dryRun: true }, host);
		expect(result).toMatchObject({ status: 'dry-run', counts: { orgKeys: 2, webhookSecrets: 1 }, snapshot: null });
		expect(events).toEqual([]);
		expect(h.wrapped()).toEqual(before);
		expect(readFileSync(h.plainPath, 'utf8').trim()).toBe(h.key);
		expect(existsSync(h.backupsDir)).toBe(false);
		expect(h.leftovers()).toEqual([]);
	});

	test('refuses a key that does not open the database, a running update, or a declined prompt', async () => {
		const h = await seededHost();
		const before = h.wrapped();
		writePlainMasterKey(h.plainPath, generateMasterKey());
		const options = { plainPath: h.plainPath, dbPath: h.dbPath, backupsDir: h.backupsDir, yes: true };
		await expect(rotateMasterKey(options, fakeHost().host)).rejects.toThrow('refusing to rotate');
		writePlainMasterKey(h.plainPath, h.key);

		await expect(rotateMasterKey(options, fakeHost({ active: [PRIMARY_UNIT, TRIGGER_SERVICE_UNIT] }).host)).rejects.toThrow('an update is running');
		const declined = fakeHost({ confirm: false });
		await expect(rotateMasterKey({ ...options, yes: false }, declined.host)).rejects.toBeInstanceOf(RotationError);
		expect(declined.events).toEqual(['confirm']);

		expect(h.wrapped()).toEqual(before);
		expect(h.leftovers()).toEqual([]);
		expect(existsSync(h.backupsDir)).toBe(false);
	});
});

describe('rewrapDatabase', () => {
	test('a wrong old key changes nothing', async () => {
		const h = await seededHost();
		const before = h.wrapped();
		const db = new Database(h.dbPath);
		expect(() => rewrapDatabase(db, keyBytes(generateMasterKey()), keyBytes(generateMasterKey()))).toThrow('does not open with this master key');
		db.close();
		expect(h.wrapped()).toEqual(before);
		expect(await h.opensWith(h.key)).toBe(true);
	});

	test('keyBytes insists on 32 bytes', () => {
		expect(() => keyBytes(Buffer.alloc(16).toString('base64'))).toThrow('32 bytes');
	});
});

describe('CLI', () => {
	test('rejects unknown arguments', async () => {
		const write = process.stderr.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			expect(await main(['--bogus'])).toBe(2);
		} finally {
			process.stderr.write = write;
		}
	});
});
