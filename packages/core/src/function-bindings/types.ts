import type { FunctionBinding, FunctionRuntimeBinding } from '@skiff/contracts';
import type { CoreContext } from '../context.ts';
import type { ProjectRow } from '../projects.ts';

/**
 * Resolve one manifest binding into the runtime shape a node renders (docs/FUNCTIONS.md §4.5).
 *
 * Resolution is where the control plane proves the binding points at something real in the org and
 * may be attached: a storage bucket grant, a database attachment, a same-project entrypoint. It
 * returns no secret values; a backend that needs credentials gets them from the activation env.
 */
export interface BindingResolveContext {
	core: CoreContext;
	project: ProjectRow;
}

export type BindingResolver = (
	context: BindingResolveContext,
	binding: FunctionBinding,
) => FunctionRuntimeBinding | Promise<FunctionRuntimeBinding>;
