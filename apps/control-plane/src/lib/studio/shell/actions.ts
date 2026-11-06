import { runAction } from '#lib/actions.js';
import { askConfirm } from '#lib/confirm.svelte.js';

/**
 * Session actions of the studio route (plan 22). They post to the route's own `?/open` and
 * `?/close` form actions, so they only work on `/databases/<name>/studio`.
 */
export function openReadOnly(): void {
	void runAction('?/open', { readOnly: '1' });
}

/** Writes always go through the confirmation dialog. */
export function confirmEnableWrites(database: string): void {
	askConfirm({
		title: `Enable writes for ${database}?`,
		description:
			'The studio connects with the owner credential and no read-only transaction. Every statement you run and every edit you apply changes the live database, including DELETE and DROP. Writes last for this session only.',
		confirmLabel: 'Enable writes',
		tone: 'danger',
		action: '?/open',
		fields: { readOnly: '0' }
	});
}

export function closeSession(): void {
	void runAction('?/close');
}
