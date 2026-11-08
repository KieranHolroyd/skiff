import { describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import {
	DEFAULT_FEATURES,
	roles,
	type Permission,
	type Principal,
	type ResourceRef,
} from '@skiff/contracts';

/**
 * The IAM read tools (IAM.md §9.3, §12) against a fake `core`: roles, explain, who-can and service
 * accounts are read-only, and the caller needs `iam:read` or `serviceAccount:read`.
 */

const explains: Array<{ permission: Permission; resource: ResourceRef }> = [];
const whoCans: Array<{ permission: Permission; resource: ResourceRef }> = [];

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
	},
};

mock.module('./core', () => ({ core: fakeCore }));
mock.module('./config', () => ({ authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { skiffToolDefinitions } = await import('./mcp');
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

const IAM_TOOLS = ['list_roles', 'explain_access', 'who_can', 'list_service_accounts'];

async function call(principal: Principal, name: string, args: Record<string, unknown> = {}) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions on a JSON tool result
	return { ok: result.ok, text: result.text, body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null };
}

type Challenge = (context: { authInfo?: { scopes?: string[] } }) => Promise<{ scopes: string[] } | undefined>;

describe('IAM read MCP tools', () => {
	test('are read-only and never offer writes, keys, approvals, SSO or guardrails', () => {
		const definitions = new Map(skiffToolDefinitions(owner).map((entry) => [entry.name, entry]));
		for (const name of IAM_TOOLS) {
			expect(definitions.has(name)).toBe(true);
			expect(definitions.get(name)?.config.annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
			});
		}
		const names = [...definitions.keys()];
		expect(
			names.filter((name) =>
				/^(create_service_account|bind_role|request_access|approve_access|.*guardrail.*|.*sso.*|.*access_key.*)$/.test(name),
			),
		).toEqual([]);
	});

	test('ask the client for iam:read or serviceAccount:read, and nothing when already granted', async () => {
		const definitions = new Map(skiffToolDefinitions(owner).map((entry) => [entry.name, entry]));
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

	test('every IAM read tool refuses a caller without its permission', async () => {
		for (const name of ['list_roles', 'explain_access', 'who_can']) {
			const result = await call(viewer, name, { permission: 'project:read' });
			expect(result.ok).toBe(false);
			expect(result.text).toContain('iam:read');
		}
		const accounts = await call(viewer, 'list_service_accounts');
		expect(accounts.ok).toBe(false);
		expect(accounts.text).toContain('serviceAccount:read');
	});
});
