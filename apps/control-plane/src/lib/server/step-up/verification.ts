import type { StepUpClass, StepUpVerification } from '@skiff/contracts';

/**
 * Read the step-up window off a Better Auth session row (STEP-UP.md §3, §6).
 *
 * The `stepUp()` plugin adds `verificationAt`, `verificationClass` and `strongest` as
 * `session.additionalFields` (`input: false`); older sessions may lack them, so every read is
 * optional and a missing field means "not verified" (fail closed). The doc's §3 names the first two
 * `verifiedAt`/`verifiedClass`; both spellings are accepted.
 *
 * Pure on purpose: the test and the sign-in hooks can import it without booting the database.
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
