import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import kvWorkerSource from '../../../../packages/function-bindings/src/kv.js' with { type: 'text' };

/** Helper credential name the KV service module is embedded as (fixed contract with the helper). */
export const KV_BINDING_FILE = 'binding-kv';

/**
 * Phase-2 KV: one Yoal-supplied Worker service per binding, backed by a Durable Object namespace
 * that the service owns (docs/FUNCTIONS.md §4.5, FN10).
 *
 * The main Worker only gets the `kvNamespace` capability binding; its own `durableObjectNamespaces`
 * list stays empty because the KV Worker declares and reaches the namespace through `DO`.
 */
export const renderKvBinding: BindingRenderer = (context) => {
	const { binding, index, workload } = context;
	if (binding.type !== 'kv') {
		throw new Error(
			`KV renderer received binding "${binding.name}" of type "${binding.type}", not "kv".`,
		);
	}
	const spec = workload.function;
	if (!spec) {
		throw new Error(`Cannot render a KV binding for workload ${workload.id}: it has no function spec.`);
	}

	const serviceName = `kv-api-${index}`;
	const service = [
		`    ( name = ${capnpText(serviceName)},`,
		'      worker = (',
		'        modules = [',
		`          ( name = "kv.worker", esModule = embed ${capnpText(KV_BINDING_FILE)} ),`,
		'        ],',
		`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
		'        compatibilityFlags = [],',
		'        durableObjectNamespaces = [',
		`          ( className = "KVNamespaceObject", uniqueKey = ${capnpText(binding.namespaceId)}, enableSql = false ),`,
		'        ],',
		'        durableObjectStorage = ( localDisk = "do-storage" ),',
		'        bindings = [',
		'          ( name = "DO", durableObjectNamespace = "KVNamespaceObject" ),',
		'        ],',
		'      ) ),',
	].join('\n');

	const rendered: RenderedBinding = {
		files: { [KV_BINDING_FILE]: kvWorkerSource },
		services: [service],
		mainBindings: [
			`        ( name = ${capnpText(binding.name)}, kvNamespace = ${capnpText(serviceName)} )`,
		],
		requiresDurableStorage: true,
		namespaces: [],
	};
	return rendered;
};
