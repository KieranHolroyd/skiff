import type { StepUpClass, StepUpVerification } from '@skiff/contracts';

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
export function verificationFromSession(session: unknown): StepUpVerification | undefined {
	if (!session || typeof session !== 'object') return undefined;
	const row = session as Record<string, unknown>;
	const at = timestamp(row.verificationAt) ?? timestamp(row.verifiedAt);
	const used = stepUpClass(row.verificationClass) ?? stepUpClass(row.verifiedClass);
	// Without both a time and a class there is nothing we can prove: treat the session as unverified.
	if (at === undefined || !used) return undefined;
	return { at, class: used, strongest: stepUpClass(row.strongest) ?? used };
}

function timestamp(value: unknown): number | undefined {
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
	if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function stepUpClass(value: unknown): StepUpClass | undefined {
	return value === 'strong' || value === 'basic' ? value : undefined;
}
