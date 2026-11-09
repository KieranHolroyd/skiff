import type { StepUpClass } from '@skiff/contracts';
import { userHasSecondFactor } from './second-factor';
import { sqlite } from './db';
import type { SignInMethod } from './sso-enforcement';

/**
 * Read the step-up window off a Better Auth session row (STEP-UP.md §3, §6).
 *
 * The `stepUp()` plugin will add `verificationAt`, `verificationClass` and `strongest` as
 * `session.additionalFields` (`input: false`); until then they are absent, so every read here is
 * optional and a missing field simply means "not verified" (fail closed). The doc's §3 names the
 * first two `verifiedAt`/`verifiedClass`; both spellings are accepted so the helper survives the
 * plugin landing under either name.
 *
 * `strongest` may be absent on an older session. Falling back to the class that was used means a
 * session is never asked for more than the factor it proved; the plugin sets `strongest` at
 * sign-in/enrolment so a basic password verification cannot satisfy a strong-factor user.
 *
 * There is deliberately no `/api/v1/auth/step-up/verify` endpoint yet: password checking exists
 * (`auth.api.verifyPassword`) but nothing can persist `verificationAt` on the session without the
 * plugin's schema, so an endpoint would verify and then immediately forget. STEP-UP.md §10 step 2
 * adds the plugin and the endpoint together.
 */
export { verificationFromSession } from './step-up/verification';

/** The strongest factor this person has enrolled *now* (a passkey or a verified authenticator app). */
export function strongestStepUpClass(userId: string): StepUpClass {
	return userHasSecondFactor(userId) ? 'strong' : 'basic';
}

/**
 * A fresh sign-in seeds the window (STEP-UP.md §3): a passkey sign-in counts as strong, every
 * other method (password, GitHub, magic link, SSO) as basic. A later TOTP/backup-code verification
 * upgrades the session from the auth after-hook, which is also how a first-time enrolment counts.
 */
export function seedSessionStepUp(sessionId: string, userId: string, method: SignInMethod | undefined): void {
	const used: StepUpClass = method === 'passkey' ? 'strong' : 'basic';
	sqlite.run(
		'UPDATE session SET verificationAt = ?, verificationClass = ?, strongest = ? WHERE id = ?',
		[Date.now(), used, strongestStepUpClass(userId), sessionId],
	);
}

/** Record a successful step-up on this session. `class` is the method's class, not the user's. */
export function markSessionStepUp(sessionId: string, userId: string, used: StepUpClass): void {
	sqlite.run(
		'UPDATE session SET verificationAt = ?, verificationClass = ?, strongest = ? WHERE id = ?',
		[Date.now(), used, strongestStepUpClass(userId), sessionId],
	);
}

/** Recompute `strongest` after a factor is added or removed, without touching the window. */
export function refreshStrongestStepUp(userId: string): void {
	sqlite.run('UPDATE session SET strongest = ? WHERE userId = ?', [strongestStepUpClass(userId), userId]);
}

/** Clear the window on this session ("Lock now", or a password change on the current device). */
export function clearSessionStepUp(sessionId: string): void {
	sqlite.run(
		'UPDATE session SET verificationAt = NULL, verificationClass = NULL WHERE id = ?',
		[sessionId],
	);
}

/** Clear every session's window after a password reset, a factor removal or a role change. */
export function clearStepUpForUser(userId: string): void {
	sqlite.run(
		'UPDATE session SET verificationAt = NULL, verificationClass = NULL WHERE userId = ?',
		[userId],
	);
}
