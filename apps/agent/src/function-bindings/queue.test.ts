import { describe, expect, test } from 'bun:test';
import type { FunctionRuntimeBinding, WorkloadDesired } from '@skiff/contracts';
import { renderQueueBinding } from './queue.ts';

function workload(compatibilityDate = '2026-10-01'): WorkloadDesired {
	return {
		id: 'wl_1',
		projectId: 'prj_1',
		projectSlug: 'api',
		runtime: 'function',
		function: { compatibilityDate },
	} as unknown as WorkloadDesired;
}

function queueBinding(
	name = 'JOBS',
	namespaceId = 'prj_1-JOBS-jobs',
	queue = 'jobs',
): FunctionRuntimeBinding {
	return { name, type: 'queue', queue, producer: true, namespaceId };
}

function render(binding: FunctionRuntimeBinding, index = 0, compatibilityDate?: string) {
	return renderQueueBinding({
		workload: workload(compatibilityDate),
		env: {},
		binding,
		index,
	});
}

const EXPECTED_SERVICE = `    ( name = "queue-api-0",
      worker = (
        modules = [
          ( name = "queue.worker", esModule = embed "binding-queue" ),
        ],
        compatibilityDate = "2026-10-01",
        compatibilityFlags = [],
        durableObjectNamespaces = [
          ( className = "QueueBroker", uniqueKey = "prj_1-JOBS-jobs", enableSql = false ),
        ],
        durableObjectStorage = ( localDisk = "do-storage" ),
        bindings = [
          ( name = "DO", durableObjectNamespace = "QueueBroker" ),
          ( name = "CONSUMER", service = "main" ),
          ( name = "QUEUE_NAME", text = "jobs" ),
        ],
      ) ),`;

describe('renderQueueBinding', () => {
	test('renders the exact queue service block, file, main binding and storage flags', () => {
		const rendered = render(queueBinding());
		expect(rendered.services).toEqual([EXPECTED_SERVICE]);
		expect(rendered.mainBindings).toEqual([
			'        ( name = "JOBS", queue = "queue-api-0" )',
		]);
		expect(rendered.requiresDurableStorage).toBe(true);
		expect(rendered.namespaces).toEqual([]);
		expect(Object.keys(rendered.files)).toEqual(['binding-queue']);
		expect(rendered.files['binding-queue']).toContain('export class QueueBroker');
		expect(rendered.files['binding-queue']).toContain(
			'Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk',
		);
	});

	test('uses the workload compatibility date and the binding index in the service name', () => {
		const rendered = render(queueBinding('EVENTS', 'prj_1-EVENTS-events', 'events'), 7, '2026-11-06');
		expect(rendered.services[0]).toContain('( name = "queue-api-7",');
		expect(rendered.services[0]).toContain('compatibilityDate = "2026-11-06"');
		expect(rendered.services[0]).toContain('uniqueKey = "prj_1-EVENTS-events"');
		expect(rendered.services[0]).toContain('( name = "QUEUE_NAME", text = "events" )');
		expect(rendered.mainBindings).toEqual([
			'        ( name = "EVENTS", queue = "queue-api-7" )',
		]);
	});

	test('falls back to the binding name when the runtime binding has no queue name', () => {
		const rendered = render({
			name: 'JOBS',
			type: 'queue',
			namespaceId: 'prj_1-JOBS-JOBS',
			producer: true,
		} as unknown as FunctionRuntimeBinding);
		expect(rendered.services[0]).toContain('( name = "QUEUE_NAME", text = "JOBS" )');
	});

	test('escapes the binding name, queue name and namespace id as Cap’n Proto text', () => {
		const rendered = render(
			queueBinding('JOBS"1', 'ns"bad\\id', 'jobs"\nname'),
		);
		expect(rendered.mainBindings?.[0]).toBe(
			'        ( name = "JOBS\\"1", queue = "queue-api-0" )',
		);
		expect(rendered.services[0]).toContain('uniqueKey = "ns\\"bad\\\\id"');
		expect(rendered.services[0]).toContain('( name = "QUEUE_NAME", text = "jobs\\"\\nname" )');
	});

	test('two queue bindings get distinct service names but reuse the same worker file', () => {
		const first = render(queueBinding('FIRST', 'prj_1-FIRST-one', 'one'), 0);
		const second = render(queueBinding('SECOND', 'prj_1-SECOND-two', 'two'), 1);
		expect(first.services[0]).toContain('( name = "queue-api-0",');
		expect(second.services[0]).toContain('( name = "queue-api-1",');
		expect(first.services[0]).not.toBe(second.services[0]);
		expect(first.mainBindings?.[0]).toContain('queue = "queue-api-0"');
		expect(second.mainBindings?.[0]).toContain('queue = "queue-api-1"');
		expect(first.files['binding-queue']).toBe(second.files['binding-queue']);
	});

	test('never renders activation secrets into the config or the file map', () => {
		const rendered = renderQueueBinding({
			workload: workload(),
			env: { SECRET: 'hunter2', QUEUE_TOKEN: 'correct horse' },
			binding: queueBinding(),
			index: 0,
		});
		expect(JSON.stringify(rendered)).not.toContain('hunter2');
		expect(JSON.stringify(rendered)).not.toContain('correct horse');
	});

	test('refuses a non-queue binding and a workload without a function spec', () => {
		expect(() =>
			renderQueueBinding({
				workload: workload(),
				env: {},
				binding: { name: 'KV', type: 'kv', namespaceId: 'x' } as FunctionRuntimeBinding,
				index: 0,
			}),
		).toThrow('Queue renderer received binding "KV" of type "kv", not "queue".');

		expect(() =>
			renderQueueBinding({
				workload: { id: 'wl_1', projectSlug: 'api', runtime: 'function' } as WorkloadDesired,
				env: {},
				binding: queueBinding(),
				index: 0,
			}),
		).toThrow('Cannot render a queue binding for workload wl_1: it has no function spec.');
	});
});
