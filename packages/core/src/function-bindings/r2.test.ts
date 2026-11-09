import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, type FunctionBinding } from '@yoal/contracts';
import { createDb } from '@yoal/db';
import { createCore } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';
import type { Core } from '../index.ts';
import { resolveR2Binding } from './r2.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-r2-'));
const opened = createDb({ path: ':memory:' });
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
		now: () => Date.parse('2026-11-06T10:00:00Z'),
		features: { ...DEFAULT_FEATURES, FUNCTIONS: true },
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_2', role: 'owner', platformAdmin: true });

const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 16_384 });
await core.projects.create(owner, {
	name: 'fn-api',
	slug: 'fn-api',
	runtime: 'function',
	placement: 'auto',
	productionAccess: 'public',
	previewAccess: 'platform',
});
const project = core.projects.requireRow(owner, 'fn-api');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function binding(storage: string, bucket = 'uploads', overrides: Record<string, unknown> = {}): FunctionBinding {
	return { name: 'BUCKET', type: 'r2', storage, bucket, ...overrides } as FunctionBinding;
}

function resolve(storage: string, bucket = 'uploads', overrides: Record<string, unknown> = {}) {
	return resolveR2Binding({ core: core.ctx, project }, binding(storage, bucket, overrides));
}

describe('resolveR2Binding', () => {
	test('resolves an attached RustFS instance to a secret-free spec', async () => {
		core.storage.create(owner, { name: 'media', buckets: ['uploads', 'avatars'] });
		core.storage.attach(owner, project, {
			storage: 'media',
			envPrefix: 'MEDIA',
			grants: [{ bucket: 'uploads', mode: 'read-write' }],
		});

		const resolved = await resolve('media', 'uploads', { prefix: 'tenant/' });
		expect(resolved).toEqual({
			name: 'BUCKET',
			type: 'r2',
			storage: 'media',
			bucket: 'uploads',
			prefix: 'tenant/',
			envPrefix: 'MEDIA',
		});
		// D66: credentials and the endpoint arrive in the activation env, never in the spec.
		expect(Object.keys(resolved).sort()).toEqual(['bucket', 'envPrefix', 'name', 'prefix', 'storage', 'type']);
		expect(JSON.stringify(resolved)).not.toMatch(/secret|endpoint|access.?key/i);
	});

	test('omits prefix when the manifest does not set one', async () => {
		const resolved = await resolve('media');
		expect(resolved).toEqual({
			name: 'BUCKET',
			type: 'r2',
			storage: 'media',
			bucket: 'uploads',
			envPrefix: 'MEDIA',
		});
		expect('prefix' in resolved).toBe(false);
	});

	test('defaults the env prefix to S3', async () => {
		core.storage.create(owner, { name: 'plain', buckets: ['data'], project: 'fn-api' });
		const resolved = await resolve('plain', 'data');
		expect(resolved).toEqual({
			name: 'BUCKET',
			type: 'r2',
			storage: 'plain',
			bucket: 'data',
			envPrefix: 'S3',
		});
	});

	test('refuses a storage instance that does not exist in the caller org', async () => {
		expect(() => resolve('missing')).toThrow(
			'Binding BUCKET: storage instance "missing" does not exist in this organisation.',
		);
		// The same name in another org is invisible here.
		core.storage.create(otherOrg, { name: 'foreign', buckets: ['data'] });
		expect(() => resolve('foreign')).toThrow(/does not exist in this organisation/);
	});

	test('refuses a deleted instance', async () => {
		core.storage.create(owner, { name: 'trashed', buckets: ['data'] });
		core.storage.delete(owner, 'trashed');
		expect(() => resolve('trashed')).toThrow(/does not exist in this organisation/);
	});

	test('refuses a storage engine that is not RustFS', () => {
		// The shipped schema has a CHECK constraint limiting `engine` to rustfs, so this branch is a
		// guard for a future engine rather than something the API can create today. Drive it with a
		// stub query so the check stays covered.
		const context = {
			core: {
				db: {
					select: () => {
						const query = {
							from: () => query,
							where: () => query,
							get: () => ({ id: 'st_legacy', orgId: 'org_1', name: 'legacy', engine: 'minio' }),
						};
						return query;
					},
				},
			},
			project,
		} as unknown as Parameters<typeof resolveR2Binding>[0];
		expect(() => resolveR2Binding(context, binding('legacy'))).toThrow(
			'Binding BUCKET: storage instance "legacy" is not RustFS and cannot back an R2 binding.',
		);
	});

	test('refuses an instance that is not attached to this project', async () => {
		core.storage.create(owner, { name: 'loose', buckets: ['data'] });
		expect(() => resolve('loose', 'data')).toThrow(
			'Binding BUCKET: attach storage "loose" to this project before using it as an R2 binding.',
		);
	});

	test('refuses a bucket the attachment does not grant', async () => {
		expect(() => resolve('media', 'avatars')).toThrow(
			'Binding BUCKET: the storage attachment does not grant bucket "avatars".',
		);
		// The bucket exists on the instance; only the grant is missing.
		expect(core.storage.get(owner, 'media').buckets.map((bucket) => bucket.name)).toContain('avatars');
	});

	test('counts a "*" grant as covering every bucket', async () => {
		core.ctx.sqlite.run(
			'UPDATE storage_attachments SET grants_json = ? WHERE project_id = ? AND storage_id = (SELECT id FROM storage_instances WHERE name = ?)',
			[JSON.stringify([{ bucket: '*', mode: 'read-write' }]), project.id, 'media'],
		);
		const resolved = await resolve('media', 'avatars');
		expect(resolved).toMatchObject({ storage: 'media', bucket: 'avatars', envPrefix: 'MEDIA' });
	});

	test('refuses a binding of another type', () => {
		expect(() =>
			resolveR2Binding({ core: core.ctx, project }, { name: 'CACHE', type: 'cache' } as FunctionBinding),
		).toThrow('R2 resolver received binding "CACHE" of type "cache", not "r2".');
	});
});
