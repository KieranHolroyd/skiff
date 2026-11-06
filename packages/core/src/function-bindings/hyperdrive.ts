import { and, eq, isNull } from 'drizzle-orm';
import { databaseAttachments, databases } from '@skiff/db';
import type { FunctionRuntimeBinding } from '@skiff/contracts';
import { ValidationError } from '../errors.ts';
import type { BindingResolveContext, BindingResolver } from './types.ts';

/**
 * Hyperdrive (docs/FUNCTIONS.md §4.5): workerd's native binding to a managed Postgres database
 * through its PgBouncer sidecar (or the direct loopback port).
 *
 * The control plane proves the database exists in the caller's org, is Postgres and is attached to
 * this project. It never returns a credential: the connection values reach the node through the
 * attachment's activation env (`<PREFIX>_POOL_HOST`, `_USER`, …), and the agent embeds them in the
 * 0600 helper credential.
 */
export const resolveHyperdrive: BindingResolver = (context: BindingResolveContext, binding) => {
	if (binding.type !== 'hyperdrive') {
		throw new Error(
			`Hyperdrive resolver received binding "${binding.name}" of type "${binding.type}", not "hyperdrive".`,
		);
	}

	const database = context.core.db
		.select()
		.from(databases)
		.where(
			and(
				eq(databases.orgId, context.project.orgId),
				eq(databases.name, binding.database),
				isNull(databases.deletedAt),
			),
		)
		.get();
	if (!database)
		throw new ValidationError(
			`Binding ${binding.name}: database "${binding.database}" does not exist in this organisation.`,
		);
	if (database.engine !== 'postgres')
		throw new ValidationError(
			`Binding ${binding.name}: database "${binding.database}" is ${database.engine}; Hyperdrive bindings need a Postgres database.`,
		);

	// The attachment is what puts `<PREFIX>_*` in the workload's activation env. Without it the
	// node has no credentials to render, so refuse at deploy time instead of failing the apply.
	const attachment = context.core.db
		.select()
		.from(databaseAttachments)
		.where(
			and(
				eq(databaseAttachments.databaseId, database.id),
				eq(databaseAttachments.projectId, context.project.id),
			),
		)
		.get();
	if (!attachment)
		throw new ValidationError(
			`Binding ${binding.name}: attach database "${binding.database}" to this project before using it as a Hyperdrive binding.`,
		);

	return {
		name: binding.name,
		type: 'hyperdrive',
		database: binding.database,
		envPrefix: attachment.envPrefix ?? 'DATABASE',
	} satisfies FunctionRuntimeBinding;
};
