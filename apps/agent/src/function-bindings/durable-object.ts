import { capnpText } from '../function-config.ts';
import type { BindingRenderer } from './types.ts';

/**
 * Durable Objects (docs/FUNCTIONS.md §4.5, FN11): a native workerd capability, no sibling service.
 *
 * The main Worker declares the class once in `durableObjectNamespaces` and each binding becomes a
 * `durableObjectNamespace` capability pointing at that class. Storage is the shared `do-storage`
 * disk service the helper makes writable under the workload's state directory, so object data is
 * single-node SQLite on the project's volume (D72/D74).
 */
export const renderDurableObject: BindingRenderer = ({ binding }) => {
	if (binding.type !== 'durable_object')
		throw new Error(
			`Durable Object renderer received binding "${binding.name}" of type "${binding.type}", not "durable_object".`,
		);
	return {
		files: {},
		services: [],
		mainBindings: [
			`        ( name = ${capnpText(binding.name)}, durableObjectNamespace = ${capnpText(binding.className)} )`,
		],
		namespaces: [
			{
				className: binding.className,
				uniqueKey: binding.uniqueKey,
				// Users write SQL against `ctx.storage.sql`; the namespace must opt in (FN11).
				enableSql: true,
			},
		],
		requiresDurableStorage: true,
	};
};
