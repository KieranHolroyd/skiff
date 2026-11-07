import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-secrets-'));
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
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const key = (...permissions: string[]) =>
	buildPrincipal({ kind: 'apiKey', userId: 'user_1', orgId: 'org_1', role: 'owner', granted: ['secret:read-metadata', ...permissions] });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('secret permissions', () => {
	test('a new name needs secret:create and a new version of a live one secret:update', async () => {
		const createOnly = key('secret:create');
		const updateOnly = key('secret:update');

		await expect(core.secrets.set(updateOnly, { name: 'API_KEY', value: 'one' })).rejects.toMatchObject({ permission: 'secret:create' });
		const first = await core.secrets.set(createOnly, { name: 'API_KEY', value: 'one' });
		expect(first.version).toBe(1);

		await expect(core.secrets.set(createOnly, { name: 'API_KEY', value: 'two' })).rejects.toMatchObject({ permission: 'secret:update' });
		expect(core.secrets.getValue('org_1', 'API_KEY')?.value).toBe('one');
		const second = await core.secrets.set(updateOnly, { name: 'API_KEY', value: 'two' });
		expect(second.version).toBe(2);
		expect(core.secrets.getValue('org_1', 'API_KEY')?.value).toBe('two');

		const actions = core.audit
			.list({ orgId: 'org_1' })
			.filter((entry) => entry.resource === 'secret')
			.map((entry) => entry.action);
		expect(actions).toContain('secret.create');
		expect(actions).toContain('secret.update');
	});

	test('scopes are separate: a project copy of an org secret is a new secret', async () => {
		const project = await core.projects.create(owner, {
			name: 'App',
			slug: 'app',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		expect(core.secrets.latest('org_1', project.id, 'API_KEY')).toBeNull();
		await expect(core.secrets.set(key('secret:update'), { name: 'API_KEY', value: 'p', projectId: project.id })).rejects.toMatchObject({
			permission: 'secret:create',
		});
		await core.secrets.set(key('secret:create'), { name: 'API_KEY', value: 'p', projectId: project.id });
		expect(core.secrets.latest('org_1', project.id, 'API_KEY')).toEqual({ version: 1 });
	});

	test('a deleted name can be created again with secret:create', async () => {
		const created = await core.secrets.set(owner, { name: 'GONE', value: 'x' });
		await core.secrets.delete(owner, created.id);
		expect(core.secrets.latest('org_1', null, 'GONE')).toBeNull();
		await core.secrets.set(key('secret:create'), { name: 'GONE', value: 'y' });
		expect(core.secrets.getValue('org_1', 'GONE')?.value).toBe('y');
	});

	test('the deployer role carries both; viewers neither', () => {
		const deployer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'deployer' });
		const viewer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_1', role: 'viewer' });
		expect(() => core.secrets.requireWrite(deployer, { name: 'API_KEY' })).not.toThrow();
		expect(() => core.secrets.requireWrite(viewer, { name: 'API_KEY' })).toThrow(/secret:update/);
		expect(() => core.secrets.requireWrite(viewer, { name: 'NEW_NAME' })).toThrow(/secret:create/);
	});
});
