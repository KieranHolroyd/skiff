import type { CoreContext } from '../context.ts';
import { projectActions } from './project-actions.ts';
import { pruneAction } from './prune.ts';
import { OperationService } from './service.ts';

export { OperationService } from './service.ts';
export type * from './types.ts';

/** The operation service with every built-in action registered (docs/OPERATIONS.md §2.4). */
export function createOperationService(ctx: CoreContext): OperationService {
	const service = new OperationService(ctx);
	for (const definition of projectActions()) service.register(definition);
	service.register(pruneAction);
	return service;
}
