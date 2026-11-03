import type { ActionResult } from '$app/forms';

export interface ConfirmRequest {
	title: string;
	description?: string;
	confirmLabel?: string;
	/** `danger` styles the confirm button as destructive. */
	tone?: 'danger' | 'default';
	/** Form action to run on confirm, e.g. `?/deleteDeployment`. */
	action: string;
	fields?: Record<string, string>;
	/** Require typing this exact text before confirming (for irreversible actions). */
	typeToConfirm?: string;
	/** Skip the default page-data refresh (e.g. when navigating away afterwards). */
	apply?: boolean;
	onResult?: (result: ActionResult) => void | Promise<void>;
}

class ConfirmState {
	request = $state<ConfirmRequest | null>(null);
}

export const confirmState = new ConfirmState();

/** Open the app-wide confirmation dialog for a destructive or consequential action. */
export function askConfirm(request: ConfirmRequest): void {
	confirmState.request = request;
}
