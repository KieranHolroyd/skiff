import { describe, expect, test } from 'bun:test';
import { workloadDesiredSchema, type WorkloadDesired } from '@skiff/contracts';
import { capnpText } from '../function-config.ts';
import { renderHyperdrive } from './hyperdrive.ts';

const SHA = 'c'.repeat(64);
const ENV = {
	DATABASE_POOL_HOST: '127.0.0.1',
	DATABASE_POOL_PORT: '16432',
	DATABASE_USER: 'app',
	DATABASE_PASSWORD: 'hunter2',
	DATABASE_NAME: 'app_db',
};

function functionWorkload(bindings: unknown[]): WorkloadDesired {
	return workloadDesiredSchema.parse({
		id: 'wl_1',
		projectId: 'prj_1',
		projectSlug: 'api',
		deploymentId: 'dep_1',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/skiff-workloads/prj_1.sock',
		memoryMb: 128,
		cpus: 1,
		port: 3000,
		healthPath: '/__skiff/health',
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

function render(
	env: Record<string, string>,
	binding: Record<string, unknown> = { name: 'DB', type: 'hyperdrive', database: 'app-db', envPrefix: 'DATABASE' },
	index = 0,
) {
	const workload = functionWorkload([binding]);
	return renderHyperdrive({ workload, env, binding: workload.function!.bindings[0]!, index });
}

describe('renderHyperdrive', () => {
	test('renders a TCP external service and a Postgres hyperdrive binding', () => {
		const rendered = render(ENV);
		expect(rendered.files).toEqual({});
		expect(rendered.services).toEqual([
			'    ( name = "hyperdrive-0",\n      external = ( address = "127.0.0.1:16432", tcp = () ) )',
		]);
		expect(rendered.mainBindings).toEqual([
			'        ( name = "DB", hyperdrive = ( designator = "hyperdrive-0", database = "app_db", user = "app", password = "hunter2", scheme = "postgres" ) )',
		]);
		expect(rendered.requiresDurableStorage).toBeUndefined();
	});

	test('prefers the pooler values and falls back to the direct ones', () => {
		const direct = {
			DATABASE_HOST: '127.0.0.1',
			DATABASE_PORT: '15432',
			DATABASE_USER: 'app',
			DATABASE_PASSWORD: 'hunter2',
			DATABASE_NAME: 'app_db',
		};
		expect(render(direct).services[0]).toContain('address = "127.0.0.1:15432"');
		const mixed = { ...direct, DATABASE_POOL_PORT: '20000' };
		expect(render(mixed).services[0]).toContain('address = "127.0.0.1:20000"');
	});

	test('names the service by the supplied stable index', () => {
		const rendered = render(ENV, undefined, 3);
		expect(rendered.services[0]).toContain('( name = "hyperdrive-3",');
		expect(rendered.mainBindings![0]).toContain('designator = "hyperdrive-3"');
	});

	test('refuses when any credential variable is missing, naming every one', () => {
		expect(() => render({})).toThrow(
			/Hyperdrive binding "DB" cannot be rendered: the activation env is missing .*DATABASE_POOL_HOST.*DATABASE_POOL_PORT.*DATABASE_USER.*DATABASE_PASSWORD.*DATABASE_NAME/,
		);
		const partial = { ...ENV, DATABASE_USER: '' };
		expect(() => render(partial)).toThrow(/missing DATABASE_USER/);
	});

	test('refuses an invalid port', () => {
		expect(() => render({ ...ENV, DATABASE_POOL_PORT: '0' })).toThrow(/invalid DATABASE_PORT "0"/);
		expect(() => render({ ...ENV, DATABASE_POOL_PORT: '65536' })).toThrow(/invalid DATABASE_PORT "65536"/);
		expect(() => render({ ...ENV, DATABASE_POOL_PORT: '1.5' })).toThrow(/invalid DATABASE_PORT "1.5"/);
	});

	test('escapes every literal, including hostile credential bytes', () => {
		const env = {
			...ENV,
			DATABASE_USER: 'a"b',
			DATABASE_PASSWORD: 'p\\w\nx',
			DATABASE_NAME: 'db"name',
		};
		const rendered = render(env);
		expect(rendered.mainBindings![0]).toContain(`user = ${capnpText('a"b')}`);
		expect(rendered.mainBindings![0]).toContain(`password = ${capnpText('p\\w\nx')}`);
		expect(rendered.mainBindings![0]).toContain(`database = ${capnpText('db"name')}`);
		// A literal can never add a line: escaping keeps each binding on one line.
		expect(rendered.mainBindings![0]).not.toContain('\n');
	});

	test('refuses a binding of another type', () => {
		const workload = functionWorkload([{ name: 'GREETING', type: 'text', value: 'hi' }]);
		expect(() =>
			renderHyperdrive({ workload, env: ENV, binding: workload.function!.bindings[0]!, index: 0 }),
		).toThrow(/not "hyperdrive"/);
	});
});
