import { describe, expect, test } from 'bun:test';
import type { FunctionRuntimeBinding, WorkloadDesired } from '@skiff/contracts';
import { renderKvBinding } from './kv.ts';

function workload(compatibilityDate = '2026-10-01'): WorkloadDesired {
	return {
		id: 'wl_1',
		projectId: 'prj_1',
		projectSlug: 'api',
		runtime: 'function',
		function: { compatibilityDate },
	} as unknown as WorkloadDesired;
}

function kvBinding(name = 'KV', namespaceId = 'prj_1-KV'): FunctionRuntimeBinding {
	return { name, type: 'kv', namespaceId };
}

function render(binding: FunctionRuntimeBinding, index = 0, compatibilityDate?: string) {
	return renderKvBinding({
		workload: workload(compatibilityDate),
		env: {},
		binding,
		index,
	});
}

const EXPECTED_SERVICE = `    ( name = "kv-api-0",
      worker = (
        modules = [
          ( name = "kv.worker", esModule = embed "binding-kv" ),
        ],
        compatibilityDate = "2026-10-01",
        compatibilityFlags = [],
        durableObjectNamespaces = [
          ( className = "KVNamespaceObject", uniqueKey = "prj_1-KV", enableSql = false ),
        ],
        durableObjectStorage = ( localDisk = "do-storage" ),
        bindings = [
          ( name = "DO", durableObjectNamespace = "KVNamespaceObject" ),
        ],
      ) ),`;

describe('renderKvBinding', () => {
	test('renders the exact KV service block, file, main binding and storage flags', () => {
		const rendered = render(kvBinding());
		expect(rendered.services).toEqual([EXPECTED_SERVICE]);
		expect(rendered.mainBindings).toEqual([
			'        ( name = "KV", kvNamespace = "kv-api-0" )',
		]);
		expect(rendered.requiresDurableStorage).toBe(true);
		expect(rendered.namespaces).toEqual([]);
		expect(Object.keys(rendered.files)).toEqual(['binding-kv']);
		expect(rendered.files['binding-kv']).toContain('export class KVNamespaceObject');
		expect(rendered.files['binding-kv']).toContain(
			'Protocol shape adapted from Miniflare (Apache-2.0), cloudflare/workers-sdk',
		);
	});

	test('uses the workload compatibility date and the binding index in the service name', () => {
		const rendered = render(kvBinding('CACHE', 'prj_1-CACHE'), 7, '2026-11-06');
		expect(rendered.services[0]).toContain('( name = "kv-api-7",');
		expect(rendered.services[0]).toContain('compatibilityDate = "2026-11-06"');
		expect(rendered.services[0]).toContain('uniqueKey = "prj_1-CACHE"');
		expect(rendered.mainBindings).toEqual([
			'        ( name = "CACHE", kvNamespace = "kv-api-7" )',
		]);
	});

	test('escapes the binding name and namespace id as Cap’n Proto text', () => {
		const rendered = render(kvBinding('KV"1', 'ns"bad\\id'));
		expect(rendered.mainBindings?.[0]).toBe(
			'        ( name = "KV\\"1", kvNamespace = "kv-api-0" )',
		);
		expect(rendered.services[0]).toContain('uniqueKey = "ns\\"bad\\\\id"');
	});

	test('two KV bindings get distinct service names but reuse the same worker file', () => {
		const first = render(kvBinding('FIRST', 'prj_1-FIRST'), 0);
		const second = render(kvBinding('SECOND', 'prj_1-SECOND'), 1);
		expect(first.services[0]).toContain('( name = "kv-api-0",');
		expect(second.services[0]).toContain('( name = "kv-api-1",');
		expect(first.services[0]).not.toBe(second.services[0]);
		expect(first.mainBindings?.[0]).toContain('kvNamespace = "kv-api-0"');
		expect(second.mainBindings?.[0]).toContain('kvNamespace = "kv-api-1"');
		expect(first.files['binding-kv']).toBe(second.files['binding-kv']);
	});

	test('never renders activation secrets into the config or the file map', () => {
		const rendered = renderKvBinding({
			workload: workload(),
			env: { SECRET: 'hunter2', DB_PASSWORD: 'correct horse' },
			binding: kvBinding(),
			index: 0,
		});
		expect(JSON.stringify(rendered)).not.toContain('hunter2');
		expect(JSON.stringify(rendered)).not.toContain('correct horse');
	});

	test('refuses a non-KV binding and a workload without a function spec', () => {
		expect(() =>
			renderKvBinding({
				workload: workload(),
				env: {},
				binding: { name: 'CACHE', type: 'cache' } as FunctionRuntimeBinding,
				index: 0,
			}),
		).toThrow('KV renderer received binding "CACHE" of type "cache", not "kv".');

		expect(() =>
			renderKvBinding({
				workload: { id: 'wl_1', projectSlug: 'api', runtime: 'function' } as WorkloadDesired,
				env: {},
				binding: kvBinding(),
				index: 0,
			}),
		).toThrow('Cannot render a KV binding for workload wl_1: it has no function spec.');
	});
});
