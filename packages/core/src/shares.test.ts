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

describe('share mounts', () => {
	const heartbeat = (node: { nodeId: string; token: string }, extra: Record<string, unknown> = {}) =>
		core.nodes.heartbeat(node.token, {
			nodeId: node.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			workloads: [],
			capabilities: ['share-mounts'],
			...extra,
		} as Parameters<typeof core.nodes.heartbeat>[1]);
	const inventory = (mounts: Array<{ sourceKey: string; kind: 'nfs' | 'cifs'; mountPath: string }>) => ({
		generatedAt: new Date(clock).toISOString(),
		mounts: mounts.map((mount) => ({
			...mount,
			fsType: mount.kind === 'nfs' ? 'nfs4' : 'cifs',
			device: null,
			label: null,
			sizeBytes: 4_000_000_000_000,
			freeBytes: 3_000_000_000_000,
			remote: true,
		})),
		devices: [],
	});
	const enrol = (name: string) => core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name });

	test('mounts an SMB share, keeps credentials out of desired state and links it as a volume', async () => {
		const node = enrol('nas-client');
		heartbeat(node);
		core.shares.create(admin, {
			name: 'vault',
			protocol: 'smb',
			server: 'nas.home',
			exportPath: '/vault/',
			readOnly: false,
			credentials: { username: 'skiff', password: 'hunter2-secret', domain: 'HOME' },
		});
		const created = core.shares.get(admin, 'vault');
		expect(created).toMatchObject({ exportPath: '/vault', hasCredentials: true, username: 'skiff', mounts: [] });
		expect(JSON.stringify(created)).not.toContain('hunter2');

		const mounted = core.shares.mount(admin, 'vault', { node: 'nas-client' });
		expect(mounted.mounts).toMatchObject([
			{ nodeName: 'nas-client', status: 'pending', mountPath: '/mnt/skiff-shares/vault', diskName: 'vault', disk: null },
		]);
		const mountId = mounted.mounts[0]!.id;

		const desired = await core.nodes.desiredState(node.token);
		expect(desired.shareMounts).toEqual([
			{
				id: mountId,
				name: 'vault',
				protocol: 'smb',
				server: 'nas.home',
				exportPath: '/vault',
				readOnly: false,
				credentials: true,
				generation: '1',
			},
		]);
		expect(JSON.stringify(desired)).not.toContain('hunter2');

		// Only the node holding the mount can fetch the credentials.
		expect(core.shares.credentialsFor(node.nodeId, mountId)).toEqual({
			id: mountId,
			username: 'skiff',
			password: 'hunter2-secret',
			domain: 'HOME',
		});
		expect(() => core.shares.credentialsFor('node_other', mountId)).toThrow(/not found/i);

		// Mounted, but the inventory has not caught up: no link yet.
		heartbeat(node, { shareMounts: [{ id: mountId, mounted: true, error: null }] });
		expect(core.shares.get(admin, 'vault').mounts[0]).toMatchObject({ status: 'mounted', disk: null });

		// The next inventory shows the mount at its path: it becomes a bulk network disk.
		heartbeat(node, {
			shareMounts: [{ id: mountId, mounted: true, error: null }],
			volumes: inventory([{ sourceKey: 'cifs:nas.home/vault', kind: 'cifs', mountPath: '/mnt/skiff-shares/vault' }]),
		});
		const linked = core.shares.get(admin, 'vault').mounts[0]!;
		expect(linked.disk).toMatchObject({ name: 'vault', status: 'ready' });
		const disks = core.disks.overview(admin).nodes.find((item) => item.id === node.nodeId)!.disks;
		expect(disks).toMatchObject([
			{ name: 'vault', kind: 'cifs', remote: true, tier: 'bulk', share: 'vault', mountPath: '/mnt/skiff-shares/vault' },
		]);
		// Settings → Storage cannot remove it; the share owns it.
		expect(() => core.disks.remove(admin, disks[0]!.id)).toThrow(/Network shares/);
		expect((await core.nodes.desiredState(node.token)).volumes.map((volume) => volume.sourceKey)).toEqual([
			'cifs:nas.home/vault',
		]);

		// Definition changes and deletion wait for the unmount; credentials can rotate any time.
		expect(() => core.shares.update(admin, 'vault', { server: 'nas2.home' })).toThrow(/Unmount it/);
		expect(() => core.shares.remove(admin, 'vault')).toThrow(/still mounted/);
		const rotated = core.shares.update(admin, 'vault', { credentials: { username: 'skiff2', password: 'new-secret' } });
		expect(rotated.username).toBe('skiff2');
		expect((await core.nodes.desiredState(node.token)).shareMounts[0]!.generation).toBe('2');

		// Unmount removes the disk, then waits for the node.
		const unmounting = core.shares.unmount(admin, 'vault', node.nodeId);
		expect(unmounting.mounts[0]).toMatchObject({ status: 'unmounting', disk: null });
		expect(core.disks.overview(admin).nodes.find((item) => item.id === node.nodeId)!.disks).toEqual([]);
		const pulled = await core.nodes.desiredState(node.token);
		expect(pulled.shareMounts).toEqual([]);
		expect(pulled.shareUnmounts).toEqual([{ id: mountId, name: 'vault' }]);
		heartbeat(node, { unmountedShares: [mountId] });
		expect(core.shares.get(admin, 'vault').mounts).toEqual([]);
		expect(core.shares.remove(admin, 'vault')).toEqual({ ok: true });
	});

	test('records mount failures and refuses work the node or share cannot take', () => {
		const node = enrol('nfs-client');
		heartbeat(node);
		const old = enrol('old-agent');
		heartbeat(old, { capabilities: [] });
		core.shares.create(admin, { name: 'library', protocol: 'nfs', server: '10.0.0.5', exportPath: '/export/library', readOnly: false });
		core.shares.create(admin, { name: 'photos', protocol: 'nfs', server: '10.0.0.5', exportPath: '/export/photos', readOnly: true });
		core.shares.create(admin, { name: 'nocreds', protocol: 'smb', server: 'nas', exportPath: '/x', readOnly: false });

		expect(() => core.shares.mount(admin, 'library', { node: 'old-agent' })).toThrow(/Update the node/);
		expect(() => core.shares.mount(admin, 'nocreds', { node: 'nfs-client' })).toThrow(/username and password/);
		expect(() => core.shares.mount(member, 'library', { node: 'nfs-client' })).toThrow(/Platform admin/);

		// A read-only share is a plain mount: it never becomes a disk.
		expect(core.shares.mount(admin, 'photos', { node: 'nfs-client' }).mounts[0]!.diskName).toBeNull();

		const mountId = core.shares.mount(admin, 'library', { node: 'nfs-client', diskName: 'library-disk' }).mounts[0]!.id;
		expect(() => core.shares.mount(admin, 'library', { node: 'nfs-client' })).toThrow(/already mounted/);
		heartbeat(node, { shareMounts: [{ id: mountId, mounted: false, error: 'access denied by server' }] });
		expect(core.shares.get(admin, 'library').mounts[0]).toMatchObject({ status: 'failed', message: 'access denied by server' });

		// Once mounted, it becomes the disk it was asked to be.
		heartbeat(node, {
			shareMounts: [{ id: mountId, mounted: true, error: null }],
			volumes: inventory([{ sourceKey: 'nfs:10.0.0.5:/export/library', kind: 'nfs', mountPath: '/mnt/skiff-shares/library' }]),
		});
		expect(core.shares.get(admin, 'library').mounts[0]!.disk).toMatchObject({ name: 'library-disk' });

		// Stop using it as a disk: the share stays mounted and does not turn back into one.
		core.shares.unlink(admin, 'library', 'nfs-client');
		heartbeat(node, { shareMounts: [{ id: mountId, mounted: true, error: null }] });
		expect(core.shares.get(admin, 'library').mounts[0]).toMatchObject({ status: 'mounted', disk: null, diskName: null });
		// And use it again under another name.
		const linked = core.shares.link(admin, 'library', 'nfs-client', { diskName: 'library-vol' });
		expect(linked.mounts[0]!.disk).toMatchObject({ name: 'library-vol' });
	});
});

