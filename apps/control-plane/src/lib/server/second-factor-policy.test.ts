import { describe, expect, test } from 'bun:test';
import {
	authPathAllowedBeforeSecondFactor,
	continueTo,
	factorProvedBy,
	isExemptBeforeSecondFactor,
	secondFactorState,
} from './second-factor-policy';

const owner = { enforce: true, role: 'owner' as const, kind: 'user' as const, sessionFactor: null, hasFactor: true };

describe('secondFactorState', () => {
	test('owners without a proven factor are challenged, or sent to enrol', () => {
		expect(secondFactorState(owner)).toBe('challenge');
		expect(secondFactorState({ ...owner, hasFactor: false })).toBe('enrol');
	});

	test('a proven session is satisfied', () => {
		expect(secondFactorState({ ...owner, sessionFactor: 'passkey' })).toBe('satisfied');
		expect(secondFactorState({ ...owner, sessionFactor: 'totp' })).toBe('satisfied');
	});

	test('other roles, non-session principals and disabled enforcement are unaffected', () => {
		for (const role of ['admin', 'deployer', 'viewer'] as const)
			expect(secondFactorState({ ...owner, role, hasFactor: false })).toBe('satisfied');
		expect(secondFactorState({ ...owner, kind: 'apiKey' })).toBe('satisfied');
		expect(secondFactorState({ ...owner, kind: 'mcp' })).toBe('satisfied');
		expect(secondFactorState({ ...owner, enforce: false })).toBe('satisfied');
		expect(secondFactorState({ ...owner, role: undefined, kind: undefined })).toBe('satisfied');
	});
});

describe('isExemptBeforeSecondFactor', () => {
	test('the challenge page, auth API, sign-in, assets and machine endpoints stay reachable', () => {
		for (const path of ['/two-factor', '/setup', '/api/auth/get-session', '/login', '/_app/immutable/x.js', '/mcp', '/api/agent/heartbeat'])
			expect(isExemptBeforeSecondFactor(path)).toBe(true);
	});

	test('dashboard, REST, consent and CLI approval are gated', () => {
		for (const path of ['/overview', '/settings', '/settings/account', '/api/v1/projects', '/consent', '/cli/login', '/two-factorx', '/setupx', '/_skiff/site-login'])
			expect(isExemptBeforeSecondFactor(path)).toBe(false);
	});
});

describe('authPathAllowedBeforeSecondFactor', () => {
	test('signing in again and verifying a factor are always allowed', () => {
		for (const path of ['/sign-out', '/sign-in/passkey', '/passkey/verify-authentication', '/two-factor/verify-totp', '/two-factor/verify-backup-code'])
			expect(authPathAllowedBeforeSecondFactor(path, true)).toBe(true);
	});

	test('enrolment is allowed only while the owner has no factor', () => {
		for (const path of ['/passkey/generate-register-options', '/passkey/verify-registration', '/two-factor/enable']) {
			expect(authPathAllowedBeforeSecondFactor(path, false)).toBe(true);
			expect(authPathAllowedBeforeSecondFactor(path, true)).toBe(false);
		}
	});

	test('everything that grants access or changes factors waits', () => {
		for (const path of ['/api-key/create', '/organization/invite-member', '/oauth2/authorize', '/oauth2/continue', '/oauth2/consent', '/passkey/delete-passkey', '/two-factor/disable', '/two-factor/generate-backup-codes'])
			expect(authPathAllowedBeforeSecondFactor(path, false)).toBe(false);
	});
});

describe('factorProvedBy', () => {
	test('maps verification endpoints to the factor they prove', () => {
		expect(factorProvedBy('/passkey/verify-authentication')).toBe('passkey');
		expect(factorProvedBy('/passkey/verify-registration')).toBe('passkey');
		expect(factorProvedBy('/two-factor/verify-totp')).toBe('totp');
		expect(factorProvedBy('/two-factor/verify-backup-code')).toBe('backup-code');
		expect(factorProvedBy('/sign-in/social')).toBeUndefined();
	});
});

describe('continueTo', () => {
	const origin = 'https://control.example.com';
	test('keeps same-origin dashboard paths', () => {
		expect(continueTo('/projects/blog?tab=deployments', origin)).toBe('/projects/blog?tab=deployments');
		expect(continueTo('/consent?client_id=x', origin)).toBe('/consent?client_id=x');
		expect(continueTo('/api/auth/oauth2/authorize?client_id=x', origin)).toBe('/api/auth/oauth2/authorize?client_id=x');
	});

	test('refuses off-origin, empty and loop-back targets', () => {
		for (const raw of [null, '', '//evil.com', '/\\evil.com', 'https://evil.com/', '/two-factor', '/login', '/api/auth/x', '/'])
			expect(continueTo(raw, origin)).toBe('/overview');
	});
});
