import { applyAction, deserialize, type ActionResult } from '$app/forms';
import { invalidateAll } from '$app/navigation';
import { toast } from 'svelte-sonner';
import { askVerify } from '#lib/verify.svelte.js';

/** The message shown when the server needs a fresh step-up verification (STEP-UP.md §6). */
const STEP_UP_MESSAGE = 'Verify it’s you to continue.';

/** A form failure that asked for step-up, with the permission and level the server named. */
function stepUpRequest(
	data: unknown,
): { permission?: string; level?: 'window' | 'always' } | undefined {
	if (
		typeof data !== 'object' ||
		data === null ||
		(data as { code?: unknown }).code !== 'step_up_required'
	)
		return undefined;
	const payload = data as { permission?: unknown; level?: unknown };
	return {
		...(typeof payload.permission === 'string' ? { permission: payload.permission } : {}),
		...(payload.level === 'always' ? { level: 'always' as const } : { level: 'window' as const }),
	};
}

/** Show the standard `{ success }` / `{ message }` payload of a dashboard action as a toast. */
export function notify(result: ActionResult): void {
	if (result.type === 'success') {
		const message = (result.data as { success?: unknown } | undefined)?.success;
		if (typeof message === 'string') toast.success(message);
	} else if (result.type === 'failure') {
		if (stepUpRequest(result.data)) {
			// The dialog already had its chance; this is the retry failing again (an `always` action,
			// or a session that changed in between).
			toast.error(STEP_UP_MESSAGE);
			return;
		}
		const message = (result.data as { message?: unknown } | undefined)?.message;
		toast.error(typeof message === 'string' ? message : 'That did not work. Please try again.');
	} else if (result.type === 'error') {
		toast.error('Something went wrong. Please try again.');
	}
}

async function requestAction(action: string, fields: Record<string, string>): Promise<ActionResult> {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	try {
		const response = await fetch(action, {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' }
		});
		return deserialize(await response.text());
	} catch {
		return { type: 'error', error: { message: 'Network error', status: 0 } };
	}
}

/**
 * Call a SvelteKit form action without a <form>, for menu items and confirm dialogs.
 * Mirrors `use:enhance`: refreshes page data on success, then applies the result to `page.form`.
 *
 * A `step_up_required` failure opens the global VerifyDialog and retries the same action **once**
 * after success (STEP-UP.md §6). Callers need no changes.
 */
export async function runAction(
	action: string,
	fields: Record<string, string> = {},
	options: { apply?: boolean; toast?: boolean } = {}
): Promise<ActionResult> {
	let result = await requestAction(action, fields);
	const stepUp = result.type === 'failure' ? stepUpRequest(result.data) : undefined;
	if (stepUp) {
		const verified = await askVerify({
			...(stepUp.permission ? { permission: stepUp.permission } : {}),
			level: stepUp.level,
			action: stepUp.permission
		});
		if (verified) result = await requestAction(action, fields);
	}
	if (options.toast !== false) notify(result);
	if (options.apply !== false) {
		if (result.type === 'success') await invalidateAll();
		if (result.type !== 'error') await applyAction(result);
	}
	return result;
}
