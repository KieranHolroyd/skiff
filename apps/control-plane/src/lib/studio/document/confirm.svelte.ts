/**
 * A promise-based confirmation for studio edits. The dashboard's `askConfirm` runs a SvelteKit
 * form action on confirm; studio edits are client-side `apply` calls, so the workspaces ask here
 * and render `ConfirmDialog` with this state.
 */
export interface ConfirmPrompt {
	title: string;
	description?: string;
	confirmLabel?: string;
	tone?: 'danger' | 'default';
}

export class Confirmer {
	prompt = $state<ConfirmPrompt | null>(null);
	#resolve: ((confirmed: boolean) => void) | null = null;

	ask(prompt: ConfirmPrompt): Promise<boolean> {
		this.#resolve?.(false);
		this.prompt = prompt;
		return new Promise((resolve) => (this.#resolve = resolve));
	}

	settle(confirmed: boolean): void {
		const resolve = this.#resolve;
		this.#resolve = null;
		this.prompt = null;
		resolve?.(confirmed);
	}
}
