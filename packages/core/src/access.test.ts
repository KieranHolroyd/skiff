import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, domains } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-access-'));
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
		now: () => Date.now(),
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('custom-host access', () => {
	test('resolves a verified custom domain to the project production deployment', async () => {
		await core.projects.create(principal, {
			name: 'blog',
			slug: 'blog',
			runtime: 'static',
			placement: 'edge',
			productionAccess: 'password',
			previewAccess: 'platform',
		});
		const project = core.projects.requireRow(principal, 'blog');
		const deployment = await core.uploads.deployInline(
			principal,
			project,
			[
				{ path: 'index.html', content: '<h1>hi</h1>', encoding: 'utf8' },
				{ path: '404.html', content: 'nope', encoding: 'utf8' },
			],
			{ promote: true },
		);

		opened.db
			.insert(domains)
			.values({
				id: 'dom_test',
				orgId: project.orgId,
				projectId: project.id,
				hostname: 'blog.example.com',
				kind: 'custom',
				status: 'verified',
				verificationToken: 'token',
				verifiedAt: Date.now(),
				redirectWww: false,
				createdAt: Date.now(),
			})
			.run();

		expect(core.access.resolveHost('blog.example.com')).toMatchObject({
			deploymentId: deployment.id,
			production: true,
		});
		expect(core.access.isAllowedReturnHost('blog.example.com')).toBe(true);
		expect(core.access.isAllowedReturnHost('blog.sites.test')).toBe(true);
		expect(core.access.isAllowedReturnHost('evil.example.com')).toBe(false);
	});
});
