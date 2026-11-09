import { describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import {
	DEFAULT_FEATURES,
	roles,
	type Permission,
	type Principal,
	type ResourceRef,
} from '@yoal/contracts';

/**
 * The IAM read tools (IAM.md §9.3, §12) against a fake `core`: roles, explain, who-can and service
 * accounts are read-only, and the caller needs `iam:read` or `serviceAccount:read`.
 */

const explains: Array<{ permission: Permission; resource: ResourceRef }> = [];
const whoCans: Array<{ permission: Permission; resource: ResourceRef }> = [];

interface FakeBindingInput {
	principalType: 'user' | 'group' | 'serviceAccount';
	principalId: string;
	roleId: string;
	scope: ResourceRef;
	expiresAt?: number | null;
	reason?: string;
}

interface FakeRequestInput {
	roleId: string;
	scope: ResourceRef;
	durationSeconds: number;
	reason: string;
	changeRef?: string;
}

const serviceAccountCreates: Array<{ name: string; description?: string; ownerGroupId?: string }> = [];
const binds: FakeBindingInput[] = [];
const unbinds: string[] = [];
const accessRequests: FakeRequestInput[] = [];
const simulations: Array<{ sample: { principalType: string; principalId: string }; change: Record<string, unknown> }> = [];

const fakeCore = {
	ctx: { config: { features: { ...DEFAULT_FEATURES }, platformOrigin: 'https://control.test' } },
	audit: { record: () => {} },
	iam: {
		listRoles: () => [
			{ id: 'owner', name: 'owner', description: 'Everything', permissions: roles.owner, builtIn: true },
			{
				id: 'role_reviewer',
				name: 'reviewer',
				description: 'Read-only access checks',
				permissions: ['project:read', 'iam:read'],
				builtIn: false,
			},
		],
		explain: (_principal: Principal, permission: Permission, resource: ResourceRef) => {
			explains.push({ permission, resource });
			const allow = permission === 'project:read';
			return {
				allow,
				reason: allow ? 'binding' : 'no-binding',
				via: allow ? 'bind_1' : undefined,
				chain: allow
					? [{ bindingId: 'bind_1', roleId: 'viewer', scope: { type: 'org' }, outcome: 'allow' }]
					: [],
			};
		},
		whoCan: (_orgId: string, permission: Permission, resource: ResourceRef) => {
			whoCans.push({ permission, resource });
			return [{ principalType: 'user', principalId: 'user_2', via: 'bind_1' }];
		},
		listBindings: () => [
			{
				id: 'bind_1',
				principalType: 'user',
				principalId: 'user_2',
				roleId: 'viewer',
				roleName: 'viewer',
				scope: { type: 'org' },
				expiresAt: null,
				reason: null,
				createdBy: 'user_1',
				createdAt: 0,
			},
		],
		bind: (principal: Principal, input: FakeBindingInput) => {
			if (!principal.permissions.has('iam:manage-bindings')) throw new Error('Missing permission iam:manage-bindings');
			if (input.scope.type === 'platform') throw new Error('Platform bindings are written by a platform admin, not an org.');
			binds.push(input);
			return {
				id: 'bind_new',
				principalType: input.principalType,
				principalId: input.principalId,
				roleId: input.roleId,
				roleName: input.roleId,
				scope: input.scope,
				expiresAt: input.expiresAt ?? null,
				reason: input.reason ?? null,
				createdBy: principal.userId,
				createdAt: 0,
			};
		},
		unbind: (principal: Principal, bindingId: string) => {
			if (!principal.permissions.has('iam:manage-bindings')) throw new Error('Missing permission iam:manage-bindings');
			if (bindingId === 'bind_platform') throw new Error('A platform binding is removed by a platform admin.');
			unbinds.push(bindingId);
		},
		simulate: (
			principal: Principal,
			draft: { sample: { principalType: string; principalId: string }; change: Record<string, unknown> },
		) => {
			if (!principal.permissions.has('iam:read')) throw new Error('Missing permission iam:read');
			simulations.push(draft);
			const granted = draft.change.kind === 'binding';
			return {
				sample: draft.sample,
				draft: draft.change,
				changes: [
					{
						permission: 'project:read',
						resource: { type: 'project', id: 'prj_1' },
						before: false,
						after: granted,
						change: granted ? 'granted' : 'revoked',
					},
				],
				added: granted ? ['project:read'] : [],
				removed: granted ? [] : ['project:read'],
				applied: false,
			};
		},
	},
	governance: {
		request: (principal: Principal, input: FakeRequestInput) => {
			if (input.scope.type === 'platform') throw new Error('A just-in-time request is for an org resource.');
			accessRequests.push(input);
			return {
				id: 'req_new',
				requesterId: principal.userId,
				roleId: input.roleId,
				roleName: input.roleId,
				scope: input.scope,
				durationSeconds: input.durationSeconds,
				reason: input.reason,
				changeRef: input.changeRef ?? null,
				status: 'pending',
				decidedBy: null,
				decidedAt: null,
				bindingId: null,
				expiresAt: null,
				createdAt: 0,
				requestExpiresAt: 86_400_000,
				canDecide: false,
				canCancel: true,
			};
		},
		approve: () => {
			throw new Error('Approving a request is not exposed over MCP.');
		},
	},
	serviceAccounts: {
		list: (principal: Principal) => {
			if (!principal.permissions.has('serviceAccount:read')) throw new Error('Missing permission serviceAccount:read');
			return [
				{
					id: 'sa_ci',
					name: 'ci',
					description: 'Runs CI',
					ownerGroupId: null,
					disabled: false,
					disabledAt: null,
					createdBy: 'user_1',
					createdAt: 0,
				},
			];
		},
		create: (principal: Principal, input: { name: string; description?: string; ownerGroupId?: string }) => {
			if (!principal.permissions.has('serviceAccount:create'))
				throw new Error('Missing permission serviceAccount:create');
			serviceAccountCreates.push(input);
			return {
				id: 'sa_new',
				name: input.name,
				description: input.description ?? '',
				ownerGroupId: input.ownerGroupId ?? null,
				disabled: false,
				disabledAt: null,
				createdBy: principal.userId,
				createdAt: 0,
				lastUsedAt: null,
				unusedDays: 0,
				unused: false,
			};
		},
	},
	federation: {
		list: (principal: Principal) => {
			if (!principal.permissions.has('federation:read')) throw new Error('Missing permission federation:read');
			return [
				{
					id: 'ft_github',
					orgId: principal.orgId,
					serviceAccountId: 'sa_ci',
					issuer: 'https://token.actions.githubusercontent.com',
					audiences: ['yoal'],
					subjectPattern: 'repo:acme/*',
					claimConditions: {},
					maxTtlSeconds: 900,
					restriction: { permissions: ['project:read'], resources: ['project:prj_1'] },
				},
			];
		},
	},
};

mock.module('./core', () => ({ core: fakeCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions, visibleTools, visibleToolNames } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

const owner: Principal = {
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	permissions: new Set(roles.owner),
};
/** A viewer holds neither iam:read nor serviceAccount:read. */
const viewer: Principal = {
	kind: 'user',
	userId: 'user_2',
	orgId: 'org_1',
	role: 'viewer',
	permissions: new Set(roles.viewer),
};

const IAM_READ_TOOLS = [
	'list_roles',
	'explain_access',
	'who_can',
	'simulate_access',
	'list_service_accounts',
	'list_federation_trusts',
];
const IAM_WRITE_TOOLS = ['create_service_account', 'bind_role', 'request_access', 'unbind_role'];

async function call(principal: Principal, name: string, args: Record<string, unknown> = {}) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions on a JSON tool result
	return { ok: result.ok, text: result.text, body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null };
}

type Challenge = (context: { authInfo?: { scopes?: string[] } }) => Promise<{ scopes: string[] } | undefined>;

describe('IAM read MCP tools', () => {
	test('read tools are read-only and never offer approvals, keys, SSO, guardrails or owner changes', () => {
		const definitions = new Map(yoalToolDefinitions(owner).map((entry) => [entry.name, entry]));
		for (const name of IAM_READ_TOOLS) {
			expect(definitions.has(name)).toBe(true);
			expect(definitions.get(name)?.config.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
			});
		}
		const names = [...definitions.keys()];
		expect(
			names.filter((name) =>
				/^(approve_access|deny_access|approve_access_request|create_access_key|rotate_access_key|create_service_account_key|create_token|mint_token|create_sso_provider|create_scim_token|create_guardrail|transfer_owner|bind_platform_role)$/.test(
					name,
				),
			),
		).toEqual([]);
	});

	test('ask the client for iam:read or serviceAccount:read, and nothing when already granted', async () => {
		const definitions = new Map(yoalToolDefinitions(owner).map((entry) => [entry.name, entry]));
		const iamChallenge = definitions.get('explain_access')?.config.scopeChallenge as Challenge;
		expect(await iamChallenge({ authInfo: { scopes: ['project:read'] }, request: { params: {} } } as never)).toMatchObject({
			scopes: ['project:read', 'iam:read'],
		});
		expect(await iamChallenge({ authInfo: { scopes: ['iam:read'] }, request: { params: {} } } as never)).toBeUndefined();

		const serviceAccountChallenge = definitions.get('list_service_accounts')?.config
			.scopeChallenge as Challenge;
		expect(await serviceAccountChallenge({ authInfo: { scopes: [] }, request: { params: {} } } as never)).toMatchObject({
			scopes: ['serviceAccount:read'],
		});

		const federationChallenge = definitions.get('list_federation_trusts')?.config
			.scopeChallenge as Challenge;
		expect(await federationChallenge({ authInfo: { scopes: [] }, request: { params: {} } } as never)).toMatchObject({
			scopes: ['federation:read'],
		});

		const simulateChallenge = definitions.get('simulate_access')?.config.scopeChallenge as Challenge;
		expect(await simulateChallenge({ authInfo: { scopes: [] }, request: { params: {} } } as never)).toMatchObject({
			scopes: ['iam:read'],
		});
	});

	test('list_roles returns built-in and custom roles with their permissions', async () => {
		const result = await call(owner, 'list_roles');
		expect(result.ok).toBe(true);
		expect(result.body!.roles).toMatchObject([
			{ id: 'owner', builtIn: true },
			{ id: 'role_reviewer', name: 'reviewer', builtIn: false, permissions: ['project:read', 'iam:read'] },
		]);
	});

	test('explain_access explains the caller for a permission and resource', async () => {
		explains.length = 0;
		const result = await call(owner, 'explain_access', {
			permission: 'project:read',
			resource: { type: 'project', id: 'prj_1' },
		});
		expect(result.ok).toBe(true);
		expect(result.body).toMatchObject({
			permission: 'project:read',
			resource: { type: 'project', id: 'prj_1' },
			allow: true,
			reason: 'binding',
			via: 'bind_1',
		});
		expect(result.body!.chain).toEqual([
			{ bindingId: 'bind_1', roleId: 'viewer', scope: { type: 'org' }, outcome: 'allow' },
		]);
		expect(explains).toEqual([
			{ permission: 'project:read', resource: { type: 'project', id: 'prj_1' } },
		]);

		const denied = await call(owner, 'explain_access', { permission: 'deployment:promote' });
		expect(denied.body).toMatchObject({
			permission: 'deployment:promote',
			resource: { type: 'org' },
			allow: false,
			reason: 'no-binding',
			via: null,
			chain: [],
		});
	});

	test('explain_access rejects a permission outside the catalog', async () => {
		const result = await call(owner, 'explain_access', { permission: 'project:teleport' });
		expect(result.ok).toBe(false);
		expect(result.text).toContain('not a permission');
		expect(result.text).toContain('list_roles');
	});

	test('who_can returns each principal with the binding that allows them', async () => {
		whoCans.length = 0;
		const result = await call(owner, 'who_can', {
			permission: 'project:read',
			resource: { type: 'project', id: 'prj_1' },
		});
		expect(result.ok).toBe(true);
		expect(result.body).toMatchObject({
			permission: 'project:read',
			principals: [
				{
					principalType: 'user',
					principalId: 'user_2',
					via: 'bind_1',
					binding: { id: 'bind_1', roleId: 'viewer', scope: { type: 'org' }, expiresAt: null },
				},
			],
		});
		expect(whoCans).toEqual([
			{ permission: 'project:read', resource: { type: 'project', id: 'prj_1' } },
		]);
	});

	test('list_service_accounts returns metadata only', async () => {
		const result = await call(owner, 'list_service_accounts');
		expect(result.ok).toBe(true);
		expect(result.body!.serviceAccounts).toMatchObject([
			{ id: 'sa_ci', name: 'ci', description: 'Runs CI', disabled: false },
		]);
		expect(result.text).not.toContain('secret');
		expect(result.text).not.toContain('accessKey');
	});

	test('list_federation_trusts returns trust metadata and no secret', async () => {
		const result = await call(owner, 'list_federation_trusts');
		expect(result.ok).toBe(true);
		expect(result.body!.federationTrusts).toMatchObject([
			{
				id: 'ft_github',
				serviceAccountId: 'sa_ci',
				issuer: 'https://token.actions.githubusercontent.com',
				audiences: ['yoal'],
			},
		]);
		expect(result.text).not.toContain('secret');
	});

	test('simulate_access dry-runs a binding and reports the diff without saving', async () => {
		simulations.length = 0;
		const result = await call(owner, 'simulate_access', {
			principalType: 'user',
			principalId: 'user_2',
			kind: 'binding',
			roleId: 'viewer',
			scope: { type: 'project', id: 'prj_1' },
		});
		expect(result.ok).toBe(true);
		expect(result.body).toMatchObject({
			sample: { principalType: 'user', principalId: 'user_2' },
			draft: { kind: 'binding', roleId: 'viewer', scope: { type: 'project', id: 'prj_1' } },
			applied: false,
			added: ['project:read'],
			removed: [],
		});
		expect(result.body!.changes).toMatchObject([
			{
				permission: 'project:read',
				resource: { type: 'project', id: 'prj_1' },
				before: false,
				after: true,
				change: 'granted',
			},
		]);
		expect(simulations).toHaveLength(1);

		// A role edit maps to the service's role draft and still never writes.
		const role = await call(owner, 'simulate_access', {
			principalType: 'user',
			principalId: 'user_2',
			kind: 'role',
			roleId: 'role_reviewer',
			permissions: ['project:read'],
		});
		expect(role.ok).toBe(true);
		expect(role.body).toMatchObject({
			draft: { kind: 'role', roleId: 'role_reviewer', permissions: ['project:read'] },
			applied: false,
			removed: ['project:read'],
		});

		// A platform draft fails the same way a platform binding write would.
		const platform = await call(owner, 'simulate_access', {
			principalType: 'user',
			principalId: 'user_2',
			kind: 'binding',
			roleId: 'viewer',
			scope: { type: 'platform' },
		});
		expect(platform.ok).toBe(false);
		expect(platform.text).toContain('platform');
	});

	test('every IAM read tool is omitted for a caller without its permission', () => {
		// Read tools are filtered too (IAM.md §12): a client never sees an action it cannot use.
		const names = new Set(assistantTools(viewer).map((tool) => tool.name));
		for (const name of [
			'list_roles',
			'explain_access',
			'who_can',
			'simulate_access',
			'list_service_accounts',
			'list_federation_trusts',
		])
			expect(names.has(name)).toBe(false);
	});
});

describe('IAM write MCP tools', () => {
	test('the chat confirms every IAM write and hides it from a read-only user', () => {
		const definitions = new Map(yoalToolDefinitions(owner).map((entry) => [entry.name, entry]));
		for (const name of IAM_WRITE_TOOLS) {
			expect(definitions.has(name)).toBe(true);
			expect(definitions.get(name)?.config.annotations).toMatchObject({ readOnlyHint: false });
		}
		expect(definitions.get('unbind_role')?.config.annotations).toMatchObject({
			destructiveHint: true,
			idempotentHint: true,
		});
		for (const name of ['create_service_account', 'bind_role', 'request_access'])
			expect(definitions.get(name)?.config.annotations).toMatchObject({ destructiveHint: false });

		const assistant = new Map(assistantTools(owner).map((entry) => [entry.name, entry]));
		for (const name of ['create_service_account', 'bind_role', 'unbind_role'])
			expect(assistant.get(name)?.destructive).toBe(true);
		// Asking for access is not a grant: it still reaches the chat without a click.
		expect(assistant.get('request_access')?.destructive).toBe(false);

		const readOnly = new Set(assistantTools(viewer).map((entry) => entry.name));
		for (const name of ['create_service_account', 'bind_role', 'unbind_role'])
			expect(readOnly.has(name)).toBe(false);
		// Reads with iam:read stay available to an org reader.
		const reader: Principal = {
			kind: 'user',
			userId: 'user_3',
			orgId: 'org_1',
			role: 'viewer',
			permissions: new Set(roles.viewer).add('iam:read'),
		};
		const readerTools = new Set(assistantTools(reader).map((entry) => entry.name));
		expect(readerTools.has('explain_access')).toBe(true);
		expect(readerTools.has('simulate_access')).toBe(true);
		expect(readerTools.has('bind_role')).toBe(false);
	});

	test('ask for serviceAccount:create or iam:manage-bindings; requesting access needs no extra scope', async () => {
		const definitions = new Map(yoalToolDefinitions(owner).map((entry) => [entry.name, entry]));
		const serviceAccount = definitions.get('create_service_account')?.config.scopeChallenge as Challenge;
		expect(await serviceAccount({ authInfo: { scopes: [] }, request: { params: {} } } as never)).toMatchObject({
			scopes: ['serviceAccount:create'],
		});

		for (const name of ['bind_role', 'unbind_role']) {
			const challenge = definitions.get(name)?.config.scopeChallenge as Challenge;
			expect(await challenge({ authInfo: { scopes: ['iam:read'] }, request: { params: {} } } as never)).toMatchObject({
				scopes: ['iam:read', 'iam:manage-bindings'],
			});
			expect(
				await challenge({
					authInfo: { scopes: ['iam:manage-bindings'] },
					request: { params: {} },
				} as never),
			).toBeUndefined();
		}

		// Anyone in the org may ask; the service decides, and approval is a human action.
		expect(definitions.get('request_access')?.config.scopeChallenge).toBeUndefined();
	});

	test('create_service_account returns metadata and never a key', async () => {
		serviceAccountCreates.length = 0;
		const result = await call(owner, 'create_service_account', {
			name: 'deploy-bot',
			description: 'Deploys from CI',
			ownerGroupId: 'grp_1',
		});
		expect(result.ok).toBe(true);
		expect(result.body).toMatchObject({
			id: 'sa_new',
			name: 'deploy-bot',
			description: 'Deploys from CI',
			ownerGroupId: 'grp_1',
			disabled: false,
		});
		expect(result.text).not.toMatch(/secret|accessKey|privateKey|token/i);
		expect(serviceAccountCreates).toEqual([
			{ name: 'deploy-bot', description: 'Deploys from CI', ownerGroupId: 'grp_1' },
		]);
	});

	test('bind_role returns the binding and refuses platform scope', async () => {
		binds.length = 0;
		const result = await call(owner, 'bind_role', {
			principalType: 'serviceAccount',
			principalId: 'sa_new',
			roleId: 'viewer',
			scope: { type: 'project', id: 'prj_1' },
			expiresAt: 1_893_456_000_000,
			reason: 'CI deploy',
		});
		expect(result.ok).toBe(true);
		expect(result.body).toMatchObject({
			id: 'bind_new',
			principalType: 'serviceAccount',
			principalId: 'sa_new',
			roleId: 'viewer',
			scope: { type: 'project', id: 'prj_1' },
			expiresAt: 1_893_456_000_000,
			reason: 'CI deploy',
		});
		expect(binds).toEqual([
			{
				principalType: 'serviceAccount',
				principalId: 'sa_new',
				roleId: 'viewer',
				scope: { type: 'project', id: 'prj_1' },
				expiresAt: 1_893_456_000_000,
				reason: 'CI deploy',
			},
		]);

		const before = binds.length;
		const refused = await call(owner, 'bind_role', {
			principalType: 'user',
			principalId: 'user_2',
			roleId: 'owner',
			scope: { type: 'platform' },
		});
		expect(refused.ok).toBe(false);
		expect(refused.text).toContain('platform');
		expect(binds.length).toBe(before);
	});

	test('request_access creates a pending request and never decides it', async () => {
		accessRequests.length = 0;
		const result = await call(owner, 'request_access', {
			role: 'viewer',
			scope: { type: 'project', id: 'prj_1' },
			duration: 3600,
			reason: 'Deploy the fix',
			changeRef: 'INC-123',
		});
		expect(result.ok).toBe(true);
		expect(result.body).toMatchObject({
			id: 'req_new',
			status: 'pending',
			roleId: 'viewer',
			durationSeconds: 3600,
			changeRef: 'INC-123',
			canDecide: false,
		});
		expect(result.text).toContain('pending');
		expect(result.text).toContain('cannot approve');
		expect(accessRequests).toEqual([
			{
				roleId: 'viewer',
				scope: { type: 'project', id: 'prj_1' },
				durationSeconds: 3600,
				reason: 'Deploy the fix',
				changeRef: 'INC-123',
			},
		]);

		// Any org member may ask, including a viewer; the request is still only pending.
		const byViewer = await call(viewer, 'request_access', {
			role: 'viewer',
			duration: 60,
			reason: 'Look at the access list',
		});
		expect(byViewer.ok).toBe(true);
		expect(byViewer.body).toMatchObject({ status: 'pending', canDecide: false });

		expect(accessRequests.at(-1)).toEqual({
			roleId: 'viewer',
			scope: { type: 'org' },
			durationSeconds: 60,
			reason: 'Look at the access list',
		});
	});

	test('request_access refuses a platform scope and an out-of-range duration', async () => {
		const before = accessRequests.length;
		const platform = await call(owner, 'request_access', {
			role: 'viewer',
			scope: { type: 'platform' },
			duration: 60,
			reason: 'Try platform',
		});
		expect(platform.ok).toBe(false);
		expect(platform.text).toContain('platform');

		const tooLong = await call(owner, 'request_access', {
			role: 'viewer',
			duration: 8 * 60 * 60 + 1,
			reason: 'All day',
		});
		expect(tooLong.ok).toBe(false);
		expect(tooLong.text).toContain('duration');
		expect(accessRequests.length).toBe(before);
	});

	test('unbind_role removes the binding by id (confirmed before the handler runs)', async () => {
		unbinds.length = 0;
		const result = await call(owner, 'unbind_role', { bindingId: 'bind_1' });
		expect(result.ok).toBe(true);
		expect(result.body).toEqual({ ok: true, bindingId: 'bind_1' });
		expect(unbinds).toEqual(['bind_1']);
	});

	test('write tools refuse a caller without their permission', async () => {
		const missing: Array<[string, Record<string, unknown>, string]> = [
			['create_service_account', { name: 'ci-bot' }, 'serviceAccount:create'],
			[
				'bind_role',
				{ principalType: 'user', principalId: 'user_2', roleId: 'viewer' },
				'iam:manage-bindings',
			],
			['unbind_role', { bindingId: 'bind_1' }, 'iam:manage-bindings'],
		];
		for (const [name, , permission] of missing) {
			// The assistant filters writes the caller cannot perform, so the refusal is absence.
			expect(assistantTools(viewer).some((tool) => tool.name === name)).toBe(false);
			expect(permission.length).toBeGreaterThan(0);
		}
	});

	test('never offers approvals, keys, tokens, SSO/SCIM, guardrails, owner changes or platform bindings', () => {
		const names = yoalToolDefinitions(owner).map((entry) => entry.name);
		const forbidden = [
			'approve_access',
			'deny_access',
			'approve_access_request',
			'cancel_access_request',
			'create_access_key',
			'rotate_access_key',
			'create_service_account_key',
			'create_token',
			'mint_token',
			'create_sso_provider',
			'create_scim_token',
			'create_guardrail',
			'update_guardrail',
			'delete_guardrail',
			'transfer_owner',
			'change_owner',
			'bind_platform_role',
			'bind_platform_binding',
		];
		for (const name of forbidden) expect(names).not.toContain(name);
		expect(
			names.filter((name) =>
				/guardrail|(^|_)sso($|_)|(^|_)scim($|_)|access_key|service_account_key|(^|_)token($|_)|(^|_)approve($|_)|(^|_)deny($|_)|(^|_)owner($|_)|platform.*bind|bind.*platform/.test(
					name,
				),
			),
		).toEqual([]);
	});
});

describe('scope-filtered tools/list (IAM.md §12)', () => {
	test('an owner sees write and read tools; a viewer sees only what its grants allow', () => {
		const ownerTools = new Set(visibleTools(owner).map((tool) => tool.name));
		expect(ownerTools.has('create_project')).toBe(true);
		expect(ownerTools.has('delete_database')).toBe(true);
		expect(ownerTools.has('list_projects')).toBe(true);
		expect(ownerTools.has('list_service_accounts')).toBe(true);

		const viewerTools = new Set(visibleTools(viewer).map((tool) => tool.name));
		// Reads the viewer role has stay: the filter covers reads as well as writes.
		expect(viewerTools.has('list_projects')).toBe(true);
		expect(viewerTools.has('get_project')).toBe(true);
		expect(viewerTools.has('list_databases')).toBe(true);
		expect(viewerTools.has('whoami')).toBe(true);
		expect(viewerTools.has('search_docs')).toBe(true);
		// Writes and grants the viewer does not have disappear, read tools included.
		expect(viewerTools.has('create_project')).toBe(false);
		expect(viewerTools.has('delete_database')).toBe(false);
		expect(viewerTools.has('bind_role')).toBe(false);
		expect(viewerTools.has('list_roles')).toBe(false);
		expect(viewerTools.has('list_service_accounts')).toBe(false);
	});

	test('a read grant keeps its read tool visible without exposing IAM writes', () => {
		const reader: Principal = {
			kind: 'user',
			userId: 'user_4',
			orgId: 'org_1',
			role: 'viewer',
			permissions: new Set(roles.viewer).add('iam:read'),
		};
		const names = new Set(visibleTools(reader).map((tool) => tool.name));
		expect(names.has('explain_access')).toBe(true);
		expect(names.has('who_can')).toBe(true);
		expect(names.has('bind_role')).toBe(false);
		expect(names.has('unbind_role')).toBe(false);
		// Same helper as the assistant catalog and the MCP handler.
		expect(visibleToolNames(reader)).toEqual(names);
	});
});
