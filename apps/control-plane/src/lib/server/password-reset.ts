import type { Database } from 'bun:sqlite';
import type { AuditService } from '@skiff/core';

/**
 * Password reset (Better Auth `emailAndPassword.sendResetPassword`, wired in auth.ts). Plain
 * functions over SQLite so the operator script (`scripts/reset-password.ts`) shares them and they
 * are unit-tested without SvelteKit.
 *
 * - A reset link lives 30 minutes and works once. Using it sets the password, signs out every
 *   session and voids the user's other reset links. It never signs anyone in, so an owner still
 *   proves a second factor at the next sign-in (D10).
 * - Better Auth limits requests per IP; `ResetThrottle` adds a per-address limit so nobody can
 *   flood one mailbox from many addresses.
 * - The request answers the same whether or not the address has an account, and the email is
 *   sent in the background so response timing does not tell either.
 */

/** Reset links expire after this many seconds (Better Auth's default is an hour). */
export const PASSWORD_RESET_TTL_SECONDS = 30 * 60;

/** Better Auth stores a reset token as a `verification` row with this identifier prefix. */
const RESET_IDENTIFIER_PREFIX = 'reset-password:';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MAX_TRACKED_ADDRESSES = 10_000;

export interface ResetThrottleOptions {
	/** Emails per address in any rolling minute (default 1). */
	perMinute?: number;
	/** Emails per address in any rolling hour (default 5). */
	perHour?: number;
	now?: () => number;
}

/** Per-address limit on reset emails. In memory: a restart forgets it, the IP limit remains. */
export class ResetThrottle {
	private readonly sent = new Map<string, number[]>();
	private readonly perMinute: number;
	private readonly perHour: number;
	private readonly now: () => number;

	constructor(options: ResetThrottleOptions = {}) {
		this.perMinute = options.perMinute ?? 1;
		this.perHour = options.perHour ?? 5;
		this.now = options.now ?? Date.now;
	}

	/** True (and counted) when another reset email may go to `email` now. */
	take(email: string): boolean {
		const key = email.trim().toLowerCase();
		const now = this.now();
		const recent = (this.sent.get(key) ?? []).filter((at) => now - at < HOUR_MS);
		const lastMinute = recent.filter((at) => now - at < MINUTE_MS).length;
		if (lastMinute >= this.perMinute || recent.length >= this.perHour) {
			this.sent.set(key, recent);
			return false;
		}
		recent.push(now);
		this.sent.delete(key);
		this.sent.set(key, recent);
		this.prune(now);
		return true;
	}

	private prune(now: number): void {
		if (this.sent.size <= MAX_TRACKED_ADDRESSES) return;
		for (const [key, times] of this.sent)
			if (times.every((at) => now - at >= HOUR_MS)) this.sent.delete(key);
		// Still full: forget the least recently used addresses (Map keeps insertion order).
		for (const key of this.sent.keys()) {
			if (this.sent.size <= MAX_TRACKED_ADDRESSES) break;
			this.sent.delete(key);
		}
	}
}

/** Delete one reset token, e.g. one that was never emailed. */
export function discardResetToken(sqlite: Database, token: string): void {
	sqlite.run('DELETE FROM verification WHERE identifier = ?', [
		`${RESET_IDENTIFIER_PREFIX}${token}`
	]);
}

/** Void every outstanding reset link for a user. Returns how many were deleted. */
export function deleteResetTokens(sqlite: Database, userId: string): number {
	return sqlite.run(
		'DELETE FROM verification WHERE substr(identifier, 1, length(?)) = ? AND value = ?',
		[RESET_IDENTIFIER_PREFIX, RESET_IDENTIFIER_PREFIX, userId]
	).changes;
}

export interface PasswordResetAudit {
	userId: string;
	/** `email`: the user followed a reset link. `operator`: `scripts/reset-password.ts`. */
	method: 'email' | 'operator';
	ipHash?: string;
	/** Sessions signed out, when known. */
	sessionsRevoked?: number;
}

/**
 * Record a reset in the audit log of every organisation the user belongs to, so its owners see it.
 * Audit entries belong to an organisation: a user in none (an invitee who has not accepted yet)
 * has no log to write to. Returns the number of entries written.
 */
export function recordPasswordReset(
	audit: Pick<AuditService, 'record'>,
	sqlite: Database,
	input: PasswordResetAudit
): number {
	let orgIds: string[] = [];
	try {
		orgIds = sqlite
			.query<{ organizationId: string }, [string]>(
				'SELECT DISTINCT organizationId FROM member WHERE userId = ?'
			)
			.all(input.userId)
			.map((row) => row.organizationId);
	} catch {
		// No organization tables yet (a bare install).
	}
	const args = {
		method: input.method,
		...(input.sessionsRevoked === undefined ? {} : { sessionsRevoked: input.sessionsRevoked })
	};
	for (const orgId of orgIds)
		audit.record({
			// The user acted on their own account; the operator script acts as the system.
			principal: {
				kind: input.method === 'email' ? 'user' : 'system',
				userId: input.method === 'email' ? input.userId : 'system:operator',
				orgId,
				role: 'viewer',
				permissions: new Set(),
				ipHash: input.ipHash
			},
			action: 'user.password_reset',
			resource: 'user',
			resourceId: input.userId,
			args,
			result: 'ok'
		});
	return orgIds.length;
}

/** Never store a raw IP; same truncated hash as principal.ts. */
export function hashRequestIp(request: Request | undefined): string | undefined {
	if (!request) return undefined;
	const ip =
		request.headers.get('cf-connecting-ip') ??
		request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
		request.headers.get('x-real-ip');
	if (!ip) return undefined;
	return new Bun.CryptoHasher('sha256').update(`ip:${ip}`).digest('hex').slice(0, 16);
}
