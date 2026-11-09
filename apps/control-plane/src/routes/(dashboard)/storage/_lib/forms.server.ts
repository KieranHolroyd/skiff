import { hasPermission, type Principal } from '@yoal/contracts';

export { grantsFromForm } from './grants.js';

/** What the viewer may do with object storage; the dashboard hides actions they can't take. */
export function storageCan(principal: Principal) {
	return {
		create: hasPermission(principal, 'storage:create'),
		update: hasPermission(principal, 'storage:update'),
		/** Also gates force-deleting a non-empty bucket. */
		delete: hasPermission(principal, 'storage:delete'),
		credentials: hasPermission(principal, 'storage:credentials'),
		/** Attach/detach and grant edits also change the project (S4). */
		attach: hasPermission(principal, 'storage:update') && hasPermission(principal, 'project:update')
	};
}

export type StorageCan = ReturnType<typeof storageCan>;

/** `a, b c` → `['a', 'b', 'c']`: bucket names typed on create, split on commas and whitespace. */
export function bucketList(raw: string): string[] {
	return raw
		.split(/[\s,]+/)
		.map((name) => name.trim().toLowerCase())
		.filter(Boolean);
}
