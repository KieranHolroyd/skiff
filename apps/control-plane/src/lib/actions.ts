import { applyAction, deserialize, type ActionResult } from '$app/forms';
import { invalidateAll } from '$app/navigation';
import { toast } from 'svelte-sonner';

/** Show the standard `{ success }` / `{ message }` payload of a dashboard action as a toast. */
export function notify(result: ActionResult): void {
	if (result.type === 'success') {
		const message = (result.data as { success?: unknown } | undefined)?.success;
		if (typeof message === 'string') toast.success(message);
	} else if (result.type === 'failure') {
		const message = (result.data as { message?: unknown } | undefined)?.message;
		toast.error(typeof message === 'string' ? message : 'That did not work. Please try again.');
	} else if (result.type === 'error') {
		toast.error('Something went wrong. Please try again.');
	}
}

/**
 * Call a SvelteKit form action without a <form>, for menu items and confirm dialogs.
 * Mirrors `use:enhance`: refreshes page data on success, then applies the result to `page.form`.
 */
export async function runAction(
	action: string,
	fields: Record<string, string> = {},
	options: { apply?: boolean; toast?: boolean } = {}
): Promise<ActionResult> {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	let result: ActionResult;
	try {
		const response = await fetch(action, {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' }
		});
		result = deserialize(await response.text());
	} catch {
		result = { type: 'error', error: { message: 'Network error', status: 0 } };
	}
	if (options.toast !== false) notify(result);
	if (options.apply !== false) {
		if (result.type === 'success') await invalidateAll();
		if (result.type !== 'error') await applyAction(result);
	}
	return result;
}
