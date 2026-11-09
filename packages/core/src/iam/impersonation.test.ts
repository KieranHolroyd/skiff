import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { ForbiddenError, ValidationError } from '../errors.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-impersonation-'));
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

function principal(overrides: { userId?: string; role?: 'owner' | 'admin' | 'deployer' | 'viewer' } = {}): Principal {
	return buildPrincipal({
		kind: 'user',
		userId: overrides.userId ?? 'user_1',
		orgId: 'org_1',
		role: overrides.role ?? 'owner',
	});
}

beforeEach(() => {
	now = Date.parse('2026-11-09T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM service_accounts;
		DELETE FROM audit_log;
		DELETE FROM signing_keys;
	`);
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('service-account impersonation', () => {
	test('mints an STS token whose claims name the account and the acting user', async () => {
		const owner = principal();
		const account = core.serviceAccounts.create(owner, { name: 'ci-bot' });
		const issued = await core.serviceAccounts.impersonate(owner, account.id, { ttl: 900 });

		expect(issued).toMatchObject({
			tokenType: 'Bearer',
			expiresIn: 900,
			audience: 'https://control.test',
			serviceAccount: { id: account.id, name: 'ci-bot' }
		});

		const claims = await core.ctx.signingKeys.verify('sts', issued.accessToken, {
			audience: 'https://control.test'
		});
		expect(claims).toMatchObject({
			iss: 'https://control.test',
			sub: account.id,
			aud: 'https://control.test',
			org_id: 'org_1',
			impersonated_by: 'user_1',
			act: { iss: 'https://control.test', sub: 'user_1' }
		});
		expect(claims.exp - claims.iat).toBe(900);
	});

	test('defaults to one hour and refuses anything longer', async () => {
		const owner = principal();
		const account = core.serviceAccounts.create(owner, { name: 'ci-bot' });

		const issued = await core.serviceAccounts.impersonate(owner, account.id);
		expect(issued.expiresIn).toBe(3600);

		const error = await core.serviceAccounts
			.impersonate(owner, account.id, { ttl: 3601 })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ValidationError);
		expect((error as ValidationError).message).toMatch(/one hour/);

		expect(() => core.serviceAccounts.impersonate(owner, account.id, { ttl: 0 })).toThrow(
			ValidationError,
		);
	});

	test('the issuance is audited against the account and the person', async () => {
		const owner = principal();
		const account = core.serviceAccounts.create(owner, { name: 'ci-bot' });
		await core.serviceAccounts.impersonate(owner, account.id, { ttl: 600 });

		const row = opened.sqlite
			.query<{ actor_id: string; resource_id: string; args_json: string }, []>(
				"SELECT actor_id, resource_id, args_json FROM audit_log WHERE action = 'service_account.impersonate'",
			)
			.get();
		expect(row).toMatchObject({ actor_id: 'user_1', resource_id: account.id });
		const args = JSON.parse(row!.args_json) as Record<string, unknown>;
		expect(args).toMatchObject({
			name: 'ci-bot',
			ttl: 600,
			actingFor: 'user_1'
		});
	});

	test('a disabled account and a caller without serviceAccount:impersonate are refused', async () => {
		const owner = principal();
		const viewer = principal({ userId: 'user_2', role: 'viewer' });
		const account = core.serviceAccounts.create(owner, { name: 'ci-bot' });

		await expect(core.serviceAccounts.impersonate(viewer, account.id)).rejects.toBeInstanceOf(
			ForbiddenError,
		);

		core.serviceAccounts.update(owner, account.id, { disabled: true });
		await expect(core.serviceAccounts.impersonate(owner, account.id)).rejects.toThrow(
			/disabled/,
		);
	});
});
