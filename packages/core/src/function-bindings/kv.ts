import type { FunctionRuntimeBinding } from '@skiff/contracts';
import type { BindingResolver } from './types.ts';

/** Keep namespace ids inside the runtime schema's `[A-Za-z0-9._-]` alphabet. */
function namespaceId(value: string): string {
	return value
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Resolve a KV binding to its stable namespace id (docs/FUNCTIONS.md §4.5, FN10).
 *
 * KV is per-binding state, not a shared resource, so there is nothing to look up: the namespace is
 * derived from the project's immutable id and the binding name. A project rename cannot move the
 * data, and two bindings in one project never share keys.
 */
export const resolveKvBinding: BindingResolver = (context, binding) => {
	if (binding.type !== 'kv') {
		throw new Error(
			`KV resolver received binding "${binding.name}" of type "${binding.type}", not "kv".`,
		);
	}
	return {
		name: binding.name,
		type: 'kv',
		namespaceId: namespaceId(`${context.project.id}-${binding.name}`),
	} satisfies FunctionRuntimeBinding;
};
