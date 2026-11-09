import { MAX_STEP_UP_FAILURES } from './policy';

/**
 * Per-session failed step-up budget (STEP-UP.md §5). Five wrong codes/passwords across all
 * methods revoke the session. Passkey cancellations and WebAuthn user-presence failures do not
 * count: they prove nothing either way, and a misplaced finger should not sign someone out.
 *
 * In memory is enough: a restart only forgets the budget, like the second-factor challenge.
 */
export class StepUpFailureBudget {
	private readonly failures = new Map<string, number>();
	private readonly max: number;

	constructor(max: number = MAX_STEP_UP_FAILURES) {
		this.max = max;
	}

	/** Count a failure. Returns the new count and whether the session is now exhausted. */
	record(sessionId: string): { count: number; exhausted: boolean } {
		const count = (this.failures.get(sessionId) ?? 0) + 1;
		this.failures.set(sessionId, count);
		if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
		return { count, exhausted: count >= this.max };
	}

	clear(sessionId: string): void {
		this.failures.delete(sessionId);
	}

	count(sessionId: string): number {
		return this.failures.get(sessionId) ?? 0;
	}

	exhausted(sessionId: string): boolean {
		return this.count(sessionId) >= this.max;
	}
}
