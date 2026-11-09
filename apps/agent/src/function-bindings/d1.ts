import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import d1WorkerSource from '../../../../packages/function-bindings/src/d1.js' with { type: 'text' };

/** Helper credential name the D1 service module is embedded as (fixed contract with the helper). */
export const D1_BINDING_FILE = 'binding-d1';

/**
 * Phase-2 D1: workerd's own internal `cloudflare-internal:d1-api` module, wrapped around one
 * Yoal-supplied service per binding (docs/FUNCTIONS.md §4.5, FN10).
 *
 * D1 is the one binding workerd does not implement natively, so the user Worker gets a `wrapped`
 * binding rather than a capability: workerd instantiates the internal d1-api module with a single
 * inner binding, `fetcher`, which is this service. Every `prepare()`/`bind()`/`all()`/`run()` the
 * user makes becomes an HTTP request to that service, whose Durable Object holds the SQLite
 * database. This mirrors Miniflare's D1 plugin.
 *
 * The namespace belongs to the *service's* Worker, not the main one, so the main Worker's
 * `durableObjectNamespaces` list stays empty; only the process-wide `do-storage` disk service is
 * shared (FN11).
 */
export const renderD1Binding: BindingRenderer = (context) => {
	const { binding, index, workload } = context;
	if (binding.type !== 'd1') {
		throw new Error(
			`D1 renderer received binding "${binding.name}" of type "${binding.type}", not "d1".`,
		);
	}
	const spec = workload.function;
	if (!spec) {
		throw new Error(`Cannot render a D1 binding for workload ${workload.id}: it has no function spec.`);
	}

	const serviceName = `d1-api-${index}`;
	const service = [
		`    ( name = ${capnpText(serviceName)},`,
		'      worker = (',
		'        modules = [',
		`          ( name = "d1.worker", esModule = embed ${capnpText(D1_BINDING_FILE)} ),`,
		'        ],',
		`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
		'        compatibilityFlags = [],',
		'        durableObjectNamespaces = [',
		// `enableSql` is what exposes `state.storage.sql` to the service's own object; without it
		// workerd hides the SQL API and the database would not exist.
		`          ( className = "D1DatabaseObject", uniqueKey = ${capnpText(binding.namespaceId)}, enableSql = true ),`,
		'        ],',
		'        durableObjectStorage = ( localDisk = "do-storage" ),',
		'        bindings = [',
		// The service reaches its own object through the same namespace it declares (KV's pattern).
		'          ( name = "DO", durableObjectNamespace = "D1DatabaseObject" ),',
		'        ],',
		'      ) ),',
	].join('\n');

	const rendered: RenderedBinding = {
		files: { [D1_BINDING_FILE]: d1WorkerSource },
		services: [service],
		mainBindings: [
			[
				`        ( name = ${capnpText(binding.name)}, wrapped = ( moduleName = "cloudflare-internal:d1-api", innerBindings = [`,
				`          ( name = "fetcher", service = ${capnpText(serviceName)} ),`,
				'        ] ) )',
			].join('\n'),
		],
		requiresDurableStorage: true,
		namespaces: [],
	};
	return rendered;
};
