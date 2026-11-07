import { describe, expect, test } from 'bun:test';
import type { FunctionRuntimeBinding, WorkloadDesired } from '@skiff/contracts';
import { NATS_BINDING_FILE, QUEUE_BINDING_FILE, renderQueueBinding } from './queue.ts';

/** Queue producer service on the managed broker (D112). */
function workload(compatibilityDate = '2026-10-01'): WorkloadDesired {
	return { id: 'wl_1', projectId: 'prj_1', projectSlug: 'api', runtime: 'function', function: { compatibilityDate } } as unknown as WorkloadDesired;
}

const binding = (overrides: Record<string, unknown> = {}): FunctionRuntimeBinding =>
	({ name: 'JOBS', type: 'queue', queue: 'jobs', producer: true, broker: 'events', envPrefix: 'NATS', ...overrides }) as FunctionRuntimeBinding;

const env = { NATS_PORT: '14222', NATS_USER: 'events', NATS_PASSWORD: 'secret' };

describe('renderQueueBinding', () => {
	test('renders a producer service that reaches the broker through an external TCP service', () => {
		const rendered = renderQueueBinding({ workload: workload(), env, binding: binding(), index: 2 });
		expect(rendered.services[0]).toBe('    ( name = "queue-broker-2",\n      external = ( address = "127.0.0.1:14222", tcp = () ) )');
		const service = rendered.services[1]!;
		expect(service).toContain('( name = "queue.js", esModule = embed "binding-queue" )');
		expect(service).toContain('( name = "nats.js", esModule = embed "binding-nats" )');
		expect(service).toContain('( name = "BROKER", service = "queue-broker-2" )');
		expect(service).toContain('( name = "BROKER_USER", fromEnvironment = "NATS_USER" )');
		expect(service).toContain('( name = "BROKER_PASSWORD", fromEnvironment = "NATS_PASSWORD" )');
		expect(service).toContain('( name = "QUEUE_NAME", text = "jobs" )');
		expect(rendered.mainBindings).toEqual(['        ( name = "JOBS", queue = "queue-api-2" )']);
		expect(rendered.requiresDurableStorage).toBe(false);
		// The password is read from the environment, never rendered into the config.
		expect(rendered.services.join('\n')).not.toContain('secret');
		expect(rendered.files[QUEUE_BINDING_FILE]).toContain("from './nats.js'");
		expect(rendered.files[NATS_BINDING_FILE]).toContain('export class NatsConnection');
	});

	test('refuses specs it cannot serve with an actionable message', () => {
		expect(() =>
			renderQueueBinding({ workload: workload(), env, binding: binding({ envPrefix: undefined, namespaceId: 'prj_1-JOBS' }), index: 0 }),
		).toThrow(/predates managed brokers/);
		expect(() => renderQueueBinding({ workload: workload(), env: {}, binding: binding(), index: 0 })).toThrow(
			/no NATS_PORT.*Attach broker "events"/,
		);
		expect(() => renderQueueBinding({ workload: workload(), env: { ...env, NATS_PORT: '99999' }, binding: binding(), index: 0 })).toThrow(
			/invalid NATS_PORT/,
		);
	});
});
