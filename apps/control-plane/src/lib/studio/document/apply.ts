/**
 * Shared by the document and key-value workspaces: how an `apply` result and a studio error
 * read to the user.
 */
import type { ApplyResult } from '@yoal/studio/protocol';
import { StudioCallError } from '../client.js';

export interface ApplySummary {
	tone: 'success' | 'warning' | 'danger';
	title: string;
	/** One line per conflict: "Change 2: Document … changed since it was loaded." */
	details: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Most engines apply all or nothing. MongoDB without a replica set can stop part-way: then
 * `applied > 0` with a conflict, and the reason says "Partially applied".
 */
export function summarizeApply(result: ApplyResult, total: number, describe?: (index: number) => string): ApplySummary {
	const details = result.conflicts.map(
		(conflict) => `${describe ? describe(conflict.index) : `Change ${conflict.index + 1}`}: ${conflict.reason}`,
	);
	if (result.conflicts.length === 0)
		return { tone: 'success', title: `Applied ${plural(result.applied, 'change')}.`, details };
	if (result.applied > 0)
		return {
			tone: 'warning',
			title: `Partially applied: ${result.applied} of ${plural(total, 'change')} were written, then a conflict stopped the rest.`,
			details,
		};
	return { tone: 'danger', title: `Nothing was applied: ${plural(result.conflicts.length, 'conflict')}.`, details };
}

/** A clear message for a failed studio call, by its protocol code. */
export function studioErrorMessage(caught: unknown): string {
	if (caught instanceof StudioCallError) {
		switch (caught.code) {
			case 'read_only':
				return `This session is read-only, so nothing was changed. Enable writes from the studio header to edit. (${caught.message})`;
			case 'conflict':
				return `The data changed since it was loaded; reload and try again. (${caught.message})`;
			case 'session_expired':
			case 'unknown_session':
				return 'The studio session has ended. Reopen it from the studio header.';
			case 'unsupported':
				return `Not supported here: ${caught.message}`;
			case 'cancelled':
				return 'Cancelled.';
			case 'timeout':
				return `Timed out: ${caught.message}`;
			case 'network':
				return `Could not reach the control plane: ${caught.message}`;
			default:
				return caught.message;
		}
	}
	return caught instanceof Error ? caught.message : 'The studio request failed.';
}
