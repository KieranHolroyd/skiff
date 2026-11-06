import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-shares-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.now();
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});
const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('cluster shares', () => {
	test('creates, lists, updates and removes a share', () => {
		const created = core.shares.create(admin, {
			name: 'media',
			protocol: 'nfs',
			server: '10.0.0.5',
			exportPath: '/mnt/media',
			zone: 'home',
			readOnly: true,
		});
		expect(created).toMatchObject({ name: 'media', protocol: 'nfs', zone: 'home', readOnly: true });
		expect(core.shares.list(admin).map((share) => share.name)).toEqual(['media']);
		const updated = core.shares.update(admin, 'media', { readOnly: false, server: '10.0.0.6' });
		expect(updated).toMatchObject({ server: '10.0.0.6', readOnly: false });
		expect(core.shares.remove(admin, 'media')).toEqual({ ok: true });
		expect(core.shares.list(admin)).toEqual([]);
	});

	test('replaces grants without exposing a credential value', () => {
		core.shares.create(admin, {
			name: 'backups',
			protocol: 'smb',
			server: 'nas.home',
			exportPath: '/backups',
			readOnly: true,
			credentialsRef: 'sec_smb_1',
		});
		const view = core.shares.setGrants(admin, 'backups', {
			grants: [
				{ orgId: 'org_1', mode: 'rw', pathPrefix: 'projects/' },
				{ orgId: 'org_2', mode: 'ro', pathPrefix: '' },
			],
		});
		expect(view.grants).toHaveLength(2);
		expect(view.credentialsRef).toBe('sec_smb_1');
		expect(JSON.stringify(view)).not.toContain('password');
	});

	test('validates names, exports and duplicates', () => {
		core.shares.create(admin, { name: 'media', protocol: 'nfs', server: '10.0.0.5', exportPath: '/mnt/media' });
		expect(() =>
			core.shares.create(admin, { name: 'media', protocol: 'nfs', server: '10.0.0.5', exportPath: '/mnt/media' }),
		).toThrow(/already exists/);
		expect(() =>
			core.shares.create(admin, { name: 'bad path', protocol: 'nfs', server: '10.0.0.5', exportPath: '/mnt' }),
		).toThrow();
		expect(() =>
			core.shares.create(admin, { name: 'relative', protocol: 'nfs', server: '10.0.0.5', exportPath: 'mnt/media' }),
		).toThrow(/absolute/);
	});

	test('needs a platform admin', () => {
		expect(() => core.shares.list(member)).toThrow(/Platform admin/);
		expect(() =>
			core.shares.create(member, { name: 'nope', protocol: 'nfs', server: '10.0.0.5', exportPath: '/x' }),
		).toThrow(/Platform admin/);
	});
});
