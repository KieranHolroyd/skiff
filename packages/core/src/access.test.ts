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
			password: 'blog-password',
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

describe('resource-scoped access', () => {
	test('a project-scoped deployer manages only that project’s share links and visitor sessions', async () => {
		for (const slug of ['share-scoped-visible', 'share-scoped-hidden']) {
			await core.projects.create(principal, {
				name: slug,
				slug,
				runtime: 'static',
				placement: 'edge',
				productionAccess: 'platform',
				previewAccess: 'platform',
			});
		}
		const visible = core.projects.requireRow(principal, 'share-scoped-visible');
		const hidden = core.projects.requireRow(principal, 'share-scoped-hidden');
		// Inserted directly so iamVersion stays 0 and the owner in the rest of this file keeps its
		// legacy org-wide grants.
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_guest_share_links', 'org_1', 'user', 'user_guest_share_links', 'deployer', 'project', ?, 'test', 0)`,
			[visible.id],
		);
		const guest = buildPrincipal({
			kind: 'user',
			userId: 'user_guest_share_links',
			orgId: 'org_1',
			role: 'viewer',
		});

		const link = await core.access.createShareLink(guest, visible, { note: 'visible' });
		expect(link.projectId).toBe(visible.id);
		await expect(core.access.createShareLink(guest, hidden, {})).rejects.toThrow(/shareLink:create/);
		expect(core.access.listShareLinks(guest, visible).map((entry) => entry.id)).toEqual([link.id]);
		expect(() => core.access.listShareLinks(guest, hidden)).toThrow(/shareLink:read/);

		const hiddenLink = await core.access.createShareLink(principal, hidden, {});
		await expect(core.access.revokeShareLink(guest, hidden, hiddenLink.id)).rejects.toThrow(
			/shareLink:revoke/,
		);
		await core.access.revokeShareLink(guest, visible, link.id);

		expect(core.access.listSessions(guest, visible)).toEqual([]);
		expect(() => core.access.listSessions(guest, hidden)).toThrow(/shareLink:read/);
		await expect(core.access.revokeSession(guest, hidden, 'red_missing')).rejects.toThrow(
			/shareLink:revoke/,
		);
		await core.access.signOutEveryone(guest, visible);
		await expect(core.access.signOutEveryone(guest, hidden)).rejects.toThrow(/project:update/);
	});
});
