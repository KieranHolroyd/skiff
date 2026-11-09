import type { AlterResult, SchemaChangeInput } from '@yoal/studio/protocol';
import { studioCall } from '../client.js';
import { studioErrorMessage } from '../document/apply.js';
import { confirmPhrase, DESTRUCTIVE_OPS } from './changes.js';

/**
 * The review step every structure edit goes through: dry-run each change, show the statements,
 * and run them only once the user confirms (typing the name first for a destructive change).
 * Render `ReviewDialog` with the instance.
 */
export interface ReviewRequest {
	title: string;
	description?: string;
	/** Run in order; a later change may depend on an earlier one only by name. */
	changes: SchemaChangeInput[];
	confirmLabel?: string;
}

export interface ReviewState {
	title: string;
	description: string | null;
	confirmLabel: string;
	destructive: boolean;
	/** Text to type before running a destructive change. */
	phrase: string | null;
	statements: string[];
	loading: boolean;
	running: boolean;
	error: string | null;
}

export class AlterReview {
	state = $state<ReviewState | null>(null);
	typed = $state('');
	#changes: SchemaChangeInput[] = [];
	#done: AlterResult[] = [];
	#resolve: ((results: AlterResult[] | null) => void) | null = null;

	constructor(private readonly database: () => string) {}

	/**
	 * Resolves with the results of the changes that ran (all of them on success, the first few
	 * when a later one failed and the user closed the dialog), or null when nothing ran.
	 */
	start(request: ReviewRequest): Promise<AlterResult[] | null> {
		this.#finish();
		this.#changes = request.changes;
		this.#done = [];
		this.typed = '';
		const destructive = request.changes.some((change) => DESTRUCTIVE_OPS.has(change.op));
		this.state = {
			title: request.title,
			description: request.description ?? null,
			confirmLabel: request.confirmLabel ?? 'Run',
			destructive,
			phrase: request.changes.map(confirmPhrase).find((phrase) => phrase !== null) ?? null,
			statements: [],
			loading: true,
			running: false,
			error: null
		};
		const promise = new Promise<AlterResult[] | null>((resolve) => (this.#resolve = resolve));
		void this.#preview();
		return promise;
	}

	get canConfirm(): boolean {
		const state = this.state;
		if (!state || state.loading || state.running || state.error !== null) return false;
		return state.phrase === null || this.typed.trim() === state.phrase;
	}

	async #preview(): Promise<void> {
		const state = this.state;
		if (!state) return;
		const statements: string[] = [];
		try {
			for (const change of this.#changes) {
				const result = await studioCall(this.database(), 'alter', { change, dryRun: true });
				statements.push(...result.statements);
			}
			if (this.state !== state) return;
			state.statements = statements;
		} catch (caught) {
			if (this.state !== state) return;
			state.statements = statements;
			state.error = studioErrorMessage(caught);
		} finally {
			if (this.state === state) state.loading = false;
		}
	}

	async confirm(): Promise<void> {
		const state = this.state;
		if (!state || !this.canConfirm) return;
		state.running = true;
		try {
			for (const change of this.#changes.slice(this.#done.length)) {
				this.#done.push(await studioCall(this.database(), 'alter', { change, dryRun: false }));
			}
			this.#finish();
		} catch (caught) {
			if (this.state !== state) return;
			const message = studioErrorMessage(caught);
			state.error =
				this.#done.length > 0
					? `The first ${this.#done.length === 1 ? 'change was' : `${this.#done.length} changes were`} applied, then: ${message}`
					: message;
		} finally {
			if (this.state === state) state.running = false;
		}
	}

	cancel(): void {
		if (this.state?.running) return;
		this.#finish();
	}

	#finish(): void {
		const resolve = this.#resolve;
		const done = this.#done;
		this.#resolve = null;
		this.state = null;
		resolve?.(done.length > 0 ? done : null);
	}
}

/** "about 1,234 rows" for a toast after a change that touched data. */
export function affectedText(results: readonly AlterResult[], unit: string): string {
	const affected = results.reduce((sum, result) => sum + (result.affected ?? 0), 0);
	if (!results.some((result) => result.affected !== undefined)) return '';
	return ` (${affected.toLocaleString('en-GB')} ${unit}${affected === 1 ? '' : 's'})`;
}
