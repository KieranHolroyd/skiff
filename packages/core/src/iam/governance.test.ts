import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import type { AlertMessage, Notifier } from '../config.ts';
import { ConflictError, ForbiddenError } from '../errors.ts';
import { createCore, type Core } from '../index.ts';
import { GUARDRAIL_TEMPLATES } from './governance.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-governance-'));
const opened = createDb({ path: ':memory:' });
const accessRequestsSql = readFileSync(
	new URL('../../../db/migrations/0088_access_requests.sql', import.meta.url),
	'utf8'
);

let now = Date.parse('2026-11-08T12:00:00Z');
let core: Core;

function open(notifiers: Notifier[] = []): Core {
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
				'object-secret-123'
			),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.1.0',
			now: () => now,
			notifiers,
		}
	});
}

function principal(overrides: Partial<Parameters<typeof buildPrincipal>[0]> = {}): Principal {
	return buildPrincipal({
		kind: 'user',
		userId: 'user_1',
		orgId: 'org_1',
		role: 'owner',
		...overrides
	});
}

function addMember(userId: string, role: string): void {
	opened.sqlite.run(
		`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, 'org_1', ?, ?, ?)`,
		[`mem_${userId}`, userId, role, new Date(now).toISOString()]
	);
}

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(accessRequestsSql);
	opened.sqlite.exec(`
		DELETE FROM access_requests;
		DELETE FROM iam_bindings;
		DELETE FROM iam_group_members;
		DELETE FROM iam_groups;
		DELETE FROM iam_roles;
		DELETE FROM iam_guardrails;
		DELETE FROM iam_state;
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

describe('guardrail CRUD', () => {
	test('creates, lists, updates and deletes an org guardrail', () => {
		const owner = principal();
		const guardrail = core.ctx.governance.create(owner, {
			name: 'No secrets',
			permissions: ['database:credentials', 'container:exec'],
			selector: { principalTypes: ['serviceAccount'] },
			scope: { type: 'project', id: 'prj_1' }
		});

		expect(guardrail).toMatchObject({
			orgId: 'org_1',
			name: 'No secrets',
			enabled: true,
			scope: { type: 'project', id: 'prj_1' }
		});
		expect(core.ctx.governance.list(owner)).toHaveLength(1);

		const updated = core.ctx.governance.update(owner, guardrail.id, {
			enabled: false,
			permissions: ['database:*']
		});
		expect(updated.enabled).toBe(false);
		expect(updated.permissions).toEqual(['database:*']);

		core.ctx.governance.delete(owner, guardrail.id);
		expect(core.ctx.governance.list(owner)).toHaveLength(0);

		const actions = opened.sqlite
			.query<{ action: string }, []>(
				`SELECT action FROM audit_log WHERE action LIKE 'iam.guardrail.%' ORDER BY created_at`
			)
			.all()
			.map((row) => row.action);
		expect(actions).toContain('iam.guardrail.create');
		expect(actions).toContain('iam.guardrail.update');
		expect(actions).toContain('iam.guardrail.delete');
	});

	test('requires iam:manage-guardrails', () => {
		addMember('user_2', 'admin');
		const admin = principal({ userId: 'user_2', role: 'admin' });
		expect(() =>
			core.ctx.governance.create(admin, {
				name: 'No secrets',
				permissions: ['database:credentials']
			})
		).toThrow(ForbiddenError);
	});
});

describe('guardrail templates', () => {
	test('the robots template expands the catalog and denies credential reveals', () => {
		const owner = principal();
		const guardrail = core.ctx.governance.create(owner, { template: 'no-secrets-to-robots' });

		expect(guardrail.permissions).toContain('database:credentials');
		expect(guardrail.permissions).toContain('storage:credentials');
		expect(guardrail.permissions).toContain('container:exec');
		expect(guardrail.permissions).not.toContain('database:read');
		expect(guardrail.selector.principalTypes).toEqual(['serviceAccount', 'workload', 'job']);
	});

	test('validates permissions, selectors, conditions and scopes', () => {
		const owner = principal();
		expect(() =>
			core.ctx.governance.create(owner, { name: 'Bad', permissions: ['nope:thing'] })
		).toThrow(/not a permission/);
		expect(() => core.ctx.governance.create(owner, { name: 'Empty', permissions: [] })).toThrow(
			/at least one/
		);
		expect(() =>
			core.ctx.governance.create(owner, {
				name: 'Bad condition',
				permissions: ['database:read'],
				condition: { op: 'whenever' } as never
			})
		).toThrow(/not a condition/);
		expect(() =>
			core.ctx.governance.create(owner, {
				name: 'Bad selector',
				permissions: ['database:read'],
				selector: { principalKinds: ['mcp'] } as never
			})
		).toThrow(/not a guardrail selector field/);
		expect(() =>
			core.ctx.governance.create(owner, {
				name: 'Environment',
				permissions: ['database:read'],
				scope: { type: 'environment', id: 'env_1', projectId: 'prj_1' }
			})
		).toThrow(/organisation or a project/);
	});

	test('the office-only template is exposed but refused until the engine can negate a condition', () => {
		expect(GUARDRAIL_TEMPLATES.map((template) => template.key)).toEqual([
			'no-secrets-to-robots',
			'production-needs-a-human',
			'no-destructive-mcp',
			'office-only'
		]);
		expect(GUARDRAIL_TEMPLATES.find((template) => template.key === 'office-only')?.available).toBe(
			false
		);
		expect(() => core.ctx.governance.create(principal(), { template: 'office-only' })).toThrow(
			/negated IP condition/
		);
	});

	test('a template name cannot be duplicated, while a custom one can use another name', () => {
		const owner = principal();
		core.ctx.governance.create(owner, { template: 'no-destructive-mcp' });
		expect(() => core.ctx.governance.create(owner, { template: 'no-destructive-mcp' })).toThrow(
			ConflictError
		);
		const custom = core.ctx.governance.create(owner, {
			name: 'No destructive MCP for one project',
			permissions: ['project:delete'],
			scope: { type: 'project', id: 'prj_1' }
		});
		expect(custom.name).toBe('No destructive MCP for one project');
	});
});

describe('just-in-time access', () => {
	test('request → approve creates an expiring binding and records it', () => {
		addMember('user_2', 'admin');
		addMember('user_3', 'viewer');
		const admin = principal({ userId: 'user_2', role: 'admin' });
		const requester = principal({ userId: 'user_3', role: 'viewer' });

		expect(
			core.ctx.iam.can(requester, 'deployment:promote', {
				type: 'project',
				id: 'prj_1'
			})
		).toBe(false);

		const request = core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'project', id: 'prj_1' },
			durationSeconds: 3600,
			reason: 'Ship the fix',
			changeRef: 'INC-42'
		});
		expect(request).toMatchObject({
			status: 'pending',
			requesterId: 'user_3',
			roleName: 'deployer',
			changeRef: 'INC-42'
		});
		expect(request.canDecide).toBe(false);

		const approved = core.ctx.governance.approve(admin, request.id);
		expect(approved.status).toBe('approved');
		expect(approved.decidedBy).toBe('user_2');
		expect(approved.bindingId).toMatch(/^bind_/);
		expect(approved.expiresAt).toBe(now + 3600_000);

		const binding = opened.sqlite
			.query<
				{ access_request_id: string | null; expires_at: number | null; role_id: string },
				[string]
			>('SELECT access_request_id, expires_at, role_id FROM iam_bindings WHERE id = ?')
			.get(approved.bindingId!);
		expect(binding).toMatchObject({
			access_request_id: request.id,
			expires_at: now + 3600_000,
			role_id: 'deployer'
		});

		expect(
			core.ctx.iam.can(requester, 'deployment:promote', {
				type: 'project',
				id: 'prj_1'
			})
		).toBe(true);

		now += 3600_000;
		expect(
			core.ctx.iam.can(requester, 'deployment:promote', {
				type: 'project',
				id: 'prj_1'
			})
		).toBe(false);

		const actions = opened.sqlite
			.query<{ action: string }, []>(
				`SELECT action FROM audit_log WHERE action LIKE 'access.%' ORDER BY created_at`
			)
			.all()
			.map((row) => row.action);
		expect(actions).toContain('access.request');
		expect(actions).toContain('access.approve');
	});

	test('the requester cannot approve their own request', () => {
		const owner = principal();
		const request = core.ctx.governance.request(owner, {
			roleId: 'deployer',
			scope: { type: 'org' },
			durationSeconds: 600,
			reason: 'Look at production'
		});
		expect(() => core.ctx.governance.approve(owner, request.id)).toThrow(ForbiddenError);
		expect(() => core.ctx.governance.deny(owner, request.id)).toThrow(ForbiddenError);
	});

	test('an approver needs iam:manage-bindings at the request scope', () => {
		addMember('user_2', 'admin');
		addMember('user_3', 'viewer');
		addMember('user_4', 'viewer');
		const admin = principal({ userId: 'user_2', role: 'admin' });
		const requester = principal({ userId: 'user_3', role: 'viewer' });
		const scoped = principal({ userId: 'user_4', role: 'viewer' });

		const role = core.ctx.iam.createRole(admin, {
			name: 'project-admin',
			permissions: ['iam:manage-bindings', 'project:read']
		});
		core.ctx.iam.bind(admin, {
			principalType: 'user',
			principalId: 'user_4',
			roleId: role.id,
			scope: { type: 'project', id: 'prj_1' }
		});
		expect(core.ctx.iam.can(scoped, 'iam:manage-bindings', { type: 'project', id: 'prj_1' })).toBe(
			true
		);

		const request = core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'project', id: 'prj_2' },
			durationSeconds: 600,
			reason: 'Wrong project on purpose'
		});
		expect(() => core.ctx.governance.approve(scoped, request.id)).toThrow(ForbiddenError);
	});

	test('a pending request expires after 24 hours on read and cannot be approved', () => {
		addMember('user_2', 'admin');
		addMember('user_3', 'viewer');
		const admin = principal({ userId: 'user_2', role: 'admin' });
		const requester = principal({ userId: 'user_3', role: 'viewer' });

		const request = core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'org' },
			durationSeconds: 600,
			reason: 'Needs a decision later'
		});

		now += 24 * 60 * 60 * 1000 + 1;
		expect(core.ctx.governance.list(requester, {})[0]?.status).toBe('expired');
		expect(() => core.ctx.governance.approve(admin, request.id)).toThrow(ConflictError);
	});

	test('duration and reason are validated, and a duplicate pending request is refused', () => {
		const requester = principal({ userId: 'user_3', role: 'viewer' });
		expect(() =>
			core.ctx.governance.request(requester, {
				roleId: 'deployer',
				scope: { type: 'org' },
				durationSeconds: 8 * 60 * 60 + 1,
				reason: 'Too long'
			})
		).toThrow(/at most 8 hours/);
		expect(() =>
			core.ctx.governance.request(requester, {
				roleId: 'deployer',
				scope: { type: 'org' },
				durationSeconds: 30,
				reason: 'Too short'
			})
		).toThrow(/at least 60/);
		expect(() =>
			core.ctx.governance.request(requester, {
				roleId: 'deployer',
				scope: { type: 'org' },
				durationSeconds: 600,
				reason: ''
			})
		).toThrow(/reason/);

		core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'org' },
			durationSeconds: 600,
			reason: 'First'
		});
		expect(() =>
			core.ctx.governance.request(requester, {
				roleId: 'deployer',
				scope: { type: 'org' },
				durationSeconds: 900,
				reason: 'Second'
			})
		).toThrow(ConflictError);
	});

	test('deny and cancel finish a request, and cancelling an approved one ends the binding', () => {
		addMember('user_2', 'admin');
		addMember('user_3', 'viewer');
		const admin = principal({ userId: 'user_2', role: 'admin' });
		const requester = principal({ userId: 'user_3', role: 'viewer' });

		const deniedRequest = core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'org' },
			durationSeconds: 600,
			reason: 'Deny me'
		});
		expect(core.ctx.governance.deny(admin, deniedRequest.id).status).toBe('denied');

		const approvedRequest = core.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'org' },
			durationSeconds: 600,
			reason: 'Cancel me'
		});
		const approved = core.ctx.governance.approve(admin, approvedRequest.id);
		expect(core.ctx.governance.cancel(requester, approvedRequest.id).status).toBe('cancelled');
		expect(
			opened.sqlite.query('SELECT 1 FROM iam_bindings WHERE id = ?').get(approved.bindingId!)
		).toBeFalsy();
	});

	test('addresses JIT notifications to approvers and requesters, never to audit args', async () => {
		opened.sqlite.exec(
			'CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT)'
		);
		opened.sqlite.run('DELETE FROM "user"');
		opened.sqlite.run(
			`INSERT INTO "user" (id, email, name) VALUES
			 ('user_1', 'owner@example.com', 'Owner'),
			 ('user_2', 'admin@example.com', 'Admin'),
			 ('user_3', 'requester@example.com', 'Requester')`
		);
		addMember('user_2', 'admin');
		addMember('user_3', 'viewer');

		const targeted: string[] = [];
		const fallback: AlertMessage[] = [];
		const mail: Notifier & {
			notifyTo(to: readonly string[], alert: AlertMessage): Promise<void>;
		} = {
			name: 'email',
			async notify(alert: AlertMessage): Promise<void> {
				fallback.push(alert);
			},
			async notifyTo(to: readonly string[], _alert: AlertMessage): Promise<void> {
				targeted.push(...to);
			},
		};
		const withMail = open([mail]);
		const admin = principal({ userId: 'user_2', role: 'admin' });
		const requester = principal({ userId: 'user_3', role: 'viewer' });

		const request = withMail.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'org' },
			durationSeconds: 600,
			reason: 'Ship the fix'
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Both owners/admins hold iam:manage-bindings at org scope; the requester is excluded.
		expect(targeted.sort()).toEqual(['admin@example.com', 'owner@example.com']);
		expect(fallback).toEqual([]);

		const auditArgs = opened.sqlite
			.query<{ args_json: string }, [string]>(
				`SELECT args_json FROM audit_log WHERE action = 'access.request' AND resource_id = ?`
			)
			.get(request.id)?.args_json;
		expect(auditArgs).toBeDefined();
		expect(auditArgs).not.toContain('@');

		targeted.length = 0;
		withMail.ctx.governance.approve(admin, request.id);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(targeted).toEqual(['requester@example.com']);

		// A person with no resolvable address falls back to the configured channels.
		targeted.length = 0;
		opened.sqlite.run('DELETE FROM "user"');
		const second = withMail.ctx.governance.request(requester, {
			roleId: 'deployer',
			scope: { type: 'org' },
			durationSeconds: 600,
			reason: 'No address on file'
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(targeted).toEqual([]);
		expect(fallback.some((alert) => alert.key === `iam:access-request:${second.id}`)).toBe(true);
	});
});
