import { describe, expect, test } from 'bun:test';
import {
	chooseMethods,
	freshUntil,
	isTotpReplay,
	isVerificationFresh,
	maskEmail,
	methodAllowed,
	methodClass,
	minutesLeft,
} from './policy';

const none = { passkey: false, totp: false, password: false, email: false };

describe('chooseMethods', () => {
	test('a passkey is preferred, with TOTP and backup codes as same-class alternatives', () => {
		const choice = chooseMethods({ ...none, passkey: true, totp: true, password: true, email: true });
		expect(choice).toMatchObject({
			preferred: 'passkey',
			alternatives: ['totp', 'backup-code'],
			class: 'strong',
		});
		expect(choice.methods).toEqual(['passkey', 'totp', 'backup-code']);
	});

	test('a passkey-only account gets no weaker alternative', () => {
		const choice = chooseMethods({ ...none, passkey: true, password: true, email: true });
		expect(choice.preferred).toBe('passkey');
		expect(choice.alternatives).toEqual([]);
		expect(choice.methods).not.toContain('password');
		expect(choice.methods).not.toContain('email');
	});

	test('TOTP only: TOTP wins, backup code is the alternative', () => {
		const choice = chooseMethods({ ...none, totp: true });
		expect(choice.preferred).toBe('totp');
		expect(choice.alternatives).toEqual(['backup-code']);
		expect(choice.class).toBe('strong');
	});

	test('any strong factor removes password and email from the list', () => {
		const choice = chooseMethods({ ...none, totp: true, password: true, email: true });
		expect(choice.methods).toEqual(['totp', 'backup-code']);
		expect(methodAllowed(choice, 'password')).toBe(false);
		expect(methodAllowed(choice, 'email')).toBe(false);
	});

	test('no strong factor: password first, email under another way', () => {
		const choice = chooseMethods({ ...none, password: true, email: true });
		expect(choice).toMatchObject({ preferred: 'password', alternatives: ['email'], class: 'basic' });
	});

	test('no strong factor and no password: email is the preferred basic method', () => {
		const choice = chooseMethods({ ...none, email: true });
		expect(choice).toMatchObject({ preferred: 'email', alternatives: [], class: 'basic' });
	});

	test('password only stays basic', () => {
		const choice = chooseMethods({ ...none, password: true });
		expect(choice).toMatchObject({ preferred: 'password', alternatives: [], class: 'basic' });
	});

	test('no usable method returns an empty choice', () => {
		const choice = chooseMethods(none);
		expect(choice).toEqual({ preferred: null, alternatives: [], class: 'basic', methods: [] });
	});

	test('method classes rank backup codes with the strong factors', () => {
		expect(methodClass('passkey')).toBe('strong');
		expect(methodClass('totp')).toBe('strong');
		expect(methodClass('backup-code')).toBe('strong');
		expect(methodClass('password')).toBe('basic');
		expect(methodClass('email')).toBe('basic');
	});
});

describe('freshness', () => {
	const now = 1_700_000_000_000;
	const window = 30 * 60 * 1000;

	test('a recent strong verification is fresh for a strong account', () => {
		expect(
			isVerificationFresh({ at: now - 60_000, class: 'strong', strongest: 'strong' }, now, window),
		).toBe(true);
	});

	test('the window is fixed: exactly 30 minutes old is not fresh', () => {
		expect(
			isVerificationFresh({ at: now - window, class: 'strong', strongest: 'strong' }, now, window),
		).toBe(false);
	});

	test('a basic verification does not satisfy a strong account', () => {
		expect(
			isVerificationFresh({ at: now - 60_000, class: 'basic', strongest: 'strong' }, now, window),
		).toBe(false);
	});

	test('a strong verification satisfies a basic account', () => {
		expect(
			isVerificationFresh({ at: now - 60_000, class: 'strong', strongest: 'basic' }, now, window),
		).toBe(true);
	});

	test('freshUntil is the fixed end of the window, and minutesLeft rounds up', () => {
		const at = now - 5 * 60_000;
		expect(freshUntil({ at }, window)).toBe(at + window);
		expect(minutesLeft(at + window, now)).toBe(25);
	});
});

describe('replay and masking', () => {
	test('a TOTP step can be accepted once, and a later step is still accepted', () => {
		expect(isTotpReplay(null, 100)).toBe(false);
		expect(isTotpReplay(100, 100)).toBe(true);
		expect(isTotpReplay(100, 99)).toBe(true);
		expect(isTotpReplay(100, 101)).toBe(false);
	});

	test('email masking leaves enough to recognise the address', () => {
		expect(maskEmail('alice@example.com')).toBe('a•••e@example.com');
		expect(maskEmail('ab@example.com')).toBe('a•@example.com');
		expect(maskEmail(null)).toBeNull();
	});
});
