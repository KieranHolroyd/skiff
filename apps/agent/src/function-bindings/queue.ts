import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import queueWorkerSource from '../../../../packages/function-bindings/src/queue.js' with { type: 'text' };

/** Helper credential name the queue service module is embedded as (fixed contract with the helper). */
export const QUEUE_BINDING_FILE = 'binding-queue';

/**
 * Phase-3 queues: one Skiff-supplied Worker service per binding, backed by a Durable Object
 * namespace that the service owns (docs/FUNCTIONS.md §4.5, §4.10, FN10).
 *
 * The main Worker only gets the `queue` capability binding, which makes workerd's producer API
 * (`send`, `sendBatch`, `metrics`) POST to this service. The service's Durable Object then delivers
 * batches to the function shim's `/__skiff/queue` route through the `CONSUMER` service binding, and
 * the shim calls the user's `queue(batch, env, ctx)`. As with KV, the main Worker's own
 * `durableObjectNamespaces` list stays empty because the service declares and reaches the namespace
 * through `DO`.
 */
export const renderQueueBinding: BindingRenderer = (context) => {
	const { binding, index, workload } = context;
	if (binding.type !== 'queue') {
		throw new Error(
			`Queue renderer received binding "${binding.name}" of type "${binding.type}", not "queue".`,
		);
	}
	const spec = workload.function;
	if (!spec) {
		throw new Error(
			`Cannot render a queue binding for workload ${workload.id}: it has no function spec.`,
		);
	}

	// The queue name is what `batch.queue` shows the consumer; fall back to the binding name when a
	// hand-written runtime spec omits it, mirroring the resolver.
	const queueName = binding.queue || binding.name;
	const serviceName = `queue-api-${index}`;
	const service = [
		`    ( name = ${capnpText(serviceName)},`,
		'      worker = (',
		'        modules = [',
		`          ( name = "queue.worker", esModule = embed ${capnpText(QUEUE_BINDING_FILE)} ),`,
		'        ],',
		`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
		'        compatibilityFlags = [],',
		'        durableObjectNamespaces = [',
		`          ( className = "QueueBroker", uniqueKey = ${capnpText(binding.namespaceId)}, enableSql = false ),`,
		'        ],',
		'        durableObjectStorage = ( localDisk = "do-storage" ),',
		'        bindings = [',
		'          ( name = "DO", durableObjectNamespace = "QueueBroker" ),',
		'          ( name = "CONSUMER", service = "main" ),',
		`          ( name = "QUEUE_NAME", text = ${capnpText(queueName)} ),`,
		'        ],',
		'      ) ),',
	].join('\n');

	const rendered: RenderedBinding = {
		files: { [QUEUE_BINDING_FILE]: queueWorkerSource },
		services: [service],
		mainBindings: [
			`        ( name = ${capnpText(binding.name)}, queue = ${capnpText(serviceName)} )`,
		],
		requiresDurableStorage: true,
		namespaces: [],
	};
	return rendered;
};
