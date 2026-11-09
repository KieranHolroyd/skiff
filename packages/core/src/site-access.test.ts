import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, migrations } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { siteKeyFor } from './config.ts';
import { LocalObjectStore } from './object-store.ts';
import { hashPassword, verifyPassword } from './util.ts';
import type { Core } from './index.ts';

/** Per-scope site passwords and visitor-session revocation (DESIGN §6.4). */

const dir = mkdtempSync(join(tmpdir(), 'yoal-site-access-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.now();
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
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const files = [{ path: 'index.html', content: '<h1>hi</h1>', encoding: 'utf8' as const }];

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function project(slug: string, productionAccess: 'public' | 'password' | 'platform', previewAccess: 'public' | 'password' | 'platform', password?: string) {
	await core.projects.create(owner, { name: slug, slug, runtime: 'static', placement: 'edge', productionAccess, previewAccess, ...(password ? { password } : {}) });
	const row = core.projects.requireRow(owner, slug);
	const deployment = await core.uploads.deployInline(owner, row, files, { promote: true });
	return { row: core.projects.requireRow(owner, slug), previewHost: new URL(deployment.previewUrl).hostname };
}

const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as { sid?: string };

describe('per-scope passwords', () => {
	test('changing previews never touches the production password', async () => {
		const { previewHost } = await project('pw-scopes', 'password', 'password', 'shared-secret');
		expect(core.projects.view(core.projects.requireRow(owner, 'pw-scopes'))).toMatchObject({
			productionPasswordSet: true,
			previewPasswordSet: true,
		});

		// The old bug: previews -> platform cleared the one shared hash and locked production out.
		await core.projects.setAccess(owner, 'pw-scopes', { scope: 'previews', mode: 'platform' });
		expect(core.access.passwordAccess('pw-scopes.sites.test', 'shared-secret').token).toBeTruthy();
		const view = core.projects.view(core.projects.requireRow(owner, 'pw-scopes'));
		expect(view).toMatchObject({ productionAccess: 'password', productionPasswordSet: true, previewPasswordSet: false });

		// Previews get their own password; each host accepts only its scope's.
		await core.projects.setAccess(owner, 'pw-scopes', { scope: 'previews', mode: 'password', password: 'preview-only' });
		expect(core.access.passwordAccess(previewHost, 'preview-only').token).toBeTruthy();
		expect(() => core.access.passwordAccess(previewHost, 'shared-secret')).toThrow(/Incorrect password/);
		expect(() => core.access.passwordAccess('pw-scopes.sites.test', 'preview-only')).toThrow(/Incorrect password/);

		// Changing the production password leaves previews alone.
		await core.projects.setAccess(owner, 'pw-scopes', { scope: 'production', mode: 'password', password: 'new-production' });
		expect(core.access.passwordAccess('pw-scopes.sites.test', 'new-production').token).toBeTruthy();
		expect(core.access.passwordAccess(previewHost, 'preview-only').token).toBeTruthy();
	});

	test('password mode needs a password, except to keep the one a scope already has', async () => {
		await project('pw-required', 'public', 'platform');
		await expect(core.projects.setAccess(owner, 'pw-required', { scope: 'production', mode: 'password' })).rejects.toMatchObject({
			code: 'validation',
		});
		await expect(core.projects.update(owner, 'pw-required', { previewAccess: 'password' })).rejects.toMatchObject({ code: 'validation' });
		await expect(
			core.projects.create(owner, { name: 'nopw', slug: 'nopw-site', runtime: 'static', placement: 'edge', productionAccess: 'password', previewAccess: 'platform' }),
		).rejects.toMatchObject({ code: 'validation' });

		await core.projects.setAccess(owner, 'pw-required', { scope: 'production', mode: 'password', password: 'first-pass' });
		// Re-saving password mode without a new password keeps the current one.
		await core.projects.setAccess(owner, 'pw-required', { scope: 'production', mode: 'password' });
		expect(core.access.passwordAccess('pw-required.sites.test', 'first-pass').token).toBeTruthy();
		// Leaving password mode clears it, so coming back needs a password again.
		await core.projects.setAccess(owner, 'pw-required', { scope: 'production', mode: 'public' });
		await expect(core.projects.setAccess(owner, 'pw-required', { scope: 'production', mode: 'password' })).rejects.toMatchObject({
			code: 'validation',
		});
	});

	test('a host whose scope is not in password mode never accepts a password', async () => {
		const { previewHost } = await project('pw-platform-prod', 'platform', 'password', 'preview-pass');
		expect(core.access.passwordAccess(previewHost, 'preview-pass').token).toBeTruthy();
		expect(() => core.access.passwordAccess('pw-platform-prod.sites.test', 'preview-pass')).toThrow(/Incorrect password/);
	});

	test('named environments keep their own password', async () => {
		const { row } = await project('pw-envs', 'password', 'password', 'project-pass');
		expect(() => core.environments.create(owner, row, { name: 'Staging', access: 'password' })).toThrow(/password is required/);
		const staging = core.environments.create(owner, row, { name: 'Staging', access: 'password', password: 'staging-pass' });
		expect(staging.passwordSet).toBe(true);
		// Inheriting password-protected previews inherits their password.
		const qa = core.environments.create(owner, row, { name: 'QA' });
		expect(qa).toMatchObject({ access: 'password', passwordSet: true });
		await core.uploads.deployInline(owner, row, files, { environment: 'staging' });
		await core.uploads.deployInline(owner, row, files, { environment: 'qa' });

		expect(core.access.passwordAccess('pw-envs--staging.sites.test', 'staging-pass').token).toBeTruthy();
		expect(() => core.access.passwordAccess('pw-envs--staging.sites.test', 'project-pass')).toThrow(/Incorrect password/);
		expect(core.access.passwordAccess('pw-envs--qa.sites.test', 'project-pass').token).toBeTruthy();

		// Opening staging up leaves production and QA in password mode with their passwords.
		const opened = core.environments.update(owner, row, 'staging', { access: 'public' });
		expect(opened.passwordSet).toBe(false);
		expect(() => core.environments.update(owner, row, 'staging', { access: 'password' })).toThrow(/password is required/);
		expect(core.access.passwordAccess('pw-envs.sites.test', 'project-pass').token).toBeTruthy();
		expect(core.access.passwordAccess('pw-envs--qa.sites.test', 'project-pass').token).toBeTruthy();
		// Renaming a password environment keeps its password.
		expect(core.environments.update(owner, row, 'qa', { name: 'Quality', access: 'password' }).passwordSet).toBe(true);
	});

	test('migration 0054 copies the shared hash to every scope in password mode', () => {
		const legacy = hashPassword('legacy-pass');
		const sqlite = opened.sqlite;
		const insertProject = (id: string, slug: string, production: string, preview: string) =>
			sqlite.run(
				`INSERT INTO projects (id, org_id, slug, name, runtime, placement, production_access, preview_access, access_secret_hash, created_by, created_at, updated_at)
				 VALUES (?, 'org_legacy', ?, ?, 'static', 'edge', ?, ?, ?, 'user_1', 0, 0)`,
				[id, slug, slug, production, preview, legacy],
			);
		insertProject('prj_legacy_both', 'legacy-both', 'password', 'password');
		insertProject('prj_legacy_prod', 'legacy-prod', 'password', 'platform');
		insertProject('prj_legacy_none', 'legacy-none', 'public', 'platform');
		for (const [id, project, access, isProduction] of [
			['env_l1', 'prj_legacy_prod', 'password', 0],
			['env_l2', 'prj_legacy_prod', 'public', 0],
			['env_l3', 'prj_legacy_prod', 'password', 1],
		] as const)
			sqlite.run(
				`INSERT INTO environments (id, org_id, project_id, name, slug, is_production, access, created_at, updated_at)
				 VALUES (?, 'org_legacy', ?, ?, ?, ?, ?, 0, 0)`,
				[id, project, id, id, isProduction, access],
			);

		const sql = migrations.find((migration) => migration.id.startsWith('0054_site_access'))!.sql;
		const updates = sql
			.replace(/--.*$/gm, '')
			.split(';')
			.map((statement) => statement.trim())
			.filter((statement) => statement.startsWith('UPDATE'));
		expect(updates.length).toBe(3);
		for (const statement of updates) sqlite.run(statement);

		const hashes = (id: string) =>
			sqlite
				.query<{ production: string | null; preview: string | null }, [string]>(
					'SELECT production_password_hash AS production, preview_password_hash AS preview FROM projects WHERE id = ?',
				)
				.get(id)!;
		expect(verifyPassword('legacy-pass', hashes('prj_legacy_both').production)).toBe(true);
		expect(verifyPassword('legacy-pass', hashes('prj_legacy_both').preview)).toBe(true);
		expect(hashes('prj_legacy_prod')).toMatchObject({ production: legacy, preview: null });
		expect(hashes('prj_legacy_none')).toMatchObject({ production: null, preview: null });
		const environmentHash = (id: string) =>
			sqlite.query<{ hash: string | null }, [string]>('SELECT password_hash AS hash FROM environments WHERE id = ?').get(id)!.hash;
		expect(environmentHash('env_l1')).toBe(legacy);
		expect(environmentHash('env_l2')).toBeNull();
		expect(environmentHash('env_l3')).toBeNull();
	});
});

describe('visitor sessions', () => {
	test('lists live share sessions and revokes one', async () => {
		const { row } = await project('sessions-one', 'platform', 'platform');
		const link = await core.access.createShareLink(owner, row, { note: 'review', sessionTtlSeconds: 600 });
		const raw = new URL(link.url!).searchParams.get('_yoal_share')!;
		const first = core.access.shareAccess(raw, { ip: '1.1.1.1', userAgent: 'a' });
		core.access.shareAccess(raw, { ip: '2.2.2.2', userAgent: 'b' });

		const sessions = core.access.listSessions(viewer, row);
		expect(sessions).toHaveLength(2);
		expect(sessions[0]).toMatchObject({ kind: 'share', shareLinkId: link.id, note: 'review', host: 'sessions-one.sites.test' });

		const sid = claims(first.token).sid!;
		await expect(core.access.revokeSession(viewer, row, sid)).rejects.toThrow(/Missing permission/);
		await core.access.revokeSession(owner, row, sid);
		expect(core.access.listSessions(owner, row).map((session) => session.id)).not.toContain(sid);
		expect(core.access.revocations().some((revocation) => revocation.id === sid)).toBe(true);
		// Revoking twice is a 404, not a silent success.
		await expect(core.access.revokeSession(owner, row, sid)).rejects.toMatchObject({ code: 'not_found' });
		expect(core.audit.list({ orgId: 'org_1', limit: 50 }).some((entry) => entry.action === 'site_session.revoke')).toBe(true);

		// Expired sessions drop out of the list on their own.
		clock += 601_000;
		expect(core.access.listSessions(owner, row)).toHaveLength(0);
	});

	test('sign out everyone rotates the site key on every route of the project', async () => {
		const { row, previewHost } = await project('sessions-all', 'password', 'platform', 'all-pass');
		const other = await project('sessions-other', 'platform', 'platform');
		const link = await core.access.createShareLink(owner, row, {});
		const raw = new URL(link.url!).searchParams.get('_yoal_share')!;
		core.access.shareAccess(raw, { ip: '3.3.3.3', userAgent: 'c' });
		const before = core.access.passwordAccess('sessions-all.sites.test', 'all-pass');
		expect(core.access.verifySiteToken(row.id, before.token)).not.toBeNull();

		const edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'sessions-edge').token, name: 'sessions-edge' });
		const keyOf = async (host: string) => (await core.nodes.desiredState(edge.token)).routes.find((route) => route.host === host)?.access.siteKey;
		const oldKey = await keyOf('sessions-all.sites.test');
		expect(oldKey).toBe(siteKeyFor('site-cookie-secret-123', row.id));
		const otherKey = await keyOf('sessions-other.sites.test');

		await expect(core.access.signOutEveryone(viewer, row)).rejects.toThrow(/Missing permission/);
		const result = await core.access.signOutEveryone(owner, row);
		expect(result).toMatchObject({ epoch: 1, shareSessions: 1 });

		// Every route of this project gets the new key; other projects keep theirs.
		const newKey = await keyOf('sessions-all.sites.test');
		expect(newKey).not.toBe(oldKey);
		expect(await keyOf(previewHost)).toBe(newKey!);
		expect(await keyOf('sessions-other.sites.test')).toBe(otherKey!);
		// Tokens minted before no longer verify; the share session left the list.
		expect(core.access.verifySiteToken(row.id, before.token)).toBeNull();
		expect(core.access.listSessions(owner, row)).toHaveLength(0);
		expect(core.access.listSessions(owner, other.row)).toHaveLength(0);

		// Visitors can sign in again, and the link still starts new sessions.
		const after = core.access.passwordAccess('sessions-all.sites.test', 'all-pass');
		expect(core.access.verifySiteToken(row.id, after.token)).not.toBeNull();
		core.access.shareAccess(raw, { ip: '3.3.3.3', userAgent: 'c' });
		expect(core.access.listSessions(owner, row)).toHaveLength(1);
		expect(core.audit.list({ orgId: 'org_1', limit: 50 }).some((entry) => entry.action === 'site_session.sign_out_all')).toBe(true);
	});
});
