import type { BindingResolveContext, BindingResolver } from './types.ts';

/**
 * Durable Objects (docs/FUNCTIONS.md §4.5, FN11): a native workerd namespace, so the control plane
 * only has to give it a stable identity. Nothing in the org is looked up: the class lives in the
 * user's own bundle and the storage is the project's single-node volume.
 */
export const resolveDurableObject: BindingResolver = (context: BindingResolveContext, binding) => {
	if (binding.type !== 'durable_object') {
		throw new Error(
			`Durable Object resolver received binding "${binding.name}" of type "${binding.type}", not "durable_object".`,
		);
	}
	return {
		name: binding.name,
		type: 'durable_object',
		className: binding.className,
		// Project id + binding name, never the renameable slug: a rename or redeploy must keep the
		// same object storage. Binding names are unique within a manifest, so one key per namespace.
		uniqueKey: durableObjectUniqueKey(context.project.id, binding.name),
	};
};

/**
 * workerd's namespace key alphabet is `[A-Za-z0-9._-]`; project ids already fit and binding names
 * are JavaScript identifiers, so only `$` (the one identifier character outside the alphabet) is
 * mapped. Mapping to `-` keeps distinct identifiers distinct.
 */
export function durableObjectUniqueKey(projectId: string, bindingName: string): string {
	return `${projectId}-${bindingName}`.replace(/[^A-Za-z0-9._-]/g, '-');
}
