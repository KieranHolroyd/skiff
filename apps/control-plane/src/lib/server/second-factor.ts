import { readMembership } from '@yoal/core';
import { devPasswordLogin } from './config';
import { sqlite } from './db';
import { membershipRoleIn } from './org-membership';
import { MAX_SECOND_FACTOR_FAILURES, type SecondFactor } from './second-factor-policy';

/**
 * Wiring for the owner second-factor policy (see `second-factor-policy.ts` for the rules).
 *
 * Enforcement is on by default. `YOAL_OWNER_2FA=0` turns it off; when unset it is also off in
 * dev password-login mode (never available in production), so local development and the e2e suites
 * can sign in headlessly.
 */
export const enforceOwnerSecondFactor =
	process.env.YOAL_OWNER_2FA !== undefined ? process.env.YOAL_OWNER_2FA === '1' : !devPasswordLogin;

/** Whether the user has any second factor enrolled: a passkey or a verified authenticator app. */
export function userHasSecondFactor(userId: string): boolean {
	try {
		const row = sqlite
			.query<{ totp: number | null; passkeys: number }, [string, string]>(
				`SELECT (SELECT twoFactorEnabled FROM user WHERE id = ?) AS totp,
				        (SELECT count(*) FROM passkey WHERE userId = ?) AS passkeys`
			)
			.get(userId, userId);
		return Boolean(row?.totp) || (row?.passkeys ?? 0) > 0;
	} catch {
		return false; // auth tables not migrated yet
	}
}

/** Whether the user has a password (a Better Auth `credential` account with a hash). */
export function userHasPassword(userId: string): boolean {
	try {
		return Boolean(
			sqlite
				.query<{ id: string }, [string]>(
					"SELECT id FROM account WHERE userId = ? AND providerId = 'credential' AND password IS NOT NULL LIMIT 1"
				)
				.get(userId)
		);
	} catch {
		return false;
	}
}

export function userIsOwner(userId: string, orgId?: string | null): boolean {
	// The gate follows the active org when a session names one: an owner of org A is not an owner
	// while acting in org B (IAM.md I5). Without an org, the first membership is the bootstrap
	// fallback the setup wizard relies on.
	if (orgId) return membershipRoleIn(orgId, userId) === 'owner';
	return readMembership(sqlite, userId)?.role === 'owner';
}

export function userHasTotp(userId: string): boolean {
	try {
		return Boolean(
			sqlite.query<{ v: number | null }, [string]>('SELECT twoFactorEnabled AS v FROM user WHERE id = ?').get(userId)?.v
		);
	} catch {
		return false;
	}
}

export function userHasPasskey(userId: string): boolean {
	try {
		return Boolean(sqlite.query<{ id: string }, [string]>('SELECT id FROM passkey WHERE userId = ? LIMIT 1').get(userId));
	} catch {
		return false;
	}
}

/** Record that this session proved `factor` (the `secondFactor` session field, see auth.ts). */
export function markSessionSecondFactor(sessionId: string, factor: SecondFactor): void {
	sqlite.run('UPDATE session SET secondFactor = ? WHERE id = ?', [factor, sessionId]);
	failures.delete(sessionId);
}

/**
 * Changing a password signs every session out and issues a new one (auth.ts). Carry the factor
 * the old session proved over to it, so an owner isn't challenged again straight away.
 */
export function carrySecondFactorToToken(token: string, factor: string): void {
	sqlite.run('UPDATE session SET secondFactor = ? WHERE token = ?', [factor, token]);
}

/** Failed codes per unproven session; in memory is enough (a restart only resets the budget). */
const failures = new Map<string, number>();

/** Count a failed code. Returns true once the session has used up its attempts. */
export function recordSecondFactorFailure(sessionId: string): boolean {
	const count = (failures.get(sessionId) ?? 0) + 1;
	failures.set(sessionId, count);
	if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
	return count >= MAX_SECOND_FACTOR_FAILURES;
}

export function secondFactorAttemptsExhausted(sessionId: string): boolean {
	return (failures.get(sessionId) ?? 0) >= MAX_SECOND_FACTOR_FAILURES;
}

export function revokeSession(sessionId: string): void {
	sqlite.run('DELETE FROM session WHERE id = ?', [sessionId]);
	failures.delete(sessionId);
}
