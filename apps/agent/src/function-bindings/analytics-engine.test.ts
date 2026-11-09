import { describe, expect, test } from 'bun:test';
import { workloadDesiredSchema, type FunctionRuntimeBinding, type WorkloadDesired } from '@yoal/contracts';
import { renderAnalyticsEngineBinding } from './analytics-engine.ts';
import type { BindingRenderContext } from './types.ts';

const SHA = 'd'.repeat(64);

/** A valid desired workload as a node receives it, parsed through the contract schema. */
function functionWorkload(
	bindings: FunctionRuntimeBinding[] = [],
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
			bindings,
			workerdVersion: '1.20261106.1',
		},
	});
}

function render(
	binding: FunctionRuntimeBinding,
	options: { workload?: WorkloadDesired; index?: number } = {},
) {
	const context: BindingRenderContext = {
		workload: options.workload ?? functionWorkload([binding]),
		env: {},
		binding,
		index: options.index ?? 0,
	};
	return renderAnalyticsEngineBinding(context);
}

const ANALYTICS_BINDING: FunctionRuntimeBinding = {
	name: 'ANALYTICS',
	type: 'analytics_engine',
	dataset: 'web_events',
};

describe('renderAnalyticsEngineBinding', () => {
	test('renders the external sink service on the agent loopback port', () => {
		const rendered = render(ANALYTICS_BINDING);
		expect(rendered.services).toEqual([
			[
				'    ( name = "analytics-sink-0",',
				'      external = ( address = "127.0.0.1:8085", http = () ) )',
			].join('\n'),
		]);
	});

	test('declares the wrapper as a Config.extensions module', () => {
		const rendered = render(ANALYTICS_BINDING);
		expect(rendered.extensions).toEqual([
			'    ( modules = [ ( name = "yoal-analytics:writer", internal = true, esModule = embed "binding-analytics" ) ] )',
		]);
	});

	test('renders the wrapped binding with dataset and ownership inner bindings', () => {
		const rendered = render(ANALYTICS_BINDING);
		expect(rendered.mainBindings).toEqual([
			[
				'        ( name = "ANALYTICS", wrapped = ( moduleName = "yoal-analytics:writer", innerBindings = [',
				'          ( name = "sink", service = "analytics-sink-0" ),',
				'          ( name = "dataset", text = "web_events" ),',
				'          ( name = "projectId", text = "prj_1" ),',
				'          ( name = "workloadId", text = "wl_1" ),',
				'        ] ) )',
			].join('\n'),
		]);
		expect(rendered.mainFields).toBeUndefined();
	});

	test('uses no Durable Object storage, namespace or disk service', () => {
		const rendered = render(ANALYTICS_BINDING);
		expect(rendered.requiresDurableStorage).toBe(false);
		expect(rendered.namespaces).toEqual([]);
		expect(rendered.services[0]).not.toContain('durableObjectStorage');
	});

	test('embeds the wrapper worker under the binding-analytics credential', () => {
		const rendered = render(ANALYTICS_BINDING);
		expect(Object.keys(rendered.files)).toEqual(['binding-analytics']);
		const source = rendered.files['binding-analytics']!;
		expect(source).toContain('export default');
		expect(source).toContain('writeDataPoint');
		expect(source).toContain('http://analytics/event');
	});

	test('numbers sinks by binding index and keeps two datasets apart', () => {
		const other: FunctionRuntimeBinding = {
			name: 'AUDIT',
			type: 'analytics_engine',
			dataset: 'audit_log',
		};
		const workload = functionWorkload([ANALYTICS_BINDING, other]);
		const first = render(ANALYTICS_BINDING, { workload, index: 0 });
		const second = render(other, { workload, index: 1 });

		expect(first.services[0]).toContain('( name = "analytics-sink-0",');
		expect(second.services[0]).toContain('( name = "analytics-sink-1",');
		expect(first.mainBindings![0]).toContain('( name = "sink", service = "analytics-sink-0" ),');
		expect(second.mainBindings![0]).toContain('( name = "sink", service = "analytics-sink-1" ),');
		expect(second.mainBindings![0]).toContain('( name = "dataset", text = "audit_log" ),');
		// The wrapper module is declared once per host, however many datasets share it.
		expect(first.extensions).toHaveLength(1);
		expect(second.extensions).toEqual([]);
	});

	test('escapes dataset and workload ids so they cannot break out of a capnp literal', () => {
		const rendered = render(
			{ ...ANALYTICS_BINDING, dataset: 'quote " backslash \\ newline\n' },
			{ workload: functionWorkload([ANALYTICS_BINDING], { workloadId: 'wl_"quoted"' }) },
		);
		expect(rendered.mainBindings![0]).toContain(
			'          ( name = "dataset", text = "quote \\" backslash \\\\ newline\\n" ),',
		);
		expect(rendered.mainBindings![0]).toContain('          ( name = "workloadId", text = "wl_\\"quoted\\"" ),');
		// The multi-line entry keeps exactly its six lines: escaping never injects a raw newline.
		expect(rendered.mainBindings![0]!.split('\n')).toHaveLength(6);
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
			upstream: 'unix//run/yoal-workloads/wl_2.sock',
			memoryMb: 128,
			cpus: 1,
			port: 3000,
			healthPath: '/health',
			socketActivation: true,
			activationVersion: SHA,
		});
		expect(() =>
			renderAnalyticsEngineBinding({ workload, env: {}, binding: ANALYTICS_BINDING, index: 0 }),
		).toThrow('has no function spec');
	});

	test('refuses a binding of another type', () => {
		expect(() => render({ name: 'CACHE', type: 'cache' })).toThrow(
			'Analytics renderer received binding "CACHE" of type "cache", not "analytics_engine".',
		);
	});
});
