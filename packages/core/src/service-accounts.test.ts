import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { ForbiddenError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-service-accounts-'));
const opened = createDb({ path: ':memory:' });
let now = Date.parse('2026-11-08T12:00:00Z');
let core: Core;

function open(): Core {
	return createCore({
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
			now: () => now,
		},
	});
}

function principal(overrides: Partial<Parameters<typeof buildPrincipal>[0]> = {}): Principal {
	return buildPrincipal({
		kind: 'user',
		userId: 'user_1',
		orgId: 'org_1',
		role: 'owner',
		...overrides,
	});
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM service_accounts;
		DELETE FROM iam_bindings;
		DELETE FROM iam_group_members;
		DELETE FROM iam_groups;
		DELETE FROM iam_roles;
		DELETE FROM iam_guardrails;
		DELETE FROM iam_state;
		CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT);
		DELETE FROM member;
	`);
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('service accounts', () => {
	test('create normalises the name and list returns the account', () => {
		const owner = principal();
		const account = core.ctx.serviceAccounts.create(owner, {
			name: '  CI-Bot ',
			description: 'Deploys from GitHub Actions',
		});
		expect(account).toMatchObject({
			name: 'ci-bot',
			description: 'Deploys from GitHub Actions',
			ownerGroupId: null,
			disabled: false,
			disabledAt: null,
			createdBy: 'user_1',
			createdAt: now,
		});
		expect(account.id).toMatch(/^sa_/);
		expect(core.ctx.serviceAccounts.list(owner)).toEqual([account]);
		expect(core.ctx.serviceAccounts.get(owner, account.id)).toEqual(account);
	});

	test('a name must be a slug and unique in the org', () => {
		const owner = principal();
		core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		expect(() => core.ctx.serviceAccounts.create(owner, { name: 'CI-Bot' })).toThrow(/already exists/);
		expect(() => core.ctx.serviceAccounts.create(owner, { name: 'ci_bot' })).toThrow(/lowercase/);
		expect(() => core.ctx.serviceAccounts.create(owner, { name: '-ci' })).toThrow(/lowercase/);
		expect(() => core.ctx.serviceAccounts.create(owner, { name: 'ci' })).toThrow(
			/must be 3/,
		);
	});

	test('an owner group must belong to the same org', () => {
		const owner = principal();
		const group = core.ctx.iam.createGroup(owner, { name: 'platform' });
		expect(
			core.ctx.serviceAccounts.create(owner, { name: 'deploy-bot', ownerGroupId: group.id })
				.ownerGroupId,
		).toBe(group.id);
		expect(() =>
			core.ctx.serviceAccounts.create(owner, { name: 'other-bot', ownerGroupId: 'grp_missing' }),
		).toThrow(/owner group/);
	});

	test('disable is reported on the account and can be reversed', () => {
		const owner = principal();
		const account = core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		const disabled = core.ctx.serviceAccounts.update(owner, account.id, { disabled: true });
		expect(disabled).toMatchObject({ disabled: true, disabledAt: now });
		expect(core.ctx.serviceAccounts.get(owner, account.id).disabled).toBe(true);

		now += 60_000;
		const enabled = core.ctx.serviceAccounts.update(owner, account.id, { disabled: false });
		expect(enabled).toMatchObject({ disabled: false, disabledAt: null });
	});

	test('update renames with uniqueness and audits nothing when it is a no-op', () => {
		const owner = principal();
		const first = core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		const second = core.ctx.serviceAccounts.create(owner, { name: 'deploy-bot' });
		expect(() =>
			core.ctx.serviceAccounts.update(owner, second.id, { name: 'ci-bot' }),
		).toThrow(/already exists/);
		expect(core.ctx.serviceAccounts.update(owner, first.id, { name: 'ci-bot' }).name).toBe('ci-bot');
	});

	test('delete is refused while a binding points at the account', () => {
		const owner = principal();
		const account = core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		const binding = core.ctx.iam.bind(owner, {
			principalType: 'serviceAccount',
			principalId: account.id,
			roleId: 'deployer',
			scope: { type: 'org' },
		});
		expect(() => core.ctx.serviceAccounts.delete(owner, account.id)).toThrow(/Unbind/);
		expect(core.ctx.serviceAccounts.get(owner, account.id)).toBeDefined();

		core.ctx.iam.unbind(owner, binding.id);
		core.ctx.serviceAccounts.delete(owner, account.id);
		expect(core.ctx.serviceAccounts.list(owner)).toEqual([]);
		expect(() => core.ctx.serviceAccounts.get(owner, account.id)).toThrow(/not found/);
	});

	test('a read-only principal cannot create or delete', () => {
		const owner = principal();
		const account = core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		const viewer = principal({ userId: 'user_2', role: 'viewer' });
		expect(() => core.ctx.serviceAccounts.create(viewer, { name: 'other-bot' })).toThrow(
			ForbiddenError,
		);
		expect(() => core.ctx.serviceAccounts.delete(viewer, account.id)).toThrow(ForbiddenError);
	});
});
