import type { StepUpClass } from '@yoal/contracts';

/**
 * Step-up method selection and freshness (STEP-UP.md §2–§3).
 *
 * Pure functions only, so the rules are unit-tested without a database or a running Better Auth
 * instance. `plugin.ts` wires them to sessions, WebAuthn, TOTP and email codes.
 */

/** Every way a person can prove it is them again. */
export type StepUpMethod = 'passkey' | 'totp' | 'backup-code' | 'password' | 'email';

/** What the person could prove *right now*, from their enrolled factors. */
export interface StepUpEnrolment {
	passkey: boolean;
	totp: boolean;
	password: boolean;
	/** Platform mail is configured, so an email code can be sent. */
	email: boolean;
}

export interface StepUpChoice {
	/** The highest-ranked method — the one the dialog opens on. Never a weaker class. */
	preferred: StepUpMethod | null;
	/** Other methods in the same class, in rank order, for "Try another way". */
	alternatives: StepUpMethod[];
	/** The strongest factor this person has enrolled. */
	class: StepUpClass;
	/** `preferred` then `alternatives`, with duplicates removed and empty entries dropped. */
	methods: StepUpMethod[];
}

/** A challenge is valid for two minutes (STEP-UP.md §5). */
export const STEP_UP_CHALLENGE_TTL_MS = 2 * 60 * 1000;

/** An email code lives for ten minutes and may be tried five times (STEP-UP.md §5). */
export const STEP_UP_EMAIL_TTL_MS = 10 * 60 * 1000;
export const STEP_UP_EMAIL_MAX_ATTEMPTS = 5;
export const STEP_UP_EMAIL_PER_MINUTE = 1;
export const STEP_UP_EMAIL_PER_HOUR = 5;

/** Failed step-up attempts allowed in one session before it is revoked (STEP-UP.md §5). */
export const MAX_STEP_UP_FAILURES = 5;

const STRONG = new Set<StepUpMethod>(['passkey', 'totp', 'backup-code']);

/**
 * Pick the preferred method and its same-class alternatives (STEP-UP.md §2).
 *
 * The same-class rule is the important part: if any strong factor exists, password and email are
 * never offered, so someone holding the password or mailbox cannot choose the weaker path.
 */
export function chooseMethods(enrolment: StepUpEnrolment): StepUpChoice {
	const strong = enrolment.passkey || enrolment.totp;
	if (strong) {
		const preferred: StepUpMethod = enrolment.passkey ? 'passkey' : 'totp';
		const alternatives: StepUpMethod[] = [];
		if (enrolment.passkey && enrolment.totp) alternatives.push('totp');
		if (enrolment.totp) alternatives.push('backup-code');
		return finalise(preferred, alternatives, 'strong');
	}

	const preferred: StepUpMethod | null = enrolment.password
		? 'password'
		: enrolment.email
			? 'email'
			: null;
	const alternatives: StepUpMethod[] = [];
	if (preferred === 'password' && enrolment.email) alternatives.push('email');
	return finalise(preferred, alternatives, 'basic');
}

function finalise(
	preferred: StepUpMethod | null,
	alternatives: StepUpMethod[],
	class_: StepUpClass,
): StepUpChoice {
	const methods: StepUpMethod[] = [];
	for (const method of preferred ? [preferred, ...alternatives] : alternatives)
		if (!methods.includes(method)) methods.push(method);
	return { preferred, alternatives: methods.slice(preferred ? 1 : 0), class: class_, methods };
}

/** Which class a method proves. Backup codes are the recovery route for TOTP, so they are strong. */
export function methodClass(method: StepUpMethod): StepUpClass {
	return STRONG.has(method) ? 'strong' : 'basic';
}

/** Whether the method is offered to this person right now (the server-side same-class check). */
export function methodAllowed(choice: StepUpChoice, method: StepUpMethod): boolean {
	return choice.methods.includes(method);
}

const CLASS_RANK: Record<StepUpClass, number> = { basic: 1, strong: 2 };

/**
 * A verification is fresh when it is inside the fixed window and at least as strong as the
 * strongest factor the person has enrolled now. `always` actions ignore this and ask every time;
 * that is `requireStepUp`'s job, not this helper's.
 */
export function isVerificationFresh(
	verification: { at: number; class: StepUpClass; strongest: StepUpClass },
	now: number = Date.now(),
	windowMs: number = 30 * 60 * 1000,
): boolean {
	if (!Number.isFinite(verification.at) || now - verification.at >= windowMs) return false;
	return CLASS_RANK[verification.class] >= CLASS_RANK[verification.strongest];
}

/** When the fixed window ends, for the dashboard countdown. */
export function freshUntil(
	verification: { at: number },
	windowMs: number = 30 * 60 * 1000,
): number {
	return verification.at + windowMs;
}

/** Minutes left in a window, rounded up so a nearly-expired window still says "1 min". */
export function minutesLeft(until: number, now: number = Date.now()): number {
	return Math.max(0, Math.ceil((until - now) / 60_000));
}

/** `alice@example.com` → `a•••e@example.com`, enough to recognise without leaking the address. */
export function maskEmail(email: string | null | undefined): string | null {
	if (!email) return null;
	const at = email.lastIndexOf('@');
	if (at <= 0) return null;
	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	const masked =
		local.length <= 2 ? `${local[0] ?? ''}•` : `${local[0]}${'•'.repeat(Math.min(3, local.length - 2))}${local.at(-1)}`;
	return `${masked}@${domain}`;
}

/** TOTP steps are 30 seconds; the replay guard stores the step, not the code. */
export const TOTP_PERIOD_SECONDS = 30;

export function totpCounter(now: number = Date.now(), periodSeconds: number = TOTP_PERIOD_SECONDS): number {
	return Math.floor(now / (periodSeconds * 1000));
}

/** True when this TOTP step was already accepted for the session (STEP-UP.md §5). */
export function isTotpReplay(lastAcceptedStep: number | null | undefined, matchedStep: number): boolean {
	return typeof lastAcceptedStep === 'number' && matchedStep <= lastAcceptedStep;
}
