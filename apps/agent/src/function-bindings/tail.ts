import { FUNCTION_ANALYTICS_PORT, type WorkloadDesired } from '@yoal/contracts';
import type { RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import tailWorkerSource from '../../../../packages/function-bindings/src/tail.js' with { type: 'text' };

/** Helper credential name the tail-worker module is embedded as (fixed contract with the helper). */
export const TAIL_BINDING_FILE = 'binding-tail';
/** Service name the main Worker lists in `tails`. */
export const TAIL_SERVICE_NAME = 'tail-api';
/** Service name the tail Worker binds as `SINK`. */
export const TAIL_SINK_SERVICE_NAME = 'tail-sink';

/**
 * Phase-3 Tail Workers (docs/FUNCTIONS.md §4.5): every function host gets one small Worker that
 * workerd calls with each invocation's tail events, and which forwards a redacted batch to the
 * node agent's loopback sink.
 *
 * Unlike the binding renderers this is not driven by a user binding: it is always present, so the
 * composer merges it after the binding fragments. The tail Worker talks to the same loopback
 * server as the Analytics Engine sink (one `POST /tail` beside `POST /event`), and the workload's
 * project/id ride as text bindings so the sink never trusts an event for its tenant attribution.
 * It needs no Durable Object storage, namespace or credentials.
 *
 * @param workload A desired function workload; its `function` spec supplies the compatibility date.
 */
export function renderTailWorker(workload: WorkloadDesired): RenderedBinding {
	const spec = workload.function;
	if (!spec)
		throw new Error(`Cannot render a tail worker for workload ${workload.id}: it has no function spec.`);

	const service = [
		`    ( name = ${capnpText(TAIL_SERVICE_NAME)},`,
		'      worker = (',
		'        modules = [',
		`          ( name = "tail.worker", esModule = embed ${capnpText(TAIL_BINDING_FILE)} ),`,
		'        ],',
		`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
		'        compatibilityFlags = [],',
		'        bindings = [',
		`          ( name = "SINK", service = ${capnpText(TAIL_SINK_SERVICE_NAME)} ),`,
		`          ( name = "WORKLOAD_ID", text = ${capnpText(workload.id)} ),`,
		`          ( name = "PROJECT_ID", text = ${capnpText(workload.projectId)} ),`,
		'        ],',
		'      ) ),',
	].join('\n');
	const sink = [
		`    ( name = ${capnpText(TAIL_SINK_SERVICE_NAME)},`,
		`      external = ( address = ${capnpText(`127.0.0.1:${FUNCTION_ANALYTICS_PORT}`)}, http = () ) )`,
	].join('\n');

	return {
		files: { [TAIL_BINDING_FILE]: tailWorkerSource },
		services: [service, sink],
		mainFields: [`        tails = [ ${capnpText(TAIL_SERVICE_NAME)} ]`],
		requiresDurableStorage: false,
		namespaces: [],
	};
}
