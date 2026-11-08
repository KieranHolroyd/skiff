import { describe, expect, test } from 'bun:test';
import {
	evaluateAccessPolicy,
	sha256Hex,
	type AccessPolicyRule,
} from './access-policy.ts';

const rule = (
	idx: number,
	action: 'allow' | 'deny',
	matcher: AccessPolicyRule['matcher'],
): AccessPolicyRule => ({ idx, action, matcher });

const policy = (rules: AccessPolicyRule[], enabled = true) => ({ enabled, rules });

describe('evaluateAccessPolicy', () => {
	test('deny wins over an earlier allow', () => {
		const decision = evaluateAccessPolicy(
			policy([
				rule(0, 'allow', { type: 'anyMember' }),
				rule(1, 'deny', { type: 'email', email: 'contractor@example.com' }),
			]),
			{ member: true, userId: 'user_1', email: 'contractor@example.com' },
		);
		expect(decision).toBe('deny');
	});

	test('evaluates rules by idx, not array order', () => {
		const decision = evaluateAccessPolicy(
			policy([
				rule(2, 'allow', { type: 'emailDomain', domain: 'example.com' }),
				rule(1, 'allow', { type: 'orgGroup', groupId: 'grp_eng' }),
				rule(0, 'deny', { type: 'email', email: 'blocked@example.com' }),
			]),
			{ email: 'dev@example.com', groups: ['grp_eng'] },
		);
		expect(decision).toBe('allow');
	});

	test('matches an email domain case-insensitively', () => {
		expect(
			evaluateAccessPolicy(policy([rule(0, 'allow', { type: 'emailDomain', domain: 'example.com' })]), {
				email: 'Person@Example.COM',
			}),
		).toBe('allow');
		expect(
			evaluateAccessPolicy(policy([rule(0, 'allow', { type: 'emailDomain', domain: 'example.com' })]), {
				email: 'person@other.example',
			}),
		).toBe('deny');
	});

	test('matches a CIDR against the request address', () => {
		const rules = [rule(0, 'allow', { type: 'cidr', cidrs: ['10.0.0.0/8', '192.168.1.0/24'] })];
		expect(evaluateAccessPolicy(policy(rules), {}, { ip: '10.4.5.6' })).toBe('allow');
		expect(evaluateAccessPolicy(policy(rules), {}, { ip: '192.168.1.42' })).toBe('allow');
		expect(evaluateAccessPolicy(policy(rules), {}, { ip: '192.168.2.42' })).toBe('deny');
		expect(evaluateAccessPolicy(policy(rules), {}, { ip: '2001:db8::1' })).toBe('deny');
	});

	test('matches a service token by header hash, never the raw value', () => {
		const token = 'skiff-service-token';
		const rules = [
			rule(0, 'deny', { type: 'serviceToken', header: 'x-skiff-token', tokenHash: sha256Hex('wrong') }),
			rule(1, 'allow', { type: 'serviceToken', header: 'x-skiff-token', tokenHash: sha256Hex(token) }),
		];
		expect(
			evaluateAccessPolicy(policy(rules), {}, { headers: { 'x-skiff-token': token } }),
		).toBe('allow');
		expect(
			evaluateAccessPolicy(policy(rules), {}, { headers: { 'x-skiff-token': 'not-it' } }),
		).toBe('deny');
	});

	test('sends an anonymous visitor to login only when a person could still match', () => {
		expect(
			evaluateAccessPolicy(policy([rule(0, 'allow', { type: 'orgGroup', groupId: 'grp_eng' })]), {}),
		).toBe('login');
		expect(
			evaluateAccessPolicy(policy([rule(0, 'allow', { type: 'cidr', cidrs: ['10.0.0.0/8'] })]), {}),
		).toBe('deny');
	});

	test('defaults to deny for a signed-in visitor with no matching rule', () => {
		expect(
			evaluateAccessPolicy(policy([rule(0, 'allow', { type: 'emailDomain', domain: 'example.com' })]), {
				member: true,
				userId: 'user_1',
				email: 'person@other.test',
			}),
		).toBe('deny');
	});

	test('a disabled policy denies everything', () => {
		expect(
			evaluateAccessPolicy(
				policy([rule(0, 'allow', { type: 'anyMember' })], false),
				{ member: true, userId: 'user_1' },
			),
		).toBe('deny');
	});

	test('user pool groups are an intersection', () => {
		const rules = [
			rule(0, 'allow', { type: 'userPool', poolId: 'pool_1', groups: ['admins', 'staff'] }),
		];
		expect(
			evaluateAccessPolicy(policy(rules), { userPoolId: 'pool_1', poolGroups: ['staff'] }),
		).toBe('allow');
		expect(
			evaluateAccessPolicy(policy(rules), { userPoolId: 'pool_2', poolGroups: ['staff'] }),
		).toBe('deny');
	});

	test('an SSO provider matcher requires that provider', () => {
		const rules = [rule(0, 'allow', { type: 'ssoProvider', providerId: 'sso_okta' })];
		expect(evaluateAccessPolicy(policy(rules), { ssoProviderId: 'sso_okta' })).toBe('allow');
		expect(evaluateAccessPolicy(policy(rules), { ssoProviderId: 'sso_other' })).toBe('deny');
	});
});
