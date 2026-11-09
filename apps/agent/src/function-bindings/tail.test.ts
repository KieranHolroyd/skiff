import { describe, expect, test } from 'bun:test';
import { workloadDesiredSchema, type WorkloadDesired } from '@yoal/contracts';
import { renderTailWorker, TAIL_BINDING_FILE, TAIL_SERVICE_NAME, TAIL_SINK_SERVICE_NAME } from './tail.ts';

const SHA = 'e'.repeat(64);

/** A valid desired function workload as a node receives it, parsed through the contract schema. */
function functionWorkload(
	options: { projectId?: string; workloadId?: string; compatibilityDate?: string } = {},
): WorkloadDesired {
	return workloadDesiredSchema.parse({
		id: options.workloadId ?? 'wl_1',
		projectId: options.projectId ?? 'prj_1',
		projectSlug: 'api',
		deploymentId: 'dep_1',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/yoal-workloads/wl_1.sock',
		memoryMb: 128,
		cpus: 1,
		port: 3000,
		healthPath: '/__yoal/health',
		socketActivation: true,
		activationVersion: SHA,
		function: {
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: SHA }],
			compatibilityDate: options.compatibilityDate ?? '2026-10-01',
			compatibilityFlags: [],
			bindings: [],
			workerdVersion: '1.20261106.1',
		},
	});
}

describe('renderTailWorker', () => {
	test('embeds the tail-worker module under the binding-tail credential', () => {
		const rendered = renderTailWorker(functionWorkload());
		expect(Object.keys(rendered.files)).toEqual([TAIL_BINDING_FILE]);
		const source = rendered.files[TAIL_BINDING_FILE]!;
		expect(source).toContain('export default');
		expect(source).toContain('async tail(');
		expect(source).toContain('http://analytics/tail');
	});

	test('renders the tail Worker with the SINK binding and ownership text bindings', () => {
		const rendered = renderTailWorker(functionWorkload());
		expect(rendered.services[0]).toBe(
			[
				'    ( name = "tail-api",',
				'      worker = (',
				'        modules = [',
				'          ( name = "tail.worker", esModule = embed "binding-tail" ),',
				'        ],',
				'        compatibilityDate = "2026-10-01",',
				'        compatibilityFlags = [],',
				'        bindings = [',
				'          ( name = "SINK", service = "tail-sink" ),',
				'          ( name = "WORKLOAD_ID", text = "wl_1" ),',
				'          ( name = "PROJECT_ID", text = "prj_1" ),',
				'        ],',
				'      ) ),',
			].join('\n'),
		);
	});

	test('points the sink at the agent loopback analytics/tail server', () => {
		const rendered = renderTailWorker(functionWorkload());
		expect(rendered.services[1]).toBe(
			[
				'    ( name = "tail-sink",',
				'      external = ( address = "127.0.0.1:8085", http = () ) )',
			].join('\n'),
		);
		expect(TAIL_SINK_SERVICE_NAME).toBe('tail-sink');
	});

	test('asks the main Worker to deliver its tails to tail-api', () => {
		const rendered = renderTailWorker(functionWorkload());
		expect(rendered.mainFields).toEqual([`        tails = [ "tail-api" ]`]);
		expect(TAIL_SERVICE_NAME).toBe('tail-api');
	});

	test('uses no Durable Object storage, namespace or disk service', () => {
		const rendered = renderTailWorker(functionWorkload());
		expect(rendered.requiresDurableStorage).toBe(false);
		expect(rendered.namespaces).toEqual([]);
		expect(rendered.services.join('\n')).not.toContain('durableObjectStorage');
	});

	test('escapes workload ids so they cannot break out of a capnp literal', () => {
		const rendered = renderTailWorker(functionWorkload({ workloadId: 'wl_"quoted"', projectId: 'prj_\\x' }));
		expect(rendered.services[0]).toContain(`( name = "WORKLOAD_ID", text = "wl_\\"quoted\\"" ),`);
		expect(rendered.services[0]).toContain(`( name = "PROJECT_ID", text = "prj_\\\\x" ),`);
		// Escaping never injects a raw newline: the block keeps exactly its thirteen lines.
		expect(rendered.services[0]!.split('\n')).toHaveLength(13);
	});

	test('refuses a workload with no function spec', () => {
		const workload = workloadDesiredSchema.parse({
			id: 'wl_2',
			projectId: 'prj_1',
			projectSlug: 'api',
			deploymentId: 'dep_1',
			runtime: 'process',
			status: 'running',
			release: SHA,
			command: ['bun', 'run', 'start'],
			upstream: 'unix//run/yoal-workloads/wl_2.sock',
			memoryMb: 128,
			cpus: 1,
			port: 3000,
			healthPath: '/health',
			socketActivation: true,
			activationVersion: SHA,
		});
		expect(() => renderTailWorker(workload)).toThrow('has no function spec');
	});
});
