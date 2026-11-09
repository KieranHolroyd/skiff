import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Permission, Principal } from '@yoal/contracts';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal, type Membership } from '../orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-federation-'));
const opened = createDb({ path: ':memory:' });
let now = Date.parse('2026-11-09T12:00:00Z');
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

function principal(overrides: { userId?: string; orgId?: string; role?: Membership['role'] } = {}): Principal {
	return buildPrincipal({
		kind: 'user',
		userId: overrides.userId ?? 'user_1',
		orgId: overrides.orgId ?? 'org_1',
		role: overrides.role ?? 'owner',
	});
}

function account(owner = principal(), name = 'ci-bot') {
	return core.serviceAccounts.create(owner, { name });
}

beforeEach(() => {
	now = Date.parse('2026-11-09T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM federation_trusts;
		DELETE FROM service_accounts;
		DELETE FROM iam_bindings;
		DELETE FROM iam_groups;
		DELETE FROM iam_roles;
		DELETE FROM iam_state;
	`);
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('federation trusts', () => {
	test('create normalises and list/get return the trust', () => {
		const owner = principal();
		const sa = account(owner);
		const trust = core.federation.create(owner, {
			serviceAccountId: sa.id,
			issuer: ' https://token.actions.githubusercontent.com/ ',
			audiences: ['https://control.test', 'https://control.test'],
			subjectPattern: 'repo:acme/web:ref:refs/heads/*',
			claimConditions: { ref: 'refs/heads/main' },
			maxTtlSeconds: 900,
			restriction: {
				permissions: ['project:read', 'deployment:create'],
				resources: ['project:web']
			}
		});

		expect(trust).toMatchObject({
			orgId: owner.orgId,
			serviceAccountId: sa.id,
			issuer: 'https://token.actions.githubusercontent.com',
			audiences: ['https://control.test'],
			subjectPattern: 'repo:acme/web:ref:refs/heads/*',
			claimConditions: { ref: 'refs/heads/main' },
			maxTtlSeconds: 900,
			restriction: {
				permissions: ['project:read', 'deployment:create'],
				resources: ['project:web']
			}
		});
		expect(trust.id).toMatch(/^ft_/);
		expect(core.federation.list(owner)).toEqual([trust]);
		expect(core.federation.get(owner, trust.id)).toEqual(trust);
	});

	test('defaults are the exchange defaults: any subject, 15 minutes, no restriction', () => {
		const owner = principal();
		const sa = account(owner);
		const trust = core.federation.create(owner, {
			serviceAccountId: sa.id,
			issuer: 'https://gitlab.example.com',
			audiences: ['yoal']
		});
		expect(trust).toMatchObject({
			subjectPattern: '*',
			claimConditions: {},
			maxTtlSeconds: 900,
			restriction: {}
		});
	});

	test('update is partial and delete removes the trust', () => {
		const owner = principal();
		const sa = account(owner);
		const trust = core.federation.create(owner, {
			serviceAccountId: sa.id,
			issuer: 'https://issuer.test',
			audiences: ['https://control.test']
		});

		const updated = core.federation.update(owner, trust.id, {
			subjectPattern: 'repo:acme/**',
			maxTtlSeconds: 60
		});
		expect(updated).toMatchObject({
			issuer: 'https://issuer.test',
			audiences: ['https://control.test'],
			subjectPattern: 'repo:acme/**',
			maxTtlSeconds: 60
		});

		core.federation.delete(owner, trust.id);
		expect(core.federation.list(owner)).toEqual([]);
		expect(() => core.federation.get(owner, trust.id)).toThrow(NotFoundError);
	});

	test('issuer, audience, subject and TTL are validated', () => {
		const owner = principal();
		const sa = account(owner);
		const base = {
			serviceAccountId: sa.id,
			issuer: 'https://issuer.test',
			audiences: ['https://control.test']
		};

		expect(() => core.federation.create(owner, { ...base, issuer: 'not a url' })).toThrow(
			ValidationError,
		);
		expect(() => core.federation.create(owner, { ...base, issuer: 'ftp://issuer.test' })).toThrow(
			ValidationError,
		);
		expect(() => core.federation.create(owner, { ...base, audiences: [] })).toThrow(ValidationError);
		expect(() => core.federation.create(owner, { ...base, audiences: ['  '] })).toThrow(
			ValidationError,
		);
		expect(() => core.federation.create(owner, { ...base, subjectPattern: '  ' })).toThrow(
			ValidationError,
		);
		expect(() => core.federation.create(owner, { ...base, maxTtlSeconds: 3601 })).toThrow(
			/one hour/,
		);
		expect(() => core.federation.create(owner, { ...base, maxTtlSeconds: 0 })).toThrow(
			ValidationError,
		);
		expect(() =>
			core.federation.create(owner, {
				...base,
				restriction: { permissions: ['not:a-permission' as Permission] }
			}),
		).toThrow(ValidationError);
		expect(() =>
			core.federation.create(owner, {
				...base,
				restriction: { resources: ['not a resource'] }
			}),
		).toThrow(ValidationError);
	});

	test('the service account must belong to the caller organisation', () => {
		const owner = principal();
		const other = principal({ userId: 'user_2', orgId: 'org_2' });
		const foreign = account(other, 'other-bot');
		expect(() =>
			core.federation.create(owner, {
				serviceAccountId: foreign.id,
				issuer: 'https://issuer.test',
				audiences: ['yoal']
			}),
		).toThrow(/service account in this organisation/);
	});

	test('a trust is org-scoped: another org cannot read, update or delete it', () => {
		const owner = principal();
		const other = principal({ userId: 'user_2', orgId: 'org_2' });
		const sa = account(owner);
		const trust = core.federation.create(owner, {
			serviceAccountId: sa.id,
			issuer: 'https://issuer.test',
			audiences: ['yoal']
		});

		expect(core.federation.list(other)).toEqual([]);
		expect(() => core.federation.get(other, trust.id)).toThrow(NotFoundError);
		expect(() => core.federation.update(other, trust.id, { maxTtlSeconds: 60 })).toThrow(
			NotFoundError,
		);
		expect(() => core.federation.delete(other, trust.id)).toThrow(NotFoundError);
		expect(core.federation.get(owner, trust.id)).toEqual(trust);
	});

	test('a viewer can neither write nor read; an admin can read', () => {
		const owner = principal();
		const viewer = principal({ userId: 'user_2', role: 'viewer' });
		const admin = principal({ userId: 'user_3', role: 'admin' });
		const sa = account(owner);
		const trust = core.federation.create(owner, {
			serviceAccountId: sa.id,
			issuer: 'https://issuer.test',
			audiences: ['yoal']
		});

		expect(() => core.federation.create(viewer, {
			serviceAccountId: sa.id,
			issuer: 'https://other.test',
			audiences: ['yoal']
		})).toThrow(ForbiddenError);
		expect(() => core.federation.update(viewer, trust.id, { maxTtlSeconds: 60 })).toThrow(
			ForbiddenError,
		);
		expect(() => core.federation.delete(viewer, trust.id)).toThrow(ForbiddenError);
		expect(() => core.federation.list(viewer)).toThrow(ForbiddenError);
		expect(core.federation.list(admin)).toEqual([trust]);
	});
});
