import { hasPermission, type Principal } from '@skiff/contracts';

/** What the viewer may do with databases; the dashboard hides actions they can't take. */
export function databaseCan(principal: Principal) {
	return {
		create: hasPermission(principal, 'database:create'),
		update: hasPermission(principal, 'database:update'),
		delete: hasPermission(principal, 'database:delete'),
		credentials: hasPermission(principal, 'database:credentials'),
		/** Attach/detach also changes the project (D56). */
		attach:
			hasPermission(principal, 'database:update') && hasPermission(principal, 'project:update')
	};
}

export type DatabaseCan = ReturnType<typeof databaseCan>;

/** Blank → undefined (use the default); anything else → a number for zod to judge. */
export function optionalNumber(raw: string): number | undefined {
	return raw === '' ? undefined : Number(raw);
}

/** First zod issue per field, keyed by dotted path. */
export function fieldErrorsFrom(issues: Array<{ path: PropertyKey[]; message: string }>) {
	const fieldErrors: Record<string, string> = {};
	for (const issue of issues) {
		const key = issue.path.map(String).join('.');
		if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
	}
	return fieldErrors;
}
