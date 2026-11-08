import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import { ConflictError, ForbiddenError } from '../errors.ts';
import { createCore, type Core } from '../index.ts';
import { REVIEW_SHORTEN_DAYS } from './governance.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-reviews-'));
const opened = createDb({ path: ':memory:' });
const reviewsSql = readFileSync(
	new URL('../../../db/migrations/0090_access_reviews.sql', import.meta.url),
	'utf8',
);

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

function principal(
	overrides: Partial<Parameters<typeof buildPrincipal>[0]> = {},
): Principal {
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

function audit(
	id: string,
	action: string,
	options: {
		actorType?: string;
		actorId?: string | null;
		at?: number;
		orgId?: string | null;
	} = {},
): void {
	opened.sqlite.run(
		`INSERT INTO audit_log (id, org_id, actor_type, actor_id, action, resource, result, created_at)
		VALUES (?, ?, ?, ?, ?, 'test', 'ok', ?)`,
		[
			id,
			options.orgId === undefined ? 'org_1' : options.orgId,
			options.actorType ?? 'user',
			options.actorId === undefined ? 'user_1' : options.actorId,
			action,
			options.at ?? now - 60_000,
		],
	);
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(reviewsSql);
	opened.sqlite.exec(`
		DELETE FROM access_review_items;
		DELETE FROM access_reviews;
		DELETE FROM iam_permission_usage;
		DELETE FROM iam_bindings;
		DELETE FROM iam_group_members;
		DELETE FROM iam_groups;
		DELETE FROM iam_roles;
		DELETE FROM iam_guardrails;
		DELETE FROM iam_state;
		DELETE FROM audit_log;
		CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT, userId TEXT, role TEXT, createdAt TEXT);
		DELETE FROM member;
	`);
	addMember('user_1', 'owner');
	core = open();
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function projectBinding(
	id: string,
	options: { roleId?: string; expiresAt?: number; principalId?: string } = {},
): void {
	opened.sqlite.run(
		`INSERT INTO iam_bindings
			(id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, scope_parent_id,
				condition_json, expires_at, reason, created_by, created_at)
		VALUES (?, 'org_1', 'user', ?, ?, 'project', 'prj_1', NULL, NULL, ?, NULL, 'user_1', ?)`,
		[
			id,
			options.principalId ?? 'user_2',
			options.roleId ?? 'deployer',
			options.expiresAt ?? null,
			now,
		],
	);
}

describe('usage rollup', () => {
	test('aggregates audit rows per principal and permission, and is idempotent', () => {
		audit('aud_1', 'database.credentials', { at: now - 60_000 });
		audit('aud_2', 'database.credentials', { at: now - 120_000 });
		audit('aud_3', 'project.update', { at: now - 300_000 });
		audit('aud_4', 'assistant.chat', { at: now - 60_000 });
		audit('aud_5', 'svc.unknown.action', {
			actorType: 'system',
			actorId: 'sa_1',
			at: now - 200_000,
		});
		audit('aud_6', 'project.read', { at: now - 31 * 24 * 60 * 60 * 1000 });
		audit('aud_7', 'project.read', { actorId: null });

		const first = core.ctx.governance.rollupUsage();
		expect(first.rows).toBe(2);
		expect(first.orgs).toBe(1);

		const rows = opened.sqlite
			.query<
				{
					principal_type: string;
					principal_id: string;
					permission: string;
					last_used_at: number;
					count_30d: number;
				},
				[]
			>(
				`SELECT principal_type, principal_id, permission, last_used_at, count_30d
				FROM iam_permission_usage ORDER BY permission`,
			)
			.all();
		expect(rows).toEqual([
			{
				principal_type: 'user',
				principal_id: 'user_1',
				permission: 'database:credentials',
				last_used_at: now - 60_000,
				count_30d: 2,
			},
			{
				principal_type: 'user',
				principal_id: 'user_1',
				permission: 'project:update',
				last_used_at: now - 300_000,
				count_30d: 1,
			},
		]);
		// The out-of-window and no-actor rows are skipped; service accounts map from `system`.
		expect(rows.some((row) => row.permission === 'project:read')).toBe(false);
		expect(rows.some((row) => row.permission === 'assistant:chat')).toBe(false);

		const second = core.ctx.governance.rollupUsage();
		expect(second.rows).toBe(2);
		expect(
			opened.sqlite
				.query<{ n: number }, []>(
					'SELECT COUNT(*) AS n FROM iam_permission_usage',
				)
				.get()!.n,
		).toBe(2);
	});

	test('maps a service account system actor and drops usage that ages out', () => {
		audit('aud_1', 'service_account.create', {
			actorType: 'system',
			actorId: 'sa_1',
			at: now - 60_000,
		});
		core.ctx.governance.rollupUsage();
		expect(
			core.ctx.governance.usageFor(principal(), { principalId: 'sa_1' }),
		).toEqual([
			expect.objectContaining({
				principalType: 'serviceAccount',
				principalId: 'sa_1',
				permission: 'serviceAccount:create',
				count30d: 1,
			}),
		]);

		now += 31 * 24 * 60 * 60 * 1000;
		core.ctx.governance.rollupUsage();
		expect(core.ctx.governance.usageFor(principal())).toHaveLength(0);
	});

	test('a principal may read their own usage, but not someone else’s', () => {
		addMember('user_2', 'viewer');
		audit('aud_1', 'project.read', { actorId: 'user_2' });
		core.ctx.governance.rollupUsage();

		const viewer = principal({ userId: 'user_2', role: 'viewer' });
		expect(core.ctx.governance.usageFor(viewer)).toHaveLength(1);
		expect(
			core.ctx.governance.usageFor(viewer, { principalId: 'user_2' }),
		).toHaveLength(1);
		expect(() =>
			core.ctx.governance.usageFor(viewer, { principalId: 'user_1' }),
		).toThrow(ForbiddenError);
	});
});

describe('access reviews', () => {
	test('start, decide and complete keep leaves the binding in place', () => {
		projectBinding('bind_1');
		const owner = principal();

		const review = core.ctx.governance.startReview(owner, {
			scope: { type: 'project', id: 'prj_1' },
			name: 'Q4 project review',
		});
		expect(review).toMatchObject({
			name: 'Q4 project review',
			status: 'open',
			defaultDecision: 'keep',
			scope: { type: 'project', id: 'prj_1' },
		});
		expect(review.items).toHaveLength(1);
		expect(review.items[0]).toMatchObject({
			bindingId: 'bind_1',
			principalType: 'user',
			principalId: 'user_2',
			roleId: 'deployer',
			roleName: 'deployer',
			reviewerId: 'user_1',
			decision: null,
		});

		const decided = core.ctx.governance.decideReviewItem(
			owner,
			review.items[0]!.id,
			'keep',
		);
		expect(decided.decision).toBe('keep');
		expect(decided.decidedBy).toBe('user_1');

		const completed = core.ctx.governance.completeReview(owner, review.id);
		expect(completed.status).toBe('completed');
		expect(completed.items[0]!.decision).toBe('keep');
		expect(
			opened.sqlite
				.query('SELECT 1 FROM iam_bindings WHERE id = ?')
				.get('bind_1'),
		).toBeTruthy();

		const actions = opened.sqlite
			.query<{ action: string }, []>(
				`SELECT action FROM audit_log WHERE action LIKE 'iam.review.%' ORDER BY created_at`,
			)
			.all()
			.map((row) => row.action);
		expect(actions).toContain('iam.review.create');
		expect(actions).toContain('iam.review.decide');
		expect(actions).toContain('iam.review.complete');
	});

	test('revoke deletes the binding and shorten caps its expiry at 30 days', () => {
		projectBinding('bind_1');
		projectBinding('bind_2', { principalId: 'user_3' });
		const owner = principal();

		const revoke = core.ctx.governance.startReview(owner, {
			scope: { type: 'project', id: 'prj_1' },
		});
		const revokeItem = revoke.items.find(
			(item) => item.bindingId === 'bind_1',
		)!;
		const shortenItem = revoke.items.find(
			(item) => item.bindingId === 'bind_2',
		)!;
		core.ctx.governance.decideReviewItem(owner, revokeItem.id, 'revoke');
		core.ctx.governance.decideReviewItem(owner, shortenItem.id, 'shorten');
		core.ctx.governance.completeReview(owner, revoke.id);

		expect(
			opened.sqlite
				.query('SELECT 1 FROM iam_bindings WHERE id = ?')
				.get('bind_1'),
		).toBeFalsy();
		const shortened = opened.sqlite
			.query<{ expires_at: number | null }, [string]>(
				'SELECT expires_at FROM iam_bindings WHERE id = ?',
			)
			.get('bind_2');
		expect(shortened?.expires_at).toBe(
			now + REVIEW_SHORTEN_DAYS * 24 * 60 * 60 * 1000,
		);
	});

	test('shorten never extends an expiry that is already sooner', () => {
		const sooner = now + 2 * 24 * 60 * 60 * 1000;
		projectBinding('bind_1', { expiresAt: sooner });
		const owner = principal();

		const review = core.ctx.governance.startReview(owner, {
			scope: { type: 'project', id: 'prj_1' },
		});
		core.ctx.governance.decideReviewItem(owner, review.items[0]!.id, 'shorten');
		core.ctx.governance.completeReview(owner, review.id);

		const binding = opened.sqlite
			.query<{ expires_at: number | null }, [string]>(
				'SELECT expires_at FROM iam_bindings WHERE id = ?',
			)
			.get('bind_1');
		expect(binding?.expires_at).toBe(sooner);
	});

	test('undecided items take the campaign default', () => {
		projectBinding('bind_1');
		const owner = principal();

		const review = core.ctx.governance.startReview(owner, {
			scope: { type: 'project', id: 'prj_1' },
			defaultDecision: 'revoke',
		});
		const completed = core.ctx.governance.completeReview(owner, review.id);

		expect(completed.defaultDecision).toBe('revoke');
		expect(completed.items[0]).toMatchObject({
			decision: 'revoke',
			decidedBy: 'system:review-default',
		});
		expect(
			opened.sqlite
				.query('SELECT 1 FROM iam_bindings WHERE id = ?')
				.get('bind_1'),
		).toBeFalsy();
	});

	test('an org campaign reviews every live binding, including project ones', () => {
		projectBinding('bind_1');
		projectBinding('bind_2', { expiresAt: now - 1 });
		const owner = principal();

		const review = core.ctx.governance.startReview(owner, {
			scope: { type: 'org' },
		});
		expect(review.items.map((item) => item.bindingId)).toContain('bind_1');
		// The expired binding grants nothing and is not part of the review.
		expect(review.items.map((item) => item.bindingId)).not.toContain('bind_2');
	});

	test('starting, deciding and completing require iam:review', () => {
		addMember('user_2', 'viewer');
		projectBinding('bind_1');
		const owner = principal();
		const viewer = principal({ userId: 'user_2', role: 'viewer' });

		expect(() =>
			core.ctx.governance.startReview(viewer, {
				scope: { type: 'project', id: 'prj_1' },
			}),
		).toThrow(ForbiddenError);

		const review = core.ctx.governance.startReview(owner, {
			scope: { type: 'project', id: 'prj_1' },
		});
		expect(() =>
			core.ctx.governance.decideReviewItem(
				viewer,
				review.items[0]!.id,
				'revoke',
			),
		).toThrow(ForbiddenError);
		expect(() => core.ctx.governance.completeReview(viewer, review.id)).toThrow(
			ForbiddenError,
		);
	});

	test('a completed campaign cannot be decided or completed again', () => {
		projectBinding('bind_1');
		const owner = principal();
		const review = core.ctx.governance.startReview(owner, {
			scope: { type: 'project', id: 'prj_1' },
		});
		core.ctx.governance.completeReview(owner, review.id);

		expect(() =>
			core.ctx.governance.decideReviewItem(owner, review.items[0]!.id, 'keep'),
		).toThrow(ConflictError);
		expect(() => core.ctx.governance.completeReview(owner, review.id)).toThrow(
			ConflictError,
		);
	});

	test('an item assigned to a scope manager prefers someone other than the starter', () => {
		addMember('user_2', 'admin');
		projectBinding('bind_1');
		const owner = principal();
		const admin = principal({ userId: 'user_2', role: 'admin' });

		// The admin holds manage-bindings through the org binding; the owner is the starter.
		const review = core.ctx.governance.startReview(owner, {
			scope: { type: 'project', id: 'prj_1' },
		});
		expect(review.items[0]!.reviewerId).toBe('user_2');
	});
});
