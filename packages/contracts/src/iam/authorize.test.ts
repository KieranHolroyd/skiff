import { describe, expect, test } from 'bun:test';
import {
	authorize,
	compileGrants,
	ipInCidr,
	scopeContains,
	type Binding,
	type Guardrail,
	type ResourceRef,
} from './authorize.ts';
import type { Permission } from './catalog.ts';

const now = Date.UTC(2026, 10, 8, 12, 0, 0);

function binding(overrides: Partial<Binding> = {}): Binding {
	return {
		id: 'bind_1',
		roleId: 'viewer',
		permissions: ['project:read'],
		scope: { type: 'org' },
		...overrides,
	};
}

function grants(
	bindings: Binding[],
	extra: { guardrails?: Guardrail[]; restriction?: Parameters<typeof compileGrants>[0]['restriction'] } = {},
) {
	return compileGrants({ orgId: 'org_1', bindings, ...extra });
}

function check(
	compiled: ReturnType<typeof grants>,
	resource: ResourceRef,
	permission: Permission = 'project:read',
) {
	return authorize(compiled, { permission, resource, context: { now } });
}

describe('scope nesting', () => {
	const project: ResourceRef = { type: 'project', id: 'prj_1' };
	const environment: ResourceRef = { type: 'environment', id: 'env_1', projectId: 'prj_1' };
	const database: ResourceRef = { type: 'database', id: 'db_1', projectId: 'prj_1', environmentId: 'env_1' };

	test('an org binding covers every org resource', () => {
		const compiled = grants([binding()]);
		expect(check(compiled, { type: 'org' }).allow).toBe(true);
		expect(check(compiled, project).allow).toBe(true);
		expect(check(compiled, environment).allow).toBe(true);
		expect(check(compiled, database).allow).toBe(true);
	});

	test('a project binding covers the project, its environments and their resources', () => {
		const compiled = grants([binding({ scope: { type: 'project', id: 'prj_1' } })]);
		expect(check(compiled, project).allow).toBe(true);
		expect(check(compiled, environment).allow).toBe(true);
		expect(check(compiled, database).allow).toBe(true);
		expect(check(compiled, { type: 'project', id: 'prj_2' }).allow).toBe(false);
		expect(check(compiled, { ...database, projectId: 'prj_2' }).allow).toBe(false);
	});

	test('an environment binding does not widen to the whole project', () => {
		const compiled = grants([
			binding({
				permissions: ['deployment:create'],
				scope: { type: 'environment', projectId: 'prj_1', id: 'env_1' },
			}),
		]);
		expect(check(compiled, environment, 'deployment:create').allow).toBe(true);
		expect(check(compiled, database, 'deployment:create').allow).toBe(true);
		expect(check(compiled, project, 'deployment:create').allow).toBe(false);
		expect(
			check(
				compiled,
				{ type: 'environment', id: 'env_2', projectId: 'prj_1' },
				'deployment:create',
			).allow,
		).toBe(false);
	});

	test('a resource binding covers that row only', () => {
		const compiled = grants([
			binding({ permissions: ['database:read'], scope: { type: 'database', id: 'db_1' } }),
		]);
		expect(check(compiled, { type: 'database', id: 'db_1' }, 'database:read').allow).toBe(true);
		expect(check(compiled, { type: 'database', id: 'db_2' }, 'database:read').allow).toBe(false);
		// An attachment never confers access to the attached resource.
		expect(check(compiled, { type: 'storage', id: 'st_1' }, 'storage:read').allow).toBe(false);
	});

	test('a platform binding never confers org access', () => {
		const compiled = grants([
			binding({ permissions: ['org:read'], scope: { type: 'platform' } }),
		]);
		expect(check(compiled, { type: 'platform' }, 'org:read').allow).toBe(true);
		expect(check(compiled, { type: 'org' }, 'org:read').allow).toBe(false);
		expect(check(compiled, { type: 'project', id: 'prj_1' }, 'org:read').allow).toBe(false);
	});

	test('scopeContains matches the table', () => {
		expect(scopeContains({ type: 'org' }, { type: 'platform' })).toBe(false);
		expect(scopeContains({ type: 'project', id: 'p' }, { type: 'environment', id: 'e', projectId: 'p' })).toBe(true);
		expect(scopeContains({ type: 'environment', projectId: 'p', id: 'e' }, { type: 'container', id: 'c', projectId: 'p', environmentId: 'e' })).toBe(true);
	});
});

describe('the decision', () => {
	test('no binding is a plain deny, not an error', () => {
		const decision = check(grants([]), { type: 'org' });
		expect(decision).toMatchObject({ allow: false, reason: 'no-binding' });
	});

	test('the right binding is reported as the decision source', () => {
		const decision = check(
			grants([
				binding({ id: 'bind_project', scope: { type: 'project', id: 'prj_1' } }),
				binding({ id: 'bind_org', scope: { type: 'org' } }),
			]),
			{ type: 'project', id: 'prj_1' },
		);
		expect(decision).toMatchObject({ allow: true, reason: 'binding', via: 'bind_project' });
	});

	test('an expired binding stops allowing without a sweep', () => {
		const compiled = grants([binding({ expiresAt: now - 1 })]);
		expect(check(compiled, { type: 'org' })).toMatchObject({ allow: false, reason: 'expired' });
		expect(check(grants([binding({ expiresAt: now + 1 })]), { type: 'org' }).allow).toBe(true);
	});

	test('an inherited grant is shown in the chain even when another binding allows', () => {
		const decision = check(
			grants([
				binding({ id: 'bind_scope', scope: { type: 'project', id: 'prj_2' } }),
				binding({ id: 'bind_org', scope: { type: 'org' } }),
			]),
			{ type: 'project', id: 'prj_1' },
		);
		expect(decision.chain).toEqual([
			{ bindingId: 'bind_scope', roleId: 'viewer', scope: { type: 'project', id: 'prj_2' }, outcome: 'scope' },
			{ bindingId: 'bind_org', roleId: 'viewer', scope: { type: 'org' }, outcome: 'allow' },
		]);
	});
});

describe('conditions', () => {
	test('time windows', () => {
		expect(
			check(
				grants([binding({ condition: { op: 'before', at: now + 1 } })]),
				{ type: 'org' },
			).allow,
		).toBe(true);
		expect(
			check(
				grants([binding({ condition: { op: 'before', at: now } })]),
				{ type: 'org' },
			),
		).toMatchObject({ allow: false, reason: 'condition' });
	});

	test('IP allowlists', () => {
		const compiled = grants([binding({ condition: { op: 'ipIn', cidrs: ['10.0.0.0/8'] } })]);
		const inside = authorize(compiled, {
			permission: 'project:read',
			resource: { type: 'org' },
			context: { now, ip: '10.2.3.4' },
		});
		const outside = authorize(compiled, {
			permission: 'project:read',
			resource: { type: 'org' },
			context: { now, ip: '192.168.1.1' },
		});
		expect(inside.allow).toBe(true);
		expect(outside).toMatchObject({ allow: false, reason: 'condition' });
		// No IP at all fails closed.
		expect(check(compiled, { type: 'org' }).allow).toBe(false);
	});

	test('credential and environment restrictions', () => {
		const sessionOnly = grants([
			binding({ condition: { op: 'credentialIn', credentials: ['session'] } }),
		]);
		expect(
			authorize(sessionOnly, {
				permission: 'project:read',
				resource: { type: 'org' },
				context: { now, credential: 'session' },
			}).allow,
		).toBe(true);
		expect(
			authorize(sessionOnly, {
				permission: 'project:read',
				resource: { type: 'org' },
				context: { now, credential: 'apiKey' },
			}).allow,
		).toBe(false);

		const previewOnly = grants([
			binding({
				permissions: ['deployment:create'],
				condition: { op: 'environmentIn', environments: ['preview'] },
			}),
		]);
		expect(
			authorize(previewOnly, {
				permission: 'deployment:create',
				resource: { type: 'project', id: 'prj_1' },
				context: { now, environment: 'preview' },
			}).allow,
		).toBe(true);
		expect(
			authorize(previewOnly, {
				permission: 'deployment:create',
				resource: { type: 'project', id: 'prj_1' },
				context: { now, environment: 'production' },
			}).allow,
		).toBe(false);
	});

	test('fresh auth needs a strong verification inside the window', () => {
		const compiled = grants([binding({ condition: { op: 'freshAuth', class: 'strong' } })]);
		const at = (verification: { class: 'strong' | 'basic'; at: number }, at = now) =>
			authorize(compiled, {
				permission: 'project:read',
				resource: { type: 'org' },
				context: { now: at, verification, freshWindowMs: 60_000 },
			}).allow;
		expect(at({ class: 'strong', at: now - 1_000 })).toBe(true);
		expect(at({ class: 'basic', at: now - 1_000 })).toBe(false);
		expect(at({ class: 'strong', at: now - 60_000 })).toBe(false);
	});

	test('an unknown condition fails closed', () => {
		const compiled = grants([
			binding({ condition: { op: 'weekday' } as unknown as Binding['condition'] }),
		]);
		expect(check(compiled, { type: 'org' })).toMatchObject({ allow: false, reason: 'condition' });
	});
});

describe('restrictions and guardrails', () => {
	test('the credential ceiling narrows a binding', () => {
		const compiled = grants([binding({ permissions: ['project:read', 'deployment:read'] })], {
			restriction: { permissions: ['project:read'] },
		});
		expect(check(compiled, { type: 'org' }, 'project:read').allow).toBe(true);
		expect(check(compiled, { type: 'org' }, 'deployment:read')).toMatchObject({
			allow: false,
			reason: 'restricted',
		});
	});

	test('resource-limited tokens cannot reach other resources', () => {
		const compiled = grants(
			[binding({ permissions: ['database:read'], scope: { type: 'org' } })],
			{ restriction: { resources: ['database:db_1'] } },
		);
		expect(check(compiled, { type: 'database', id: 'db_1' }, 'database:read').allow).toBe(true);
		expect(check(compiled, { type: 'database', id: 'db_2' }, 'database:read')).toMatchObject({
			allow: false,
			reason: 'restricted',
		});
	});

	test('a guardrail beats any allow', () => {
		const compiled = grants([binding()], {
			guardrails: [{ id: 'guard_1', permissions: ['project:*'] }],
		});
		expect(check(compiled, { type: 'org' })).toMatchObject({
			allow: false,
			reason: 'guardrail',
			via: 'guard_1',
		});
	});

	test('a scoped guardrail only denies where it applies', () => {
		const compiled = grants(
			[binding({ permissions: ['deployment:promote'], scope: { type: 'org' } })],
			{
				guardrails: [
					{
						id: 'prod_human',
						permissions: ['deployment:promote'],
						scope: { type: 'environment', projectId: 'prj_1', id: 'env_prod' },
						condition: { op: 'credentialIn', credentials: ['apiKey'] },
					},
				],
			},
		);
		const request = (credential: 'apiKey' | 'session') =>
			authorize(compiled, {
				permission: 'deployment:promote',
				resource: { type: 'environment', id: 'env_prod', projectId: 'prj_1' },
				context: { now, credential },
			});
		expect(request('apiKey')).toMatchObject({ allow: false, reason: 'guardrail' });
		expect(request('session').allow).toBe(true);
	});

	test('guardrails match a resource wildcard and `all`', () => {
		const all = grants([binding()], { guardrails: [{ id: 'g', permissions: ['all'] }] });
		expect(check(all, { type: 'org' })).toMatchObject({ allow: false, reason: 'guardrail' });
	});
});

describe('ipInCidr', () => {
	test('matches IPv4 networks and bare addresses', () => {
		expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
		expect(ipInCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
		expect(ipInCidr('192.168.1.10', '192.168.1.10')).toBe(true);
		expect(ipInCidr('192.168.1.11', '192.168.1.10')).toBe(false);
		expect(ipInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
	});

	test('unparseable input fails closed', () => {
		expect(ipInCidr('::1', '10.0.0.0/8')).toBe(false);
		expect(ipInCidr('10.0.0.1', 'not-a-cidr')).toBe(false);
		expect(ipInCidr('999.0.0.1', '10.0.0.0/8')).toBe(false);
	});
});
