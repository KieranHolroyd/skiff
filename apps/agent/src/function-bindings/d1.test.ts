import { describe, expect, test } from 'bun:test';
import type { FunctionRuntimeBinding, WorkloadDesired } from '@skiff/contracts';
import { renderD1Binding } from './d1.ts';

function workload(compatibilityDate = '2026-10-01'): WorkloadDesired {
	return {
		id: 'wl_1',
		projectId: 'prj_1',
		projectSlug: 'api',
		runtime: 'function',
		function: { compatibilityDate },
	} as unknown as WorkloadDesired;
}

function d1Binding(
	name = 'DB',
	database = 'main',
	namespaceId = 'prj_1-DB-main',
): FunctionRuntimeBinding {
	return { name, type: 'd1', database, namespaceId };
}

function render(binding: FunctionRuntimeBinding, index = 0, compatibilityDate?: string) {
	return renderD1Binding({
		workload: workload(compatibilityDate),
		env: {},
		binding,
		index,
	});
}

const EXPECTED_SERVICE = `    ( name = "d1-api-0",
      worker = (
        modules = [
          ( name = "d1.worker", esModule = embed "binding-d1" ),
        ],
        compatibilityDate = "2026-10-01",
        compatibilityFlags = [],
        durableObjectNamespaces = [
          ( className = "D1DatabaseObject", uniqueKey = "prj_1-DB-main", enableSql = true ),
        ],
        durableObjectStorage = ( localDisk = "do-storage" ),
        bindings = [
          ( name = "DO", durableObjectNamespace = "D1DatabaseObject" ),
        ],
      ) ),`;

const EXPECTED_MAIN_BINDING = `        ( name = "DB", wrapped = ( moduleName = "cloudflare-internal:d1-api", innerBindings = [
          ( name = "fetcher", service = "d1-api-0" ),
        ] ) )`;

describe('renderD1Binding', () => {
	test('renders the exact D1 service block, file, wrapped binding and storage flags', () => {
		const rendered = render(d1Binding());
		expect(rendered.services).toEqual([EXPECTED_SERVICE]);
		expect(rendered.mainBindings).toEqual([EXPECTED_MAIN_BINDING]);
		expect(rendered.requiresDurableStorage).toBe(true);
		expect(rendered.namespaces).toEqual([]);
		expect(Object.keys(rendered.files)).toEqual(['binding-d1']);
		expect(rendered.files['binding-d1']).toContain('export class D1DatabaseObject');
		expect(rendered.files['binding-d1']).toContain(
			'Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk',
		);
	});

	test('uses the workload compatibility date and the binding index in the service name', () => {
		const rendered = render(d1Binding('LEDGER', 'books', 'prj_1-LEDGER-books'), 7, '2026-11-06');
		expect(rendered.services[0]).toContain('( name = "d1-api-7",');
		expect(rendered.services[0]).toContain('compatibilityDate = "2026-11-06"');
		expect(rendered.services[0]).toContain('uniqueKey = "prj_1-LEDGER-books"');
		expect(rendered.mainBindings).toEqual([
			`        ( name = "LEDGER", wrapped = ( moduleName = "cloudflare-internal:d1-api", innerBindings = [
          ( name = "fetcher", service = "d1-api-7" ),
        ] ) )`,
		]);
	});

	test('escapes the binding name and namespace id as Cap’n Proto text', () => {
		const rendered = render(d1Binding('DB"1', 'main', 'ns"bad\\id'));
		expect(rendered.mainBindings?.[0]).toContain('( name = "DB\\"1",');
		expect(rendered.services[0]).toContain('uniqueKey = "ns\\"bad\\\\id"');
	});

	test('two D1 bindings get distinct services and namespaces but reuse the same worker file', () => {
		const first = render(d1Binding('FIRST', 'one', 'prj_1-FIRST-one'), 0);
		const second = render(d1Binding('SECOND', 'two', 'prj_1-SECOND-two'), 1);
		expect(first.services[0]).toContain('( name = "d1-api-0",');
		expect(second.services[0]).toContain('( name = "d1-api-1",');
		expect(first.services[0]).not.toBe(second.services[0]);
		expect(first.mainBindings?.[0]).toContain('service = "d1-api-0"');
		expect(second.mainBindings?.[0]).toContain('service = "d1-api-1"');
		expect(first.files['binding-d1']).toBe(second.files['binding-d1']);
	});

	test('never renders activation secrets into the config or the file map', () => {
		const rendered = renderD1Binding({
			workload: workload(),
			env: { SECRET: 'hunter2', DB_PASSWORD: 'correct horse' },
			binding: d1Binding(),
			index: 0,
		});
		expect(JSON.stringify(rendered)).not.toContain('hunter2');
		expect(JSON.stringify(rendered)).not.toContain('correct horse');
	});

	test('refuses a non-D1 binding and a workload without a function spec', () => {
		expect(() =>
			renderD1Binding({
				workload: workload(),
				env: {},
				binding: { name: 'KV', type: 'kv', namespaceId: 'prj_1-KV' } as FunctionRuntimeBinding,
				index: 0,
			}),
		).toThrow('D1 renderer received binding "KV" of type "kv", not "d1".');

		expect(() =>
			renderD1Binding({
				workload: { id: 'wl_1', projectSlug: 'api', runtime: 'function' } as WorkloadDesired,
				env: {},
				binding: d1Binding(),
				index: 0,
			}),
		).toThrow('Cannot render a D1 binding for workload wl_1: it has no function spec.');
	});
});
