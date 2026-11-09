import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, deployments, workloads } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { workloadSpecSchema } from '@yoal/contracts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';
import {
	workloadServiceAccountName,
	type WorkloadIdentityService,
} from './workload-identity.ts';

/**
 * Workload identity (docs/IAM.md I18, §7.4). The migration suite is applied by `createDb`; this
 * test exercises the service directly, with a project/deployment/workload row per case.
 */
const dir = mkdtempSync(join(tmpdir(), 'yoal-workload-identity-'));
const opened = createDb({ path: ':memory:' });
let now = Date.parse('2026-11-08T12:00:00Z');
let core: Core;
let sequence = 0;

const principal: Principal = buildPrincipal({
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

function service(): WorkloadIdentityService {
	return core.ctx.workloadIdentity;
}

async function project(slug = 'app') {
	await core.projects.create(principal, {
		name: slug,
		slug,
		runtime: 'process',
		placement: 'auto',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
	return core.projects.requireRow(principal, slug);
}

/** Insert the deployment and workload rows `mint` resolves the environment from. */
function workloadFor(
	row: Awaited<ReturnType<typeof project>>,
	spec: unknown = workloadSpecSchema.parse({ runtime: 'process', command: ['bun', 'run', 'start'] }),
): string {
	sequence += 1;
	const environment = core.ctx.environments.ensureProduction(row);
	const deploymentId = `dep_${sequence}`;
	const workloadId = `wld_${sequence}`;
	opened.db
		.insert(deployments)
		.values({
			id: deploymentId,
			orgId: row.orgId,
			projectId: row.id,
			releaseId: `rel_${sequence}`,
			configSnapshotId: `cfg_${sequence}`,
			shortId: `short${String(sequence).padStart(5, '0')}`,
			environmentId: environment.id,
			runtime: 'process',
			status: 'active',
			previewHost: `${row.slug}-${sequence}.sites.test`,
			createdBy: 'user_1',
			createdAt: now,
		})
		.run();
	opened.db
		.insert(workloads)
		.values({
			id: workloadId,
			orgId: row.orgId,
			projectId: row.id,
			deploymentId,
			runtime: 'process',
			runtimeName: 'process',
			status: 'running',
			specJson: JSON.stringify(spec),
			memoryMb: 256,
			cpus: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return workloadId;
}

function claims(token: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function header(token: string): { alg?: string; kid?: string; typ?: string } {
	return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as {
		alg?: string;
		kid?: string;
		typ?: string;
	};
}

function account(name: string) {
	return opened.sqlite
		.query<{ id: string; name: string; disabled_at: number | null }, [string, string]>(
			'SELECT id, name, disabled_at FROM service_accounts WHERE org_id = ? AND name = ?',
		)
		.get('org_1', name);
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	sequence = 0;
	opened.sqlite.exec(`
		DELETE FROM workloads;
		DELETE FROM deployments;
		DELETE FROM environments;
		DELETE FROM projects;
		DELETE FROM service_accounts;
		DELETE FROM iam_bindings;
		DELETE FROM iam_state;
		DELETE FROM signing_keys;
		DELETE FROM audit_log;
	`);
	core = open();
});

describe('workload identity service accounts', () => {
	test('creates one account per workload, named wl-<project>-<env>, with no bindings', async () => {
		const row = await project('app');
		const first = service().ensure(row.orgId, row.id, 'production');
		expect(first).toMatchObject({ name: 'wl-app-production', disabled_at: null });
		expect(first.id).toMatch(/^sa_/);
		expect(account('wl-app-production')?.id).toBe(first.id);

		// Idempotent: a second deploy reuses the same account.
		expect(service().ensure(row.orgId, row.id, 'production').id).toBe(first.id);
		expect(
			opened.sqlite
				.query<{ n: number }, [string, string]>(
					`SELECT COUNT(*) AS n FROM iam_bindings
					 WHERE principal_type = 'serviceAccount' AND principal_id = ? AND org_id = ?`,
				)
				.get(first.id, 'org_1')!.n,
		).toBe(0);
	});

	test('honours identity.serviceAccount and reuses an existing account of that name', async () => {
		const row = await project('app');
		const existing = core.ctx.serviceAccounts.create(principal, {
			name: 'deployer-bot',
			description: 'Bound by an operator',
		});
		const ensured = service().ensure(row.orgId, row.id, 'staging', 'deployer-bot');
		expect(ensured.id).toBe(existing.id);
		expect(account('deployer-bot')?.id).toBe(existing.id);

		const workload = workloadFor(
			row,
			workloadSpecSchema.parse({
				runtime: 'process',
				command: ['bun', 'run', 'start'],
				identity: { serviceAccount: 'deployer-bot' },
			}),
		);
		const minted = await service().mint(workload, 'yoal');
		expect(minted.serviceAccount).toBe('deployer-bot');
		expect(claims(minted.token).sub).toBe(existing.id);
	});

	test('truncates long project and environment names into a valid slug', () => {
		const name = workloadServiceAccountName('a-very-long-project-name-that-reaches-forty', 'production');
		expect(name.length).toBeLessThanOrEqual(40);
		expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/);
		expect(name.startsWith('wl-')).toBe(true);
		expect(name.endsWith('production')).toBe(true);
		expect(workloadServiceAccountName('app', 'staging')).toBe('wl-app-staging');
	});
});

describe('workload tokens', () => {
	test('mints an ES256 token with the platform issuer, subject, org, project, environment and audience', async () => {
		const row = await project('app');
		const workload = workloadFor(row);
		const minted = await service().mint(workload, 'yoal');
		const payload = claims(minted.token);
		const accountId = service().ensure(row.orgId, row.id, 'production').id;

		expect(header(minted.token)).toMatchObject({ alg: 'ES256', typ: 'JWT' });
		expect(payload).toMatchObject({
			iss: 'https://control.test',
			sub: accountId,
			aud: 'yoal',
			org_id: 'org_1',
			project_id: row.id,
			environment: 'production',
			act: { sub: 'wl:app/production', name: 'wl-app-production' },
		});
		expect(Number(payload.exp) - Number(payload.iat)).toBe(60 * 60);
		expect(payload.iat).toBe(Math.floor(now / 1000));
		await expect(
			core.ctx.signingKeys.verify('workload', minted.token, { audience: 'yoal' }),
		).resolves.toMatchObject({ sub: accountId });
	});

	test('passes any non-Yoal audience through unchanged', async () => {
		const row = await project('app');
		const workload = workloadFor(row);
		const minted = await service().mint(workload, 'sts.amazonaws.com');
		expect(minted.audience).toBe('sts.amazonaws.com');
		expect(claims(minted.token).aud).toBe('sts.amazonaws.com');
		await expect(
			core.ctx.signingKeys.verify('workload', minted.token, { audience: 'sts.amazonaws.com' }),
		).resolves.toBeDefined();
		await expect(
			core.ctx.signingKeys.verify('workload', minted.token, { audience: 'yoal' }),
		).rejects.toThrow(/audience/);
	});

	test('refuses a disabled workload service account', async () => {
		const row = await project('app');
		const workload = workloadFor(row);
		const accountId = service().ensure(row.orgId, row.id, 'production').id;
		opened.sqlite.run('UPDATE service_accounts SET disabled_at = ? WHERE id = ?', [now, accountId]);
		await expect(service().mint(workload, 'yoal')).rejects.toThrow(/disabled/);
	});

	test('rotation moves new tokens to the next key and still verifies the old one', async () => {
		const row = await project('app');
		const workload = workloadFor(row);
		const first = await service().mint(workload, 'yoal');
		const firstKid = header(first.token).kid!;

		// `ensure` created the active key, so the first rotation publishes `next`; the second
		// promotes it. This mirrors the agent flow, which always leaves a `next` published.
		const published = await core.ctx.signingKeys.rotate('workload');
		expect(published.active.kid).toBe(firstKid);
		expect(published.next?.kid).not.toBe(firstKid);
		const rotation = await core.ctx.signingKeys.rotate('workload');
		expect(rotation.active.kid).toBe(published.next!.kid);
		expect(rotation.active.kid).not.toBe(firstKid);

		const second = await service().mint(workload, 'yoal');
		expect(header(second.token).kid).toBe(rotation.active.kid);
		expect(header(second.token).kid).not.toBe(firstKid);

		// Both keys are published and both tokens verify: a refresh and the old file can overlap.
		const jwks = core.ctx.signingKeys.jwks('workload').map((key) => key.kid);
		expect(jwks).toContain(rotation.active.kid);
		expect(jwks).toContain(firstKid);
		await expect(core.ctx.signingKeys.verify('workload', first.token)).resolves.toBeDefined();
		await expect(core.ctx.signingKeys.verify('workload', second.token)).resolves.toBeDefined();
	});
});
