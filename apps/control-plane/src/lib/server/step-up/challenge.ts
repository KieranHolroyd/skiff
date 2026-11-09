import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
	STEP_UP_EMAIL_MAX_ATTEMPTS,
	STEP_UP_EMAIL_PER_HOUR,
	STEP_UP_EMAIL_PER_MINUTE,
	TOTP_PERIOD_SECONDS,
	totpCounter,
} from './policy';

/**
 * Email-code, TOTP and resend state for the step-up plugin (STEP-UP.md §5). Kept out of the
 * Better Auth endpoint definitions so the limits can be unit-tested with a clock and an in-memory
 * database.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_TRACKED_SESSIONS = 10_000;

/** Per-session resend limit: one a minute and five an hour (STEP-UP.md §5). */
export class StepUpResendThrottle {
	private readonly sent = new Map<string, number[]>();
	private readonly perMinute: number;
	private readonly perHour: number;
	private readonly now: () => number;

	constructor(options: { perMinute?: number; perHour?: number; now?: () => number } = {}) {
		this.perMinute = options.perMinute ?? STEP_UP_EMAIL_PER_MINUTE;
		this.perHour = options.perHour ?? STEP_UP_EMAIL_PER_HOUR;
		this.now = options.now ?? Date.now;
	}

	/** True (and counted) when another code may be sent to this session now. */
	take(sessionId: string): boolean {
		const now = this.now();
		const recent = (this.sent.get(sessionId) ?? []).filter((at) => now - at < HOUR_MS);
		const lastMinute = recent.filter((at) => now - at < MINUTE_MS).length;
		if (lastMinute >= this.perMinute || recent.length >= this.perHour) {
			this.sent.set(sessionId, recent);
			return false;
		}
		recent.push(now);
		this.sent.delete(sessionId);
		this.sent.set(sessionId, recent);
		this.prune(now);
		return true;
	}

	forget(sessionId: string): void {
		this.sent.delete(sessionId);
	}

	private prune(now: number): void {
		if (this.sent.size <= MAX_TRACKED_SESSIONS) return;
		for (const [key, times] of this.sent)
			if (times.every((at) => now - at >= HOUR_MS)) this.sent.delete(key);
		for (const key of this.sent.keys()) {
			if (this.sent.size <= MAX_TRACKED_SESSIONS) break;
			this.sent.delete(key);
		}
	}
}

/** A six-digit code, uniformly random (not `Math.random`). */
export function newEmailCode(): string {
	return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Email codes are only stored hashed. The code is short, so this is an equality check, not a KDF. */
export function hashEmailCode(code: string): string {
	return createHash('sha256').update(`yoal-step-up:${code.trim()}`).digest('hex');
}

export function emailCodeMatches(expectedHash: string, code: string): boolean {
	const actual = Buffer.from(hashEmailCode(code), 'hex');
	const expected = Buffer.from(expectedHash, 'hex');
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface EmailChallenge {
	hash: string;
	attempts: number;
	expiresAt: number;
	/** The permission/action the code was requested for, for the email copy and audit. */
	action?: string;
}

export function parseEmailChallenge(value: string): EmailChallenge | null {
	try {
		const parsed = JSON.parse(value) as Partial<EmailChallenge>;
		if (
			typeof parsed?.hash !== 'string' ||
			typeof parsed?.attempts !== 'number' ||
			typeof parsed?.expiresAt !== 'number'
		)
			return null;
		return {
			hash: parsed.hash,
			attempts: parsed.attempts,
			expiresAt: parsed.expiresAt,
			...(typeof parsed.action === 'string' ? { action: parsed.action } : {}),
		};
	} catch {
		return null;
	}
}

/** Can this challenge still be tried? Expired and out-of-attempts codes fail closed. */
export function emailChallengeUsable(challenge: EmailChallenge, now: number = Date.now()): boolean {
	return challenge.expiresAt > now && challenge.attempts < STEP_UP_EMAIL_MAX_ATTEMPTS;
}

/** Identifier for the session-bound email challenge row (`step-up:<sessionId>:email`). */
export function emailIdentifier(sessionId: string): string {
	return `step-up:${sessionId}:email`;
}

/** Identifier for the session-bound WebAuthn challenge row. */
export function passkeyIdentifier(sessionId: string): string {
	return `step-up:${sessionId}:passkey`;
}

/** Identifier for the last accepted TOTP step, so a code cannot be replayed in the window. */
export function totpIdentifier(sessionId: string): string {
	return `step-up:${sessionId}:totp`;
}

// --- TOTP (RFC 6238, SHA-1, six digits, 30 seconds) -------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Better Auth stores imported secrets as `base32:<secret>`; generated ones are raw strings. */
export function totpSecretBytes(secret: string): Buffer {
	if (!secret.startsWith('base32:')) return Buffer.from(secret, 'utf8');
	const encoded = secret.slice('base32:'.length).replace(/=+$/, '').toUpperCase();
	let bits = '';
	for (const char of encoded) {
		const index = BASE32_ALPHABET.indexOf(char);
		if (index < 0) continue;
		bits += index.toString(2).padStart(5, '0');
	}
	const bytes: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
	return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number, digits = 6): string {
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac('sha1', secret).update(message).digest();
	const offset = digest[digest.length - 1]! & 0x0f;
	const value =
		((digest[offset]! & 0x7f) << 24) |
		((digest[offset + 1]! & 0xff) << 16) |
		((digest[offset + 2]! & 0xff) << 8) |
		(digest[offset + 3]! & 0xff);
	return String(value % 10 ** digits).padStart(digits, '0');
}

/**
 * Verify a code and return the matched TOTP step, or null. A one-step window each way tolerates
 * clock drift, the same tolerance Better Auth uses. Comparison is constant-time per candidate.
 */
export function verifyTotpStep(
	secret: string,
	code: string,
	now: number = Date.now(),
	options: { window?: number; periodSeconds?: number; digits?: number } = {},
): number | null {
	const normalized = code.replace(/[\s-]/g, '');
	if (!/^\d{6}$/.test(normalized)) return null;
	const bytes = totpSecretBytes(secret);
	const period = options.periodSeconds ?? TOTP_PERIOD_SECONDS;
	const current = totpCounter(now, period);
	const window = options.window ?? 1;
	let matched: number | null = null;
	for (let offset = -window; offset <= window; offset++) {
		const step = current + offset;
		const expected = Buffer.from(hotp(bytes, step, options.digits ?? 6));
		const actual = Buffer.from(normalized);
		if (expected.length === actual.length && timingSafeEqual(expected, actual) && matched === null)
			matched = step;
	}
	return matched;
}
