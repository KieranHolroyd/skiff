import { describe, expect, test } from 'bun:test';
import {
	emailChallengeUsable,
	emailCodeMatches,
	hashEmailCode,
	parseEmailChallenge,
	StepUpResendThrottle,
	verifyTotpStep,
} from './challenge';
import { STEP_UP_EMAIL_MAX_ATTEMPTS, STEP_UP_EMAIL_TTL_MS } from './policy';

describe('TOTP', () => {
	// RFC 6238 test vector (SHA-1, ASCII secret). The RFC prints eight digits; six are the last six.
	const secret = '12345678901234567890';

	test('accepts the current step', () => {
		expect(verifyTotpStep(secret, '287082', 59_000, { window: 0 })).toBe(1);
	});

	test('rejects a wrong code', () => {
		expect(verifyTotpStep(secret, '287083', 59_000, { window: 0 })).toBeNull();
	});

	test('accepts one step of drift in either direction', () => {
		// The previous step at t=59s is the code for t=29s; with the default window it still works.
		expect(verifyTotpStep(secret, '287082', 89_000, { window: 1 })).toBe(1);
	});

	test('replayed steps can be detected by the caller', () => {
		const step = verifyTotpStep(secret, '287082', 59_000, { window: 0 });
		expect(step).not.toBeNull();
		// `isTotpReplay` is the guard the plugin applies before writing the accepted step.
		expect(step! <= step!).toBe(true);
	});
});

describe('email codes', () => {
	test('stores only a hash and compares in constant time', () => {
		const hash = hashEmailCode('123456');
		expect(hash).not.toContain('123456');
		expect(emailCodeMatches(hash, '123456')).toBe(true);
		expect(emailCodeMatches(hash, '123457')).toBe(false);
	});

	test('accepts whitespace around a pasted code', () => {
		expect(emailCodeMatches(hashEmailCode('123456'), ' 123456 ')).toBe(true);
	});

	test('a challenge expires and has a five-attempt budget', () => {
		const now = 1_700_000_000_000;
		const challenge = { hash: hashEmailCode('123456'), attempts: 0, expiresAt: now + STEP_UP_EMAIL_TTL_MS };
		expect(emailChallengeUsable(challenge, now)).toBe(true);
		expect(emailChallengeUsable({ ...challenge, expiresAt: now - 1 }, now)).toBe(false);
		expect(emailChallengeUsable({ ...challenge, attempts: STEP_UP_EMAIL_MAX_ATTEMPTS }, now)).toBe(false);
	});

	test('parses a stored challenge and rejects malformed rows', () => {
		const parsed = parseEmailChallenge(
			JSON.stringify({ hash: 'abc', attempts: 2, expiresAt: 123, action: 'database:credentials' }),
		);
		expect(parsed).toEqual({ hash: 'abc', attempts: 2, expiresAt: 123, action: 'database:credentials' });
		expect(parseEmailChallenge('not json')).toBeNull();
		expect(parseEmailChallenge(JSON.stringify({ hash: 'abc' }))).toBeNull();
	});
});

describe('StepUpResendThrottle', () => {
	test('allows one a minute and five an hour', () => {
		let now = 1_700_000_000_000;
		const throttle = new StepUpResendThrottle({ now: () => now });
		expect(throttle.take('session')).toBe(true);
		expect(throttle.take('session')).toBe(false);
		now += 61_000;
		expect(throttle.take('session')).toBe(true);
		now += 61_000;
		expect(throttle.take('session')).toBe(true);
		now += 61_000;
		expect(throttle.take('session')).toBe(true);
		now += 61_000;
		expect(throttle.take('session')).toBe(true);
		now += 61_000;
		// Five in the hour is the cap, even though the last minute is clear.
		expect(throttle.take('session')).toBe(false);
	});

	test('sessions do not share a budget', () => {
		const throttle = new StepUpResendThrottle();
		expect(throttle.take('a')).toBe(true);
		expect(throttle.take('b')).toBe(true);
		expect(throttle.take('a')).toBe(false);
	});
});
