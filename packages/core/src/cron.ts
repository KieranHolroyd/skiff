import {
	cronMatches as contractCronMatches,
	nextCronTime as contractNextCronTime,
	parseCronWith,
	type CronFields,
} from '@yoal/contracts';
import { ValidationError } from './errors.ts';

/**
 * Cron re-export for the control plane. The parser itself lives in `@yoal/contracts` so the node,
 * the API and every surface share one implementation (docs/FUNCTIONS.md §4.10). These wrappers
 * keep raising the platform's `ValidationError` with the parser's original messages, so every
 * existing caller and message stays exactly as it was.
 */
export type { CronFields } from '@yoal/contracts';

/** Parse a five-field UTC expression, throwing `ValidationError` on bad input. */
export function parseCron(expression: string): CronFields {
	return parseCronWith(expression, (message) => new ValidationError(message));
}

/** True when `date` (UTC) matches the expression. */
export function cronMatches(date: Date, expression: string): boolean {
	// Parse through the wrapper first so an invalid expression raises `ValidationError`, not the
	// contracts parser's plain `Error`.
	parseCron(expression);
	return contractCronMatches(date, expression);
}

/** Next matching minute strictly after `from` (epoch ms), or null within a year. */
export function nextCronTime(expression: string, from: number): number | null {
	parseCron(expression);
	return contractNextCronTime(expression, from);
}
