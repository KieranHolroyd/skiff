import { ValidationError } from '../errors.ts';
import type { BindingResolver } from './types.ts';

/**
 * Static assets resolution (docs/FUNCTIONS.md §4.2, §4.5, D110, FN10).
 *
 * An `assets` binding names no org resource and carries no secret: it is permission for the
 * function host to read the project's own release directory through `env.ASSETS`. The runtime
 * shape therefore keeps only the binding name; the agent reads the directory from the function
 * spec's `assets.directory` and renders the read-only disk service.
 *
 * `FunctionService` checks that the manifest actually declared `assets.directory` before calling
 * this resolver — a binding with no directory to serve must be a deploy error, not a host that
 * 404s every request.
 */
export const resolveAssetsBinding: BindingResolver = (_context, binding) => {
	if (binding.type !== 'assets') {
		throw new ValidationError(
			`Binding "${binding.name}" uses type "${binding.type}"; the assets resolver only handles binding type "assets".`,
		);
	}
	return { name: binding.name, type: 'assets' };
};
