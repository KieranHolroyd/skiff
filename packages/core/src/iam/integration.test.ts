import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import {
	authorize,
	compileGrants,
	type Permission,
	type Principal,
	type ResourceRef,
} from '@skiff/contracts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';
import { groupClaimValues, groupIdsForClaims, verifiedDomainForEmail } from './sso.ts';

/**
 * End-to-end IAM flows across the shipped services. Each test uses its own organisation id and
 * writes at least one role or binding before asking the engine, so no assertion can be satisfied
 * by the legacy "no bindings, version 0" fallback in `IamService`.
 *
 * The HTTP routes are thin wrappers around these services (and the user-pool OAuth routes are a
 * cookie/status-code wrapper around `UserPoolEngineService`), so the flows are exercised through
 * the engine the way a reviewer would: bind, decide, approve, exchange, revoke.
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-iam-integration-'));
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
			objectStore: new LocalObjectStore(
				join(dir, 'objects'),
				'https://control.test',
				'object-secret-123',
			),
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
		userId: 'user_owner',
		orgId: 'org_1',
		role: 'owner',
		...overrides,
	});
}

/** The owner of a flow's own organisation. */
function ownerOf(orgId: string): Principal {
	return principal({ userId: `owner:${orgId}`, orgId, role: 'owner' });
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	// Better Auth owns `user` and `member`; a bare core test has to create them. Everything else
	// below is from the checked-in migrations.
	opened.sqlite.exec(`
		CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY, role TEXT);
		CREATE TABLE IF NOT EXISTS member (
			id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT
		);
		DELETE FROM access_requests;
		DELETE FROM access_keys;
		DELETE FROM service_accounts;
		DELETE FROM iam_bindings;
		DELETE FROM iam_group_members;
		DELETE FROM iam_groups;
		DELETE FROM iam_roles;
		DELETE FROM iam_guardrails;
		DELETE FROM iam_state;
		DELETE FROM member;
		DELETE FROM user;
		DELETE FROM user_pool_codes;
		DELETE FROM user_pool_sessions;
		DELETE FROM user_pool_email_tokens;
		DELETE FROM user_pool_invites;
		DELETE FROM user_pool_users;
		DELETE FROM user_pool_clients;
		DELETE FROM user_pools;
		DELETE FROM signing_keys WHERE purpose LIKE 'pool:%';
	`);
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('project guest and group bindings', () => {
	test('a guest sees only the project they are bound to, and unbinding denies immediately', () => {
		const org = 'org_guest';
		const owner = ownerOf(org);
		const guestId = 'user_guest';
		// A real guest is a member whose org role is `guest` (no org-wide permissions); every
		// permission comes from a project binding.
		opened.sqlite.run(
			`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'guest', ?)`,
			['mem_guest', org, guestId, new Date(now).toISOString()],
		);
		const guest = principal({
			userId: guestId,
			orgId: org,
			role: 'guest',
		});

		const direct = core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: guestId,
			roleId: 'viewer',
			scope: { type: 'project', id: 'prj_alpha' },
			reason: 'Contract reviewer',
		});

		expect(core.ctx.iam.listBindings(org)).toContainEqual(
			expect.objectContaining({
				id: direct.id,
				principalType: 'user',
				principalId: guestId,
				roleId: 'viewer',
				scope: { type: 'project', id: 'prj_alpha' },
			}),
		);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_alpha' })).toBe(true);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_beta' })).toBe(false);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'org' })).toBe(false);
		expect(core.ctx.iam.scopeFilter(guest, 'project:read')).toEqual(new Set(['prj_alpha']));

		// A group binding adds access to a second project.
		const group = core.ctx.iam.createGroup(owner, { name: 'contractors' });
		core.ctx.iam.addGroupMember(owner, group.id, guestId);
		const viaGroup = core.ctx.iam.bind(owner, {
			principalType: 'group',
			principalId: group.id,
			roleId: 'viewer',
			scope: { type: 'project', id: 'prj_beta' },
		});

		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_beta' })).toBe(true);
		expect(core.ctx.iam.scopeFilter(guest, 'project:read')).toEqual(
			new Set(['prj_alpha', 'prj_beta']),
		);

		// Removing the group binding denies the second project immediately.
		core.ctx.iam.unbind(owner, viaGroup.id);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_beta' })).toBe(false);
		expect(core.ctx.iam.scopeFilter(guest, 'project:read')).toEqual(new Set(['prj_alpha']));

		// Removing the direct binding denies the remaining project too.
		core.ctx.iam.unbind(owner, direct.id);
		expect(core.ctx.iam.can(guest, 'project:read', { type: 'project', id: 'prj_alpha' })).toBe(false);
		expect(core.ctx.iam.scopeFilter(guest, 'project:read')).toEqual(new Set());
	});
});

describe('custom role, service account and access key', () => {
	test('a key narrows its account to one permission and one resource, and revoking it stops verification', () => {
		const org = 'org_key';
		const owner = ownerOf(org);
		// Establishes an org binding (and bumps iamVersion) before any decision is asked.
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: owner.userId,
			roleId: 'owner',
			scope: { type: 'org' },
		});

		const role = core.ctx.iam.createRole(owner, {
			name: 'ci-reader',
			permissions: ['project:read', 'project:update'],
		});
		const account = core.ctx.serviceAccounts.create(owner, { name: 'ci-bot' });
		core.ctx.iam.bind(owner, {
			principalType: 'serviceAccount',
			principalId: account.id,
			roleId: role.id,
			scope: { type: 'org' },
		});

		const created = core.ctx.accessKeys.create(owner, {
			principalType: 'serviceAccount',
			principalId: account.id,
			name: 'ci',
			permissions: ['project:read'],
			resources: ['project:prj_alpha'],
		});

		const verified = core.ctx.accessKeys.verify(created.key);
		expect(verified).toEqual({
			orgId: org,
			principalType: 'serviceAccount',
			principalId: account.id,
			permissions: ['project:read'],
			resources: ['project:prj_alpha'],
			keyId: created.accessKey.id,
		});
		expect(verified).toBeDefined();

		// The surface builds the account's principal from its bindings and the key's ceiling.
		const shell = buildPrincipal({
			kind: 'serviceAccount',
			userId: account.id,
			orgId: org,
			role: 'viewer',
		});
		const accountGrants = core.ctx.iam.compiledFor(shell);
		expect(accountGrants.index.get('project:read')).toHaveLength(1);
		expect(accountGrants.index.get('project:update')).toHaveLength(1);

		const ceiling = new Set<Permission>(verified!.permissions ?? []);
		const keyPrincipal: Principal = {
			...shell,
			permissions: new Set(
				[...accountGrants.index.keys()].filter((permission) => ceiling.has(permission)),
			),
			credential: 'apiKey',
			keyId: verified!.keyId,
		};
		expect(keyPrincipal).toMatchObject({
			kind: 'serviceAccount',
			userId: account.id,
			orgId: org,
			credential: 'apiKey',
			keyId: created.accessKey.id,
		});
		expect(keyPrincipal.permissions).toEqual(new Set<Permission>(['project:read']));

		// `Principal` has no resource field, so the resource ceiling is enforced by the engine at
		// the credential boundary. Compose the account's binding with the verified restriction.
		const [accountBinding] = core.ctx.iam
			.listBindings(org)
			.filter((binding) => binding.principalType === 'serviceAccount' && binding.principalId === account.id);
		expect(accountBinding).toBeDefined();
		const restricted = compileGrants({
			orgId: org,
			bindings: [
				{
					id: accountBinding!.id,
					roleId: accountBinding!.roleId,
					permissions: role.permissions,
					scope: accountBinding!.scope,
				},
			],
			restriction: {
				permissions: [...keyPrincipal.permissions],
				resources: verified!.resources,
			},
		});
		const decide = (permission: Permission, resource: ResourceRef) =>
			authorize(restricted, {
				permission,
				resource,
				context: { now, credential: 'apiKey' },
			});

		expect(decide('project:read', { type: 'project', id: 'prj_alpha' })).toMatchObject({
			allow: true,
			reason: 'binding',
		});
		// The resource ceiling refuses a different project even though the account's role covers it.
		expect(decide('project:read', { type: 'project', id: 'prj_beta' })).toMatchObject({
			allow: false,
			reason: 'restricted',
		});
		expect(decide('project:read', { type: 'org' })).toMatchObject({
			allow: false,
			reason: 'restricted',
		});
		// The permission ceiling removes project:update even on the allowed resource.
		expect(decide('project:update', { type: 'project', id: 'prj_alpha' })).toMatchObject({
			allow: false,
			reason: 'restricted',
		});

		const revoked = core.ctx.accessKeys.revoke(owner, created.accessKey.id);
		expect(revoked.revokedAt).toBe(now);
		expect(core.ctx.accessKeys.verify(created.key)).toBeUndefined();
	});
});

describe('just-in-time access', () => {
	test('request → different approver → expiring grant, and self-approval is refused', () => {
		const org = 'org_jit';
		const owner = ownerOf(org);
		const requester = principal({
			userId: 'user_requester',
			orgId: org,
			role: 'viewer',
		});
		const approver = principal({
			userId: 'user_approver',
			orgId: org,
			role: 'admin',
		});

		// The approver needs a real binding at the request scope, not just a role on the principal.
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: approver.userId,
			roleId: 'admin',
			scope: { type: 'org' },
		});

		expect(
			core.ctx.iam.can(requester, 'deployment:promote', { type: 'project', id: 'prj_alpha' }),
		).toBe(false);

		const request = core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'project', id: 'prj_alpha' },
			durationSeconds: 3600,
			reason: 'Ship the fix',
			changeRef: 'INC-42',
		});
		expect(request).toMatchObject({
			status: 'pending',
			requesterId: requester.userId,
			roleId: 'deployer',
			changeRef: 'INC-42',
		});

		const approved = core.ctx.governance.approve(approver, request.id);
		const bindingId = approved.bindingId as unknown as string;
		expect(approved).toMatchObject({
			status: 'approved',
			decidedBy: approver.userId,
			bindingId: expect.stringMatching(/^bind_/),
			expiresAt: now + 3600_000,
		});
		expect(approved.decidedBy).not.toBe(requester.userId);

		const jitBinding = core.ctx.iam
			.listBindings(org)
			.find((binding) => binding.id === bindingId);
		expect(jitBinding).toMatchObject({
			principalType: 'user',
			principalId: requester.userId,
			roleId: 'deployer',
			scope: { type: 'project', id: 'prj_alpha' },
			expiresAt: now + 3600_000,
		});

		expect(
			core.ctx.iam.can(requester, 'deployment:promote', { type: 'project', id: 'prj_alpha' }),
		).toBe(true);

		// The binding is expired exactly at its expiry instant.
		now = approved.expiresAt!;
		expect(
			core.ctx.iam.can(requester, 'deployment:promote', { type: 'project', id: 'prj_alpha' }),
		).toBe(false);
		expect(
			core.ctx.iam.explain(requester, 'deployment:promote', {
				type: 'project',
				id: 'prj_alpha',
			}).reason,
		).toBe('expired');

		// A requester cannot decide their own request, even with a permission that would allow it.
		const selfRequest = core.ctx.governance.request(requester, {
			roleId: 'viewer',
			scope: { type: 'project', id: 'prj_beta' },
			durationSeconds: 600,
			reason: 'Approve myself',
		});
		expect(() => core.ctx.governance.approve(requester, selfRequest.id)).toThrow(ForbiddenError);
		expect(() => core.ctx.governance.approve(requester, selfRequest.id)).toThrow(
			/cannot approve their own/,
		);
		expect(
			core.ctx.governance
				.list(requester, { status: 'pending' })
				.some((entry) => entry.id === selfRequest.id),
		).toBe(true);
	});
});

describe('guardrail template', () => {
	test('a robots template denies a secret permission to a service account while the owner keeps it', () => {
		const org = 'org_guardrail';
		const owner = ownerOf(org);
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: owner.userId,
			roleId: 'owner',
			scope: { type: 'org' },
		});

		const account = core.ctx.serviceAccounts.create(owner, { name: 'secret-reader' });
		core.ctx.iam.bind(owner, {
			principalType: 'serviceAccount',
			principalId: account.id,
			roleId: 'owner',
			scope: { type: 'org' },
		});
		const robot = buildPrincipal({
			kind: 'serviceAccount',
			userId: account.id,
			orgId: org,
			role: 'owner',
		});

		const guardrail = core.ctx.governance.create(owner, {
			template: 'no-secrets-to-robots',
		});
		expect(guardrail.permissions).toContain('database:credentials');
		expect(guardrail.selector.principalTypes).toEqual(
			expect.arrayContaining(['serviceAccount']),
		);

		// The person keeps the permission the machine loses.
		expect(core.ctx.iam.can(owner, 'database:credentials', { type: 'org' })).toBe(true);
		expect(core.ctx.iam.can(robot, 'database:credentials', { type: 'org' })).toBe(false);
		expect(core.ctx.iam.explain(robot, 'database:credentials', { type: 'org' })).toMatchObject({
			allow: false,
			reason: 'guardrail',
			via: guardrail.id,
		});
		// The guardrail is a deny rule, not a blanket removal of the account.
		expect(core.ctx.iam.can(robot, 'database:read', { type: 'org' })).toBe(true);
	});
});

describe('platform IAM', () => {
	test('an admin seeded from a user row, an operator who can drain but not change settings, and an API key refused by D129', () => {
		const org = 'org_platform';
		opened.sqlite.run('INSERT INTO user (id, role) VALUES (?, ?)', ['user_admin', 'admin']);

		expect(core.ctx.platformIam.sync('user_admin')).toEqual({ admin: true, changed: true });
		const seeded = core.ctx.platformIam
			.platformBindings()
			.find((binding) => binding.principalId === 'user_admin' && binding.roleId === 'platform-admin');
		expect(seeded).toMatchObject({
			scope: { type: 'platform' },
			createdBy: 'system:platform-sync',
			condition: { op: 'credentialIn', credentials: ['session'] },
		});

		const sessionAdmin = buildPrincipal({
			kind: 'user',
			userId: 'user_admin',
			orgId: org,
			role: 'owner',
			platformAdmin: true,
		});
		expect(core.ctx.platformIam.can(sessionAdmin, 'platform:nodes')).toBe(true);
		expect(core.ctx.platformIam.canAdminister(sessionAdmin)).toBe(true);

		core.ctx.platformIam.bind(sessionAdmin, {
			userId: 'user_operator',
			roleId: 'platform-operator',
		});
		const operator = buildPrincipal({
			kind: 'user',
			userId: 'user_operator',
			orgId: org,
			role: 'viewer',
			platformAdmin: false,
		});
		expect(core.ctx.platformIam.can(operator, 'platform:drain')).toBe(true);
		expect(core.ctx.platformIam.can(operator, 'platform:settings')).toBe(false);
		expect(core.ctx.platformIam.can(operator, 'platform:domains')).toBe(false);
		expect(core.ctx.platformIam.canAdminister(operator)).toBe(false);

		// The same admin's API key is refused by the credentialIn: ['session'] condition.
		const apiKey = buildPrincipal({
			kind: 'apiKey',
			userId: 'user_admin',
			orgId: org,
			role: 'owner',
			platformAdmin: true,
		});
		expect(apiKey.credential).toBe('apiKey');
		expect(core.ctx.platformIam.can(apiKey, 'platform:nodes')).toBe(false);
		expect(core.ctx.platformIam.can(apiKey, 'platform:read')).toBe(false);
		expect(core.ctx.platformIam.canAdminister(apiKey)).toBe(false);
	});
});

describe('user pool OIDC', () => {
	test('create pool and client, sign up, sign in, exchange a PKCE code and read userinfo', async () => {
		const org = 'org_pool';
		const owner = ownerOf(org);
		// A real org binding keeps the pool and client permission checks off the legacy fallback.
		core.ctx.iam.bind(owner, {
			principalType: 'user',
			principalId: owner.userId,
			roleId: 'owner',
			scope: { type: 'org' },
		});

		const pool = await core.userPools.create(owner, {
			name: 'Checkout',
			signupMode: 'open',
		});
		expect(pool).toMatchObject({
			orgId: org,
			name: 'checkout',
			signupMode: 'open',
			disabled: false,
		});
		expect(pool.issuer).toBe(`https://auth.sites.test/${pool.id}`);

		const client = core.userPools.createClient(owner, pool.id, {
			name: 'web',
			redirectUris: ['https://shop.test/callback'],
			public: true,
		});
		expect(client.client).toMatchObject({
			poolId: pool.id,
			name: 'web',
			public: true,
			redirectUris: ['https://shop.test/callback'],
		});
		expect(client.clientSecret).toBeNull();

		const signUp = await core.userPoolEngine.signUp(
			pool.id,
			'Ada@Example.com',
			'correct horse battery',
			'Ada',
		);
		expect(signUp.user).toMatchObject({
			email: 'ada@example.com',
			name: 'Ada',
			emailVerified: false,
		});

		const signedIn = await core.userPoolEngine.signIn(
			pool.id,
			'ada@example.com',
			'correct horse battery',
		);
		expect(signedIn.user.id).toBe(signUp.user.id);
		expect(core.userPoolEngine.session(pool.id, signedIn.token)?.user.id).toBe(signUp.user.id);

		const codeVerifier = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-._~';
		const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
		const authorized = await core.userPoolEngine.authorize({
			poolId: pool.id,
			clientId: client.client.clientId,
			redirectUri: 'https://shop.test/callback',
			responseType: 'code',
			scope: 'openid profile email',
			state: 'state-123',
			nonce: 'nonce-123',
			codeChallenge,
			codeChallengeMethod: 'S256',
			sessionToken: signedIn.token,
		});
		expect(authorized.needsLogin).toBe(false);

		const callback = new URL(authorized.redirect);
		expect(callback.origin).toBe('https://shop.test');
		expect(callback.pathname).toBe('/callback');
		expect(callback.searchParams.get('state')).toBe('state-123');
		const code = callback.searchParams.get('code');
		expect(code).toBeString();

		const tokens = await core.userPoolEngine.token({
			poolId: pool.id,
			grantType: 'authorization_code',
			clientId: client.client.clientId,
			code: code!,
			redirectUri: 'https://shop.test/callback',
			codeVerifier,
		});
		expect(tokens.token_type).toBe('Bearer');

		const info = await core.userPoolEngine.userinfo(pool.id, tokens.access_token);
		expect(info).toEqual({
			sub: signedIn.user.id,
			email: 'ada@example.com',
			email_verified: false,
			groups: [],
			name: 'Ada',
		});

		// An unregistered redirect is refused before a code is handed to the client.
		await expect(
			core.userPoolEngine.authorize({
				poolId: pool.id,
				clientId: client.client.clientId,
				redirectUri: 'https://evil.test/callback',
				responseType: 'code',
				scope: 'openid',
				codeChallenge,
				codeChallengeMethod: 'S256',
				sessionToken: signedIn.token,
			}),
		).rejects.toBeInstanceOf(ValidationError);
	});
});

describe('SSO domain routing and group claims', () => {
	test('only a verified domain routes an email, and a mapped claim returns the Skiff group', () => {
		const org = 'org_sso';
		const owner = ownerOf(org);
		const group = core.ctx.iam.createGroup(owner, { name: 'engineering' });

		const domains = [
			{ domain: 'example.com', verifiedAt: null, providerId: 'provider-pending' },
			{ domain: 'acme.test', verifiedAt: now, providerId: 'provider-verified' },
		];

		// A pending domain does not route, even though it matches exactly.
		expect(verifiedDomainForEmail('ada@example.com', domains)).toBeNull();
		// A verified domain routes its own address.
		expect(verifiedDomainForEmail('Ada@ACME.test', domains)).toEqual(domains[1]!);
		// Matching is exact, not a suffix: a subdomain is not covered by the parent's row.
		expect(verifiedDomainForEmail('ada@sub.acme.test', domains)).toBeNull();
		expect(verifiedDomainForEmail('ada@evil-acme.test', domains)).toBeNull();

		const claims = groupClaimValues(['Engineering', ' Platform ']);
		expect(claims).toEqual(['engineering', 'platform']);
		const mappings = [{ claimValue: 'Engineering', groupId: group.id }];
		expect(groupIdsForClaims(claims, mappings)).toEqual([group.id]);
		// An unmapped IdP group grants nothing.
		expect(groupIdsForClaims(groupClaimValues(['sales']), mappings)).toEqual([]);
	});
});
