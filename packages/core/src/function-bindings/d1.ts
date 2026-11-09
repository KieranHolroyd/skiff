import type { FunctionRuntimeBinding } from '@yoal/contracts';
import type { BindingResolver } from './types.ts';

/**
 * Keep namespace ids inside the runtime schema's `[A-Za-z0-9._-]` alphabet and 128-character cap.
 *
 * The cap matches `functionRuntimeBindingSchema`; the project id and binding name come first in the
 * derived id, so a cut tail can only drop characters of the database name, and binding names are
 * unique within a manifest, so distinct bindings still get distinct ids.
 */
function namespaceId(value: string): string {
	return value
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 128)
		.replace(/-+$/g, '');
}

/**
 * Resolve a D1 binding to its stable node-local database id (docs/FUNCTIONS.md §4.5, FN10).
 *
 * D1 is per-binding state on the project's own volume, like a KV namespace: there is nothing in the
 * org to look up and no credential to fetch. The id is derived from the project's immutable id, the
 * binding name and the database name, so a project rename cannot move the database, two bindings
 * never share one, and changing the database a binding points at starts from an empty database.
 */
export const resolveD1Binding: BindingResolver = (context, binding) => {
	if (binding.type !== 'd1') {
		throw new Error(
			`D1 resolver received binding "${binding.name}" of type "${binding.type}", not "d1".`,
		);
	}
	return {
		name: binding.name,
		type: 'd1',
		database: binding.database,
		namespaceId: namespaceId(`${context.project.id}-${binding.name}-${binding.database}`),
	} satisfies FunctionRuntimeBinding;
};
