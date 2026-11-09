import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import queueWorkerSource from '../../../../packages/function-bindings/src/queue.js' with { type: 'text' };
import { embedSource } from './embed-source.ts' with { type: 'macro' };

// Not a text import: function-queues.ts imports nats.js as a module, and `bun build` cannot hold one
// file as both (see embed-source.ts).
const natsSource = embedSource('../../../../packages/function-bindings/src/nats.js');

/** Helper credential names the queue service modules are embedded as (fixed contract with the helper). */
export const QUEUE_BINDING_FILE = 'binding-queue';
export const NATS_BINDING_FILE = 'binding-nats';

/**
 * Queues on the managed broker (docs/FUNCTIONS.md §4.5, §4.10, D112).
 *
 * The main Worker gets workerd's `queue` capability binding, which makes `send`, `sendBatch` and
 * `metrics` POST to a Yoal-supplied service. That service publishes to a JetStream stream on the
 * project's attached broker over a raw TCP socket: an `external` service at the broker's loopback
 * port, the same pattern as Hyperdrive, so the user Worker's own `globalOutbound` stays
 * public-only. The broker user and password reach the service through `fromEnvironment` (the
 * attachment's activation env), so the rendered config carries no secret and needs no disk state.
 *
 * Consumption is not rendered here: the agent pulls batches and delivers them to the shim
 * (`function-queues.ts`), which keeps delivery working while the consumer is idle-stopped.
 */
export const renderQueueBinding: BindingRenderer = (context) => {
	const { binding, env, index, workload } = context;
	if (binding.type !== 'queue')
		throw new Error(`Queue renderer received binding "${binding.name}" of type "${binding.type}", not "queue".`);
	const spec = workload.function;
	if (!spec) throw new Error(`Cannot render a queue binding for workload ${workload.id}: it has no function spec.`);
	const prefix = binding.envPrefix;
	if (!prefix)
		throw new Error(
			`Queue binding "${binding.name}" predates managed brokers (D112). Attach a broker to the project and deploy again.`,
		);
	const port = env[`${prefix}_PORT`];
	if (port === undefined || port === '')
		throw new Error(
			`Queue binding "${binding.name}" cannot be rendered: the activation env has no ${prefix}_PORT. ` +
				`Attach broker "${binding.broker ?? '?'}" to this project (prefix ${prefix}) and deploy again.`,
		);
	if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535)
		throw new Error(`Queue binding "${binding.name}" has an invalid ${prefix}_PORT "${port}".`);

	const address = `127.0.0.1:${Number(port)}`;
	const serviceName = `queue-api-${index}`;
	const brokerService = `queue-broker-${index}`;
	const services = [
		[`    ( name = ${capnpText(brokerService)},`, `      external = ( address = ${capnpText(address)}, tcp = () ) )`].join('\n'),
		[
			`    ( name = ${capnpText(serviceName)},`,
			'      worker = (',
			'        modules = [',
			// `queue.js` imports `./nats.js`; workerd resolves it against these module names.
			`          ( name = "queue.js", esModule = embed ${capnpText(QUEUE_BINDING_FILE)} ),`,
			`          ( name = "nats.js", esModule = embed ${capnpText(NATS_BINDING_FILE)} ),`,
			'        ],',
			`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
			'        compatibilityFlags = [],',
			'        bindings = [',
			`          ( name = "BROKER", service = ${capnpText(brokerService)} ),`,
			`          ( name = "BROKER_ADDRESS", text = ${capnpText(address)} ),`,
			`          ( name = "BROKER_USER", fromEnvironment = ${capnpText(`${prefix}_USER`)} ),`,
			`          ( name = "BROKER_PASSWORD", fromEnvironment = ${capnpText(`${prefix}_PASSWORD`)} ),`,
			`          ( name = "QUEUE_NAME", text = ${capnpText(binding.queue)} ),`,
			'        ],',
			'      ) )',
		].join('\n'),
	];

	const rendered: RenderedBinding = {
		// The text import resolves to nats.d.ts for the type checker; at runtime it is the source text.
		files: { [QUEUE_BINDING_FILE]: queueWorkerSource, [NATS_BINDING_FILE]: natsSource as unknown as string },
		services,
		mainBindings: [`        ( name = ${capnpText(binding.name)}, queue = ${capnpText(serviceName)} )`],
		requiresDurableStorage: false,
		namespaces: [],
	};
	return rendered;
};
