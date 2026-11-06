import type { FunctionRuntimeBinding } from '@skiff/contracts';
import type { BindingResolver } from './types.ts';

/** `functionRuntimeBindingSchema`'s `namespaceId` maximum. */
const MAX_NAMESPACE_ID = 128;

/** Keep namespace ids inside the runtime schema's `[A-Za-z0-9._-]` alphabet. */
function namespaceId(value: string): string {
	const filtered = value
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (filtered.length <= MAX_NAMESPACE_ID) return filtered;
	// A binding name and a queue name may each be 100 characters, so the derived id can exceed the
	// schema's limit. Truncating alone could make two long bindings collide; keep a stable digest
	// of the full id in the last eight characters.
	let hash = 0;
	for (let index = 0; index < filtered.length; index += 1) {
		hash = (Math.imul(31, hash) + filtered.charCodeAt(index)) | 0;
	}
	const suffix = (hash >>> 0).toString(16).padStart(8, '0');
	return `${filtered.slice(0, MAX_NAMESPACE_ID - suffix.length - 1)}-${suffix}`;
}

/**
 * Resolve a queue binding to its stable queue id (docs/FUNCTIONS.md §4.5, §4.10, FN10).
 *
 * Queues are per-binding node-local state, not a shared resource, so there is nothing to look up:
 * the id is derived from the project's immutable id, the binding name and the queue name. A project
 * rename cannot move queued messages, and two bindings in one project never share a queue. The
 * binding's `queue` (what `batch.queue` reports to the consumer) falls back to the binding name for
 * a hand-written spec that omits it.
 */
export const resolveQueueBinding: BindingResolver = (context, binding) => {
	if (binding.type !== 'queue') {
		throw new Error(
			`Queue resolver received binding "${binding.name}" of type "${binding.type}", not "queue".`,
		);
	}
	const queue = binding.queue || binding.name;
	return {
		name: binding.name,
		type: 'queue',
		queue,
		// The contract defaults a queue binding to a producer; carry the resolved value through.
		producer: binding.producer ?? true,
		namespaceId: namespaceId(`${context.project.id}-${binding.name}-${queue}`),
	} satisfies FunctionRuntimeBinding;
};
