import { browser } from '$app/env';
import { invalidateAll } from '$app/navigation';

/**
 * Global step-up dialog state (STEP-UP.md §6). `askVerify` opens one dialog and resolves when the
 * person either verifies or closes it; `runAction`/`fetchJson` call it and retry the original
 * request once. Requests queue so two failing calls do not stack dialogs.
 */
export interface VerifyRequest {
	/** The permission the server named; shown in the dialog's copy. */
	permission?: string;
	/** `always` actions ask every time, even inside the window. */
	level?: 'window' | 'always';
	/** A short human label for the action being attempted. */
	action?: string;
}

export interface VerifyStatus {
	fresh: boolean;
	class: 'strong' | 'basic' | null;
	strongest: 'strong' | 'basic';
	windowMs: number;
	freshUntil: number | null;
	preferred: 'passkey' | 'totp' | 'backup-code' | 'password' | 'email' | null;
	alternatives: Array<'passkey' | 'totp' | 'backup-code' | 'password' | 'email'>;
	email: string | null;
}

interface Pending {
	request: VerifyRequest;
	resolve: (ok: boolean) => void;
}

class VerifyState {
	request = $state<VerifyRequest | null>(null);
}

export const verifyState = new VerifyState();

let active: Pending | null = null;
const queue: Pending[] = [];

/** Open the verification dialog and resolve `true` only if a method succeeded. */
export function askVerify(request: VerifyRequest = {}): Promise<boolean> {
	return new Promise((resolve) => {
		queue.push({ request, resolve });
		pump();
	});
}

/** Called by the dialog: settle the current request and show the next one, if any. */
export function settleVerify(ok: boolean): void {
	active?.resolve(ok);
	active = null;
	verifyState.request = null;
	pump();
}

function pump(): void {
	if (active || queue.length === 0) return;
	active = queue.shift()!;
	verifyState.request = active.request;
}

/** "Lock now" in the user menu: clear the window and refresh the chip. */
export async function lockStepUp(): Promise<boolean> {
	if (!browser) return false;
	const response = await fetch('/api/auth/step-up/lock', {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: '{}',
	});
	if (!response.ok) return false;
	await invalidateAll();
	return true;
}
