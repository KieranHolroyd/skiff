import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, truncateAll } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import type { AlertMessage } from '../config.ts';
import { createCore, type Core } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';
import { SERVICE_ACCOUNT_UNUSED_DAYS } from '../service-accounts.ts';
import {
	AUTO_ROTATION_PURPOSES,
	KEY_ROTATION_INTERVAL_MS,
	KEY_ROTATION_OVERLAP_MS,
} from './keys.ts';
import { IAM_KEYS_ROTATED_STATE_KEY } from '../maintenance.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-iam-maintenance-'));
const opened = createDb({ path: ':memory:' });

let now = Date.parse('2026-11-08T12:00:00Z');
let core: Core;
let alerts: AlertMessage[] = [];

const capture = {
	name: 'capture',
	async notify(alert: AlertMessage): Promise<void> {
		alerts.push(alert);
	},
};

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
			notifiers: [capture],
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

function addMember(userId: string, role: string): void {
	opened.sqlite.run(
		`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, 'org_1', ?, ?, ?)`,
		[`mem_${userId}`, userId, role, new Date(now).toISOString()],
	);
}

function audit(id: string, action: string, at = now - 60_000): void {
	opened.sqlite.run(
		`INSERT INTO audit_log (id, org_id, actor_type, actor_id, action, resource, result, created_at)
		 VALUES (?, 'org_1', 'user', 'user_1', ?, 'test', 'ok', ?)`,
		[id, action, at],
	);
}

function insertRequest(id: string, createdAt: number, status = 'pending'): void {
	opened.sqlite.run(
		`INSERT INTO access_requests
			(id, org_id, requester_id, role_id, scope_type, scope_id, scope_parent_id, duration_seconds,
			 reason, change_ref, status, decided_by, decided_at, binding_id, created_at)
		 VALUES (?, 'org_1', 'user_3', 'deployer', 'org', NULL, NULL, 600,
			 'Ship the fix', NULL, ?, NULL, NULL, NULL, ?)`,
		[id, status, createdAt],
	);
}

function insertBinding(id = 'bind_1'): void {
	opened.sqlite.run(
		`INSERT INTO iam_bindings
			(id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
			 condition_json, expires_at, reason, created_by, created_at)
		 VALUES (?, 'org_1', 'user', 'user_3', 'deployer', 'org', NULL, NULL,
			 NULL, NULL, NULL, 'user_1', ?)`,
		[id, now],
	);
}

function insertReview(options: {
	id: string;
	defaultDecision: 'keep' | 'revoke';
	dueAt: number | null;
}): void {
	opened.sqlite.run(
		`INSERT INTO access_reviews
			(id, org_id, name, scope_type, scope_id, scope_parent_id, status, default_decision,
			 due_at, created_by, created_at, completed_by, completed_at)
		 VALUES (?, 'org_1', 'Q4 review', 'org', NULL, NULL, 'open', ?, ?, 'user_1', ?, NULL, NULL)`,
		[options.id, options.defaultDecision, options.dueAt, now - 86_400_000],
	);
	opened.sqlite.run(
		`INSERT INTO access_review_items
			(id, review_id, org_id, binding_id, principal_type, principal_id, role_id, role_name,
			 scope_type, scope_id, scope_parent_id, condition_json, expires_at, reviewer_id,
			 decision, decided_by, decided_at, created_at)
		 VALUES (?, ?, 'org_1', 'bind_1', 'user', 'user_3', 'deployer', 'deployer',
			 'org', NULL, NULL, NULL, NULL, 'user_2', NULL, NULL, NULL, ?)`,
		[`rvi_${options.id}`, options.id, now - 86_400_000],
	);
}

function insertServiceAccount(
	id: string,
	createdAt: number,
	disabledAt: number | null = null,
): void {
	opened.sqlite.run(
		`INSERT INTO service_accounts
			(id, org_id, name, description, owner_group_id, disabled_at, created_by, created_at)
		 VALUES (?, 'org_1', ?, '', NULL, ?, 'user_1', ?)`,
		[id, id.replace('sa_', ''), disabledAt, createdAt],
	);
}

function insertAccessKey(id: string, serviceAccountId: string, lastUsedAt: number | null): void {
	opened.sqlite.run(
		`INSERT INTO access_keys
			(id, org_id, principal_type, principal_id, name, prefix, start, hash, restriction_json,
			 allowed_cidrs, expires_at, last_used_at, last_used_ip_hash, created_by, revoked_at, created_at)
		 VALUES (?, 'org_1', 'serviceAccount', ?, 'ci', 'yoal_', 'yoal_abc', ?, '{}', '[]',
			 NULL, ?, NULL, 'user_1', NULL, ?)`,
		[id, serviceAccountId, `hash-${id}`, lastUsedAt, now - 200 * 86_400_000],
	);
}

function usageRows(): Array<{ principal_id: string; permission: string }> {
	return opened.sqlite
		.query<{ principal_id: string; permission: string }, []>(
			'SELECT principal_id, permission FROM iam_permission_usage ORDER BY permission',
		)
		.all();
}

function keyRotationMarker(): number | null {
	const row = opened.sqlite
		.query<{ last_value: string | null }, [string]>(
			'SELECT last_value FROM alert_state WHERE key = ?',
		)
		.get(IAM_KEYS_ROTATED_STATE_KEY);
	return row?.last_value ? Number(row.last_value) : null;
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	truncateAll(opened.sqlite);
	alerts = [];
	opened.sqlite.exec(`
		CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT);
	`);
	addMember('user_1', 'owner');
	addMember('user_2', 'admin');
	addMember('user_3', 'viewer');
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('daily IAM maintenance', () => {
	test('rolls permission usage up once per UTC day and resumes the next day', async () => {
		audit('aud_1', 'project.read');
		const first = await core.maintenance.run();
		expect(first.iam).toMatchObject({ day: '2026-11-08', rolledUp: true });
		expect(usageRows()).toHaveLength(1);

		// A later sweep on the same day does not scan audit_log again.
		audit('aud_2', 'project.update');
		const second = await core.maintenance.run();
		expect(second.iam).toBeUndefined();
		expect(usageRows()).toHaveLength(1);

		now += 86_400_000;
		const third = await core.maintenance.run();
		expect(third.iam).toMatchObject({ day: '2026-11-09', rolledUp: true });
		expect(usageRows()).toHaveLength(2);
	});

	test('expires pending access requests past 24 hours', async () => {
		insertRequest('req_old', now - 24 * 60 * 60 * 1000 - 1);
		insertRequest('req_fresh', now - 60_000);

		const report = await core.maintenance.run();
		expect(report.iam?.requestsExpired).toBe(1);

		const status = (id: string) =>
			opened.sqlite
				.query<{ status: string }, [string]>('SELECT status FROM access_requests WHERE id = ?')
				.get(id)?.status;
		expect(status('req_old')).toBe('expired');
		expect(status('req_fresh')).toBe('pending');
	});

	test('completes an overdue review and applies its default to undecided items', async () => {
		insertBinding();
		insertReview({ id: 'rev_overdue', defaultDecision: 'revoke', dueAt: now - 1 });

		const report = await core.maintenance.run();
		expect(report.iam).toMatchObject({
			reviewsFlagged: 1,
			reviewsCompleted: 1,
		});

		const review = opened.sqlite
			.query<{ status: string; completed_by: string | null }, [string]>(
				'SELECT status, completed_by FROM access_reviews WHERE id = ?',
			)
			.get('rev_overdue');
		expect(review).toEqual({ status: 'completed', completed_by: 'system:iam-maintenance' });

		const item = opened.sqlite
			.query<{ decision: string; decided_by: string }, [string]>(
				'SELECT decision, decided_by FROM access_review_items WHERE review_id = ?',
			)
			.get('rev_overdue');
		expect(item).toEqual({ decision: 'revoke', decided_by: 'system:review-default' });

		expect(
			opened.sqlite.query('SELECT 1 FROM iam_bindings WHERE id = ?').get('bind_1'),
		).toBeFalsy();
		expect(alerts.some((alert) => alert.key.startsWith('iam:review-overdue:'))).toBe(true);
	});

	test('flags unused service accounts from access_keys.last_used_at', async () => {
		insertServiceAccount('sa_old', now - 100 * 86_400_000);
		insertServiceAccount('sa_new', now - 10 * 86_400_000);
		insertServiceAccount('sa_used', now - 200 * 86_400_000);
		insertAccessKey('ak_used', 'sa_used', now - 5 * 86_400_000);

		const views = core.serviceAccounts.list(principal());
		const byId = new Map(views.map((account) => [account.id, account]));
		expect(byId.get('sa_old')).toMatchObject({
			lastUsedAt: null,
			unused: true,
			unusedDays: 100,
		});
		expect(byId.get('sa_new')).toMatchObject({ unused: false, unusedDays: 10 });
		expect(byId.get('sa_used')).toMatchObject({
			lastUsedAt: now - 5 * 86_400_000,
			unused: false,
			unusedDays: 5,
		});

		const unused = core.ctx.governance.unusedServiceAccounts(principal());
		expect(unused.map((account) => account.id)).toEqual(['sa_old']);
		expect(unused[0]!.unusedDays).toBeGreaterThanOrEqual(SERVICE_ACCOUNT_UNUSED_DAYS);

		const report = await core.maintenance.run();
		expect(report.iam).toMatchObject({
			unusedServiceAccounts: 1,
			serviceAccountsDisabled: 0,
		});
		// The org policy is off by default, so the sweep only reports; the row stays enabled.
		expect(
			opened.sqlite
				.query<{ disabled_at: number | null }, [string]>(
					'SELECT disabled_at FROM service_accounts WHERE id = ?',
				)
				.get('sa_old')?.disabled_at,
		).toBeNull();

		const swept = core.serviceAccounts.sweepUnused('org_1', { now, autoDisable: true });
		expect(swept.autoDisabled.map((account) => account.id)).toEqual(['sa_old']);
		expect(
			opened.sqlite
				.query<{ disabled_at: number | null }, [string]>(
					'SELECT disabled_at FROM service_accounts WHERE id = ?',
				)
				.get('sa_old')?.disabled_at,
		).toBe(now);
		// Disabling is the off-switch; rows are never deleted.
		expect(
			opened.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM service_accounts').get()?.n,
		).toBe(3);
	});

	test('auto-disables unused service accounts only when the org policy allows it', async () => {
		insertServiceAccount('sa_old', now - 100 * 86_400_000);

		// Off by default: the sweep reports but leaves the account enabled.
		const first = await core.maintenance.run();
		expect(first.iam).toMatchObject({
			unusedServiceAccounts: 1,
			serviceAccountsDisabled: 0,
		});
		expect(
			opened.sqlite
				.query<{ disabled_at: number | null }, [string]>(
					'SELECT disabled_at FROM service_accounts WHERE id = ?',
				)
				.get('sa_old')?.disabled_at,
		).toBeNull();

		now += 86_400_000;
		core.authPolicy.update(principal(), { autoDisableUnusedServiceAccounts: true });
		const second = await core.maintenance.run();
		expect(second.iam).toMatchObject({
			unusedServiceAccounts: 1,
			serviceAccountsDisabled: 1,
		});
		expect(
			opened.sqlite
				.query<{ disabled_at: number | null }, [string]>(
					'SELECT disabled_at FROM service_accounts WHERE id = ?',
				)
				.get('sa_old')?.disabled_at,
		).toBe(now);
	});
});

describe('monthly signing-key rotation', () => {
	test('ensures keys, records the marker, then publishes and promotes on schedule without touching pools', async () => {
		const pool = await core.ctx.signingKeys.ensure('pool:team-a');
		const first = await core.maintenance.run();
		expect(first.iamKeys).toBeDefined();
		expect(keyRotationMarker()).toBe(now);
		for (const purpose of AUTO_ROTATION_PURPOSES)
			expect(core.ctx.signingKeys.rotationState(purpose).activeActivatedAt).toBe(now);

		// The marker gates a second sweep on the same day.
		const second = await core.maintenance.run();
		expect(second.iamKeys).toBeUndefined();
		expect(core.ctx.signingKeys.list('pool:team-a').map((key) => key.kid)).toEqual([pool.kid]);

		// A month later each automatic purpose gets a next key while the active key keeps signing.
		now += KEY_ROTATION_INTERVAL_MS;
		const third = await core.maintenance.run();
		expect(third.iamKeys?.actions.map((action) => action.action)).toEqual(
			AUTO_ROTATION_PURPOSES.map(() => 'publish-next'),
		);
		for (const purpose of AUTO_ROTATION_PURPOSES) {
			const state = core.ctx.signingKeys.rotationState(purpose);
			expect(state.activeActivatedAt).toBe(now - KEY_ROTATION_INTERVAL_MS);
			expect(state.nextCreatedAt).toBe(now);
		}

		// The following month the published key is promoted and a fresh next is published.
		const before = core.ctx.signingKeys.rotationState('sts');
		now += KEY_ROTATION_INTERVAL_MS;
		const fourth = await core.maintenance.run();
		expect(fourth.iamKeys?.actions.map((action) => action.action)).toEqual(
			AUTO_ROTATION_PURPOSES.map(() => 'promote'),
		);
		const after = core.ctx.signingKeys.rotationState('sts');
		expect(after.activeActivatedAt).toBe(now);
		expect(after.nextCreatedAt).toBe(now);
		expect(after.activeActivatedAt).toBeGreaterThan(before.activeActivatedAt!);
		expect(now - before.nextCreatedAt!).toBeGreaterThanOrEqual(KEY_ROTATION_OVERLAP_MS);

		const sts = core.ctx.signingKeys.list('sts');
		expect(sts.filter((key) => key.state === 'active')).toHaveLength(1);
		expect(sts.filter((key) => key.state === 'next')).toHaveLength(1);
		expect(sts.some((key) => key.state === 'retired')).toBe(true);
		expect(core.ctx.signingKeys.list('pool:team-a').map((key) => key.kid)).toEqual([pool.kid]);
	});
});

describe('IAM notifications', () => {
	test('a request notifies approvers, decisions notify the requester, and a review notifies its reviewer', async () => {
		const requester = principal({ userId: 'user_3', role: 'viewer' });
		const admin = principal({ userId: 'user_2', role: 'admin' });

		const request = core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'project', id: 'prj_1' },
			durationSeconds: 3600,
			reason: 'Ship the fix',
			changeRef: 'INC-42',
		});
		await Promise.resolve();
		const asked = alerts.find((alert) => alert.key === `iam:access-request:${request.id}`);
		expect(asked).toBeDefined();
		expect(asked).toMatchObject({
			title: 'Access request: deployer at project prj_1',
			severity: 'info',
			status: 'firing',
		});
		expect(asked!.detail).toContain('user_3 requested deployer');
		expect(asked!.detail).toContain('Reason: Ship the fix');
		expect(asked!.detail).toContain('Change reference: INC-42');
		expect(asked!.detail).toMatch(/Approvers:.*user_2/);

		const approved = core.ctx.governance.approve(admin, request.id);
		await Promise.resolve();
		const approval = alerts.find((alert) => alert.key === `iam:access-approved:${request.id}`);
		expect(approval).toBeDefined();
		expect(approval!.detail).toContain('user_2 approved user_3');
		expect(approval!.detail).toContain(`expires ${new Date(approved.expiresAt!).toISOString()}`);

		const denied = core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'org' },
			durationSeconds: 600,
			reason: 'Look at production',
		});
		core.ctx.governance.deny(admin, denied.id);
		await Promise.resolve();
		const denial = alerts.find((alert) => alert.key === `iam:access-denied:${denied.id}`);
		expect(denial).toBeDefined();
		expect(denial!.detail).toContain('user_2 denied user_3');
		expect(denial!.severity).toBe('warning');

		const review = core.ctx.governance.startReview(principal(), {
			scope: { type: 'org' },
			name: 'Q4 review',
		});
		await Promise.resolve();
		const started = alerts.find((alert) => alert.key === `iam:review-started:${review.id}`);
		expect(started).toBeDefined();
		expect(started!.detail).toContain('Q4 review');
		expect(started!.detail).toContain('Reviewer: user_2');

		// No IAM notification ever carries a credential or a secret-shaped value.
		for (const alert of alerts.filter((entry) => entry.key.startsWith('iam:'))) {
			expect(JSON.stringify(alert)).not.toMatch(/yoal_|secret|password|token/i);
		}
	});
});
