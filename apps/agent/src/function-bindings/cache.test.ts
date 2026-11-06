import { describe, expect, test } from 'bun:test';
import {
	workloadDesiredSchema,
	type FunctionRuntimeBinding,
	type WorkloadDesired,
} from '@skiff/contracts';
import { renderCacheBinding } from './cache.ts';
import type { BindingRenderContext } from './types.ts';

const SHA = 'c'.repeat(64);

/** A valid desired workload as a node receives it, parsed through the contract schema. */
function functionWorkload(
	bindings: FunctionRuntimeBinding[] = [],
	options: { projectId?: string; compatibilityDate?: string } = {},
): WorkloadDesired {
	return workloadDesiredSchema.parse({
		id: 'wl_1',
		projectId: options.projectId ?? 'prj_1',
		projectSlug: 'api',
		deploymentId: 'dep_1',
		runtime: 'function',
		status: 'running',
		release: SHA,
		upstream: 'unix//run/skiff-workloads/wl_1.sock',
		memoryMb: 128,
		cpus: 1,
		port: 3000,
		healthPath: '/__skiff/health',
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
	return renderCacheBinding(context);
}

const CACHE_BINDING: FunctionRuntimeBinding = { name: 'CACHE', type: 'cache' };

describe('renderCacheBinding', () => {
	test('renders the exact cache service block', () => {
		const rendered = render(CACHE_BINDING);
		expect(rendered.services).toEqual([
			[
				'    ( name = "cache-api-0",',
				'      worker = (',
				'        modules = [',
				'          ( name = "cache.worker", esModule = embed "binding-cache" ),',
				'        ],',
				'        compatibilityDate = "2026-10-01",',
				'        compatibilityFlags = [],',
				'        durableObjectNamespaces = [',
				'          ( className = "CacheObject", uniqueKey = "prj_1-CACHE", enableSql = false ),',
				'        ],',
				'        durableObjectStorage = ( localDisk = "do-storage" ),',
				'        bindings = [',
				'          ( name = "DO", durableObjectNamespace = "CacheObject" ),',
				'        ],',
				'      ) )',
			].join('\n'),
		]);
	});

	test('routes the Cache API through one cacheApiOutbound field', () => {
		const rendered = render(CACHE_BINDING, { index: 3 });
		expect(rendered.mainFields).toEqual(['        cacheApiOutbound = "cache-api-3"']);
		expect(rendered.services[0]).toContain('( name = "cache-api-3",');
	});

	test('embeds the cache worker under the binding-cache credential', () => {
		const rendered = render(CACHE_BINDING);
		expect(Object.keys(rendered.files)).toEqual(['binding-cache']);
		const source = rendered.files['binding-cache']!;
		expect(source).toContain('export class CacheObject');
		expect(source).toContain('export default {');
		expect(source).toContain('Miniflare (Apache-2.0)');
		expect(source.length).toBeGreaterThan(1_000);
	});

	test('needs the shared durable storage but no namespace on the main Worker', () => {
		const rendered = render(CACHE_BINDING);
		expect(rendered.requiresDurableStorage).toBe(true);
		expect(rendered.namespaces).toEqual([]);
		expect(rendered.mainBindings).toBeUndefined();
	});

	test('two cache bindings produce two services and two cacheApiOutbound lines', () => {
		const workload = functionWorkload([
			CACHE_BINDING,
			{ name: 'OTHER_CACHE', type: 'cache' },
		]);
		const first = render(CACHE_BINDING, { workload, index: 0 });
		const second = render({ name: 'OTHER_CACHE', type: 'cache' }, { workload, index: 1 });

		expect(first.services[0]).toContain('( name = "cache-api-0",');
		expect(second.services[0]).toContain('( name = "cache-api-1",');
		expect(first.services[0]).toContain('uniqueKey = "prj_1-CACHE"');
		expect(second.services[0]).toContain('uniqueKey = "prj_1-OTHER_CACHE"');
		// workerd has one cacheApiOutbound per Worker, so the two fields can never coexist:
		// the composer must refuse a host with two cache bindings.
		expect(first.mainFields).not.toEqual(second.mainFields);
		// Both services embed the same source file, which the composer dedupes by credential name.
		expect(Object.keys(second.files)).toEqual(['binding-cache']);
	});

	test('uses the workload compatibility date', () => {
		const workload = functionWorkload([CACHE_BINDING], { compatibilityDate: '2025-01-02' });
		expect(render(CACHE_BINDING, { workload }).services[0]).toContain(
			'compatibilityDate = "2025-01-02"',
		);
	});

	test('folds characters the contract namespace key would reject', () => {
		const workload = functionWorkload([CACHE_BINDING], { projectId: 'prj"1' });
		const service = render(CACHE_BINDING, { workload }).services[0]!;
		expect(service).toContain('uniqueKey = "prj-1-CACHE"');
		expect(service).not.toContain('prj"1');
	});

	test('refuses a non-cache binding', () => {
		const kv: FunctionRuntimeBinding = { name: 'KV', type: 'kv', namespaceId: 'prj_1-KV' };
		expect(() => render(kv)).toThrow(
			'Cache renderer received binding "KV" of type "kv", not "cache".',
		);
	});

	test('refuses a workload with no function spec', () => {
		const workload = { ...functionWorkload([CACHE_BINDING]), function: undefined };
		expect(() => render(CACHE_BINDING, { workload })).toThrow(
			'Cannot render a cache binding for workload wl_1: it has no function spec.',
		);
	});
});
