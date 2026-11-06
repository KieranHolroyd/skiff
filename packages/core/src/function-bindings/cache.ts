import { ValidationError } from '../errors.ts';
import type { BindingResolver } from './types.ts';

/**
 * Cache API resolution (docs/FUNCTIONS.md §4.5, FN10).
 *
 * The Cache API needs no org resource and no secret: a `cache` binding is simply permission for
 * the function host to route `caches.default` / `caches.open()` at a node-local cache service.
 * The runtime shape therefore keeps only the binding name; the agent derives the Durable Object
 * namespace key from the project id and that name.
 */
export const resolveCacheBinding: BindingResolver = (_context, binding) => {
	if (binding.type !== 'cache') {
		throw new ValidationError(
			`Binding "${binding.name}" uses type "${binding.type}"; the cache resolver only handles binding type "cache".`,
		);
	}
	return { name: binding.name, type: 'cache' };
};
