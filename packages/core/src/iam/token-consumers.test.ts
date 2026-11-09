import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { buildPrincipal } from '../orgs.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import {
	principalFromYoalToken,
	restrictionFromClaims,
	serviceAccountPrincipalFromYoalToken,
	yoalTokenIdentity,
	tokenRestrictionAllows,
	verifyYoalToken,
} from './token-consumers.ts';

/**
 * Token consumers (docs/IAM.md §7.3–§7.4). The ring is real: tokens are signed with the `workload`
 * and `sts` purposes, then read back through the same helper the REST/MCP/registry surfaces use.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-token-consumers-'));
const opened = createDb({ path: ':memory:' });
let now = Date.parse('2026-11-08T12:00:00Z');
let core: Core;

const owner: Principal = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
});

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

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM signing_keys;
		DELETE FROM iam_bindings;
		DELETE FROM iam_state;
		DELETE FROM service_accounts;
		INSERT INTO service_accounts
		  (id, org_id, name, description, owner_group_id, disabled_at, created_by, created_at)
		VALUES
		  ('sa_workload', 'org_1', 'wl-app', '', NULL, NULL, 'system:test', ${now}),
		  ('sa_sts', 'org_1', 'ci', '', NULL, NULL, 'system:test', ${now}),
		  ('sa_other', 'org_2', 'other', '', NULL, NULL, 'system:test', ${now});
	`);
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function sign(
	purpose: 'workload' | 'sts',
	claims: Record<string, unknown>,
	ttl = 3600,
	options: { issuer?: string } = {},
): Promise<string> {
	return core.ctx.signingKeys.sign(
		purpose,
		{ sub: 'sa_workload', aud: 'yoal', org_id: 'org_1', ...claims },
		ttl,
		options,
	);
}

describe('verification', () => {
	test('a workload token names a service account and its org', async () => {
		const token = await sign('workload', {
			project_id: 'prj_1',
			environment: 'production',
			act: { sub: 'wl:app/production' },
		});
		const identity = await verifyYoalToken(core.ctx, token);
		expect(identity).toMatchObject({
			kind: 'workload',
			serviceAccountId: 'sa_workload',
			orgId: 'org_1',
		});
		expect(identity?.restriction).toBeUndefined();
		expect(identity?.claims).toMatchObject({ project_id: 'prj_1', environment: 'production' });
	});

	test('an STS token carries its scope and resources as the restriction', async () => {
		const token = await sign('sts', {
			sub: 'sa_sts',
			trust_id: 'ft_1',
			scope: 'image:pull project:read',
			resources: ['repository:acme/shop'],
		});
		const identity = await verifyYoalToken(core.ctx, token);
		expect(identity?.kind).toBe('sts');
		expect(identity?.restriction).toEqual({
			permissions: ['image:pull', 'project:read'],
			resources: ['repository:acme/shop'],
		});
	});

	test('an STS token with the exchange default audience (the platform origin) is accepted', async () => {
		const token = await sign('sts', { sub: 'sa_sts', aud: 'https://control.test' });
		expect((await verifyYoalToken(core.ctx, token))?.kind).toBe('sts');
	});

	test('a token for another purpose, issuer or audience is refused', async () => {
		const wrongAudience = await sign('workload', { aud: 'sts.amazonaws.com' });
		expect(await verifyYoalToken(core.ctx, wrongAudience)).toBeNull();
		// The caller may opt into a cloud audience explicitly.
		expect(
			await verifyYoalToken(core.ctx, wrongAudience, {
				workloadAudiences: ['sts.amazonaws.com'],
			}),
		).not.toBeNull();

		const wrongIssuer = await sign('workload', {}, 3600, { issuer: 'https://evil.test' });
		expect(await verifyYoalToken(core.ctx, wrongIssuer)).toBeNull();

		const registryToken = await core.ctx.signingKeys.sign(
			'registry',
			{ sub: 'sa_workload', aud: 'yoal', org_id: 'org_1' },
			300,
		);
		expect(await verifyYoalToken(core.ctx, registryToken)).toBeNull();
	});

	test('an expired token is refused, with the ring clock', async () => {
		const token = await sign('workload', {}, 60);
		now += 5 * 60_000;
		expect(await verifyYoalToken(core.ctx, token)).toBeNull();
	});

	test('a token whose service account is gone, disabled or in another org is refused', async () => {
		const missing = await sign('workload', { sub: 'sa_missing' });
		expect(await verifyYoalToken(core.ctx, missing)).toBeNull();

		const disabled = await sign('workload', { sub: 'sa_sts' });
		opened.sqlite.run('UPDATE service_accounts SET disabled_at = ? WHERE id = ?', [now, 'sa_sts']);
		expect(await verifyYoalToken(core.ctx, disabled)).toBeNull();

		// A valid signature over an org the account does not belong to is still refused.
		const wrongOrg = await sign('workload', { sub: 'sa_workload', org_id: 'org_2' });
		expect(await verifyYoalToken(core.ctx, wrongOrg)).toBeNull();
	});
});

describe('principals and restrictions', () => {
	test('the pure principal is a service account on the token credential', () => {
		const identity = yoalTokenIdentity('sts', {
			iss: 'https://control.test',
			sub: 'sa_sts',
			aud: 'yoal',
			iat: 1,
			exp: 2,
			org_id: 'org_1',
			scope: 'project:read',
			resources: ['project:prj_1'],
			trust_id: 'ft_1',
		});
		expect(identity).not.toBeNull();
		const principal = principalFromYoalToken(identity!);
		expect(principal).toMatchObject({
			kind: 'serviceAccount',
			userId: 'sa_sts',
			orgId: 'org_1',
			role: 'viewer',
			credential: 'sts',
			restriction: { permissions: ['project:read'], resources: ['project:prj_1'] },
		});
	});

	test('the full principal is the account bindings narrowed by the token scope and resources', () => {
		core.ctx.iam.bind(owner, {
			principalType: 'serviceAccount',
			principalId: 'sa_sts',
			roleId: 'deployer',
			scope: { type: 'org' },
		});
		const identity = yoalTokenIdentity('sts', {
			iss: 'https://control.test',
			sub: 'sa_sts',
			aud: 'yoal',
			iat: 1,
			exp: 2,
			org_id: 'org_1',
			scope: 'project:read',
			resources: ['project:prj_1'],
			trust_id: 'ft_1',
		})!;
		const principal = serviceAccountPrincipalFromYoalToken(core.ctx, identity);
		expect(principal.permissions).toEqual(new Set(['project:read']));
		expect(principal.restriction).toEqual({
			permissions: ['project:read'],
			resources: ['project:prj_1'],
		});
		expect(core.ctx.iam.can(principal, 'project:read', { type: 'project', id: 'prj_1' })).toBe(true);
		expect(core.ctx.iam.can(principal, 'project:read', { type: 'project', id: 'prj_2' })).toBe(false);
		expect(core.ctx.iam.can(principal, 'database:read', { type: 'org' })).toBe(false);
	});

	test('a scope without resources still caps permissions, and unknown permissions are dropped', () => {
		expect(restrictionFromClaims({ scope: 'image:pull nope:thing' })).toEqual({
			permissions: ['image:pull'],
		});
		// A scope that named nothing usable is an empty ceiling, so the token can never widen.
		expect(restrictionFromClaims({ scope: 'nope:thing' })).toEqual({ permissions: [] });
		expect(restrictionFromClaims({ resources: ['repository:acme/shop'] })).toEqual({
			resources: ['repository:acme/shop'],
		});
		expect(restrictionFromClaims({ scope: '', resources: [] })).toBeUndefined();
	});

	test('the registry resource check accepts a name, a row id or a wildcard', () => {
		const restriction = {
			permissions: ['image:pull' as const],
			resources: ['repository:acme/shop'],
		};
		expect(
			tokenRestrictionAllows(restriction, 'image:pull', [
				'repository:acme/shop',
				'repository:rr_1',
			]),
		).toBe(true);
		expect(
			tokenRestrictionAllows(restriction, 'image:pull', ['repository:acme/other']),
		).toBe(false);
		expect(tokenRestrictionAllows(restriction, 'image:push', ['repository:acme/shop'])).toBe(false);
		expect(
			tokenRestrictionAllows({ resources: ['repository:*'] }, 'image:push', [
				'repository:acme/other',
			]),
		).toBe(true);
		expect(
			tokenRestrictionAllows({ resources: ['*:*'] }, 'image:push', [
				'repository:acme/other',
			]),
		).toBe(true);
	});
});
