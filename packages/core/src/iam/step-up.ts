/**
 * Step-up enforcement wiring (STEP-UP.md §8).
 *
 * The rules themselves live in `@skiff/contracts` (`requireStepUp`, `StepUpRequiredError`); this
 * module only decides whether they are switched on. It is off unless `SKIFF_STEP_UP=1`, because
 * until the verification plugin and `VerifyDialog` ship (STEP-UP.md §10, steps 2–3) a challenged
 * user has no way to verify. Defaulting off also keeps headless e2e and `bun test` unchanged.
 *
 * Read the variable per check rather than caching it at module load, so a test (or a runtime
 * toggle) sees the current value and there is one source of truth for every surface.
 */
export function stepUpEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.SKIFF_STEP_UP === '1';
}

/**
 * Whether a principal can be asked to verify at the keyboard. Only a person's `user` principal is
 * session-backed; API keys, MCP clients, service accounts and jobs cannot show a dialog, so they
 * follow the catalog's token rule instead (STEP-UP.md §7).
 */
export function stepUpAppliesTo(principal: { kind: string }): boolean {
	return principal.kind === 'user';
}
