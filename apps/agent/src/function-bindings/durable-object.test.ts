import { describe, expect, test } from 'bun:test';
import { workloadDesiredSchema, type WorkloadDesired } from '@yoal/contracts';
import { renderDurableObject } from './durable-object.ts';

const SHA = 'c'.repeat(64);

function functionWorkload(bindings: unknown[]): WorkloadDesired {
	return workloadDesiredSchema.parse({
		id: 'wl_1',
		projectId: 'prj_1',
		projectSlug: 'api',
		deploymentId: 'dep_1',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/yoal-workloads/prj_1.sock',
		memoryMb: 128,
		cpus: 1,
		port: 3000,
		healthPath: '/__yoal/health',
		socketActivation: true,
		activationVersion: SHA,
		function: {
			main: 'index.js',
			modules: [{ name: 'index.js', type: 'esm', sha256: SHA }],
			compatibilityDate: '2026-10-01',
			compatibilityFlags: [],
			bindings,
			workerdVersion: '1.20261106.1',
		},
	});
}

function render(bindings: unknown[]) {
	const workload = functionWorkload(bindings);
	const binding = workload.function!.bindings[0]!;
	return renderDurableObject({ workload, env: {}, binding, index: 0 });
}

describe('renderDurableObject', () => {
	test('declares one SQL-enabled namespace and a capability binding', () => {
		const rendered = render([
			{ name: 'ROOMS', type: 'durable_object', className: 'Room', uniqueKey: 'prj_1-ROOMS' },
		]);
		expect(rendered).toEqual({
			files: {},
			services: [],
			mainBindings: ['        ( name = "ROOMS", durableObjectNamespace = "Room" )'],
			namespaces: [{ className: 'Room', uniqueKey: 'prj_1-ROOMS', enableSql: true }],
			requiresDurableStorage: true,
		});
	});

	test('escapes names through capnpText and adds no service of its own', () => {
		const rendered = render([
			{ name: 'ROOMS', type: 'durable_object', className: 'Room"x', uniqueKey: 'prj_1-ROOMS' },
		]);
		expect(rendered.mainBindings).toEqual([
			'        ( name = "ROOMS", durableObjectNamespace = "Room\\"x" )',
		]);
		expect(rendered.services).toEqual([]);
		expect(rendered.files).toEqual({});
	});

	test('refuses a binding of another type', () => {
		const workload = functionWorkload([{ name: 'GREETING', type: 'text', value: 'hi' }]);
		const binding = workload.function!.bindings[0]!;
		expect(() => renderDurableObject({ workload, env: {}, binding, index: 0 })).toThrow(
			/not "durable_object"/,
		);
	});
});
