import { FUNCTION_ANALYTICS_PORT } from '@yoal/contracts';
import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import analyticsWorkerSource from '../../../../packages/function-bindings/src/analytics.js' with { type: 'text' };

/** Helper credential name the Analytics Engine wrapper module is embedded as. */
export const ANALYTICS_BINDING_FILE = 'binding-analytics';
/** `Config.extensions` module name the wrapped binding refers to. */
export const ANALYTICS_EXTENSION_MODULE = 'yoal-analytics:writer';

/**
 * Phase-2 Analytics Engine: workerd's `analyticsEngine` capability is a **wrapped binding** whose
 * wrapper is an extension module, exactly as Miniflare implements its simulator
 * (`Worker_Binding.wrapped` in workerd.capnp). The wrapper module runs inside the user Worker's
 * own isolate and turns `env.<binding>.writeDataPoint()` into a POST to the node agent's loopback
 * sink (docs/FUNCTIONS.md §4.5, D101, FN10).
 *
 * Each binding gets one `external` HTTP service pointing at the agent's sink, and one `wrapped`
 * entry in the main Worker's bindings. The dataset and the owning project/workload ride as inner
 * text bindings so the wrapper can stamp every event without trusting the Worker. Nothing here
 * needs Durable Object storage, a namespace or credentials, so the config stays cacheable.
 */
export const renderAnalyticsEngineBinding: BindingRenderer = (context) => {
	const { binding, index, workload } = context;
	if (binding.type !== 'analytics_engine') {
		throw new Error(
			`Analytics renderer received binding "${binding.name}" of type "${binding.type}", not "analytics_engine".`,
		);
	}
	const spec = workload.function;
	if (!spec) {
		throw new Error(
			`Cannot render an Analytics Engine binding for workload ${workload.id}: it has no function spec.`,
		);
	}

	const serviceName = `analytics-sink-${index}`;
	const service = `    ( name = ${capnpText(serviceName)},\n      external = ( address = ${capnpText(`127.0.0.1:${FUNCTION_ANALYTICS_PORT}`)}, http = () ) )`;

	// One extension per host: workerd resolves extension modules by name, so emitting the same
	// `yoal-analytics:writer` block twice (one per binding) would be a duplicate definition. The
	// first Analytics binding in the list declares it; every wrapped binding points at it.
	const extension = `    ( modules = [ ( name = ${capnpText(ANALYTICS_EXTENSION_MODULE)}, internal = true, esModule = embed ${capnpText(ANALYTICS_BINDING_FILE)} ) ] )`;
	const declaresExtension = spec.bindings.find((entry) => entry.type === 'analytics_engine')?.name === binding.name;

	const mainBinding = [
		`        ( name = ${capnpText(binding.name)}, wrapped = ( moduleName = ${capnpText(ANALYTICS_EXTENSION_MODULE)}, innerBindings = [`,
		`          ( name = "sink", service = ${capnpText(serviceName)} ),`,
		`          ( name = "dataset", text = ${capnpText(binding.dataset)} ),`,
		`          ( name = "projectId", text = ${capnpText(workload.projectId)} ),`,
		`          ( name = "workloadId", text = ${capnpText(workload.id)} ),`,
		'        ] ) )',
	].join('\n');

	const rendered: RenderedBinding = {
		files: { [ANALYTICS_BINDING_FILE]: analyticsWorkerSource },
		services: [service],
		mainBindings: [mainBinding],
		extensions: declaresExtension ? [extension] : [],
		requiresDurableStorage: false,
		namespaces: [],
	};
	return rendered;
};
