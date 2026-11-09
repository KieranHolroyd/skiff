import type { BindingRenderer, RenderedBinding } from './types.ts';
import { capnpText } from '../function-config.ts';
import cacheWorkerSource from '../../../../packages/function-bindings/src/cache.js' with { type: 'text' };

/** Helper credential name the cache service module is embedded as (fixed contract with the helper). */
export const CACHE_BINDING_FILE = 'binding-cache';

/**
 * Phase-2 Cache API: one Yoal-supplied Worker service per cache binding, backed by a Durable
 * Object namespace the service owns (docs/FUNCTIONS.md §4.5, FN10).
 *
 * Unlike KV, the main Worker gets no named binding: workerd exposes the Cache API implicitly and
 * routes `caches.default` / `caches.open()` through the Worker's `cacheApiOutbound` field. That
 * field is a single-value field on a Worker, which is why a host cannot serve two `cache` bindings
 * (the composer has to reject that with a clear error).
 */
export const renderCacheBinding: BindingRenderer = (context) => {
	const { binding, index, workload } = context;
	if (binding.type !== 'cache') {
		throw new Error(
			`Cache renderer received binding "${binding.name}" of type "${binding.type}", not "cache".`,
		);
	}
	const spec = workload.function;
	if (!spec) {
		throw new Error(`Cannot render a cache binding for workload ${workload.id}: it has no function spec.`);
	}

	const serviceName = `cache-api-${index}`;
	const service = [
		`    ( name = ${capnpText(serviceName)},`,
		'      worker = (',
		'        modules = [',
		`          ( name = "cache.worker", esModule = embed ${capnpText(CACHE_BINDING_FILE)} ),`,
		'        ],',
		`        compatibilityDate = ${capnpText(spec.compatibilityDate)},`,
		'        compatibilityFlags = [],',
		'        durableObjectNamespaces = [',
		`          ( className = "CacheObject", uniqueKey = ${capnpText(namespaceKey(workload.projectId, binding.name))}, enableSql = false ),`,
		'        ],',
		'        durableObjectStorage = ( localDisk = "do-storage" ),',
		'        bindings = [',
		'          ( name = "DO", durableObjectNamespace = "CacheObject" ),',
		'        ],',
		'      ) )',
	].join('\n');

	const rendered: RenderedBinding = {
		files: { [CACHE_BINDING_FILE]: cacheWorkerSource },
		services: [service],
		// One per Worker: see the doc comment above.
		mainFields: [`        cacheApiOutbound = ${capnpText(serviceName)}`],
		requiresDurableStorage: true,
		namespaces: [],
	};
	return rendered;
};

/**
 * Stable workerd namespace key: project + binding name, never the renameable slug. workerd accepts
 * arbitrary text here, but Yoal's runtime namespace keys use `[A-Za-z0-9._-]` (see the contract's
 * `uniqueKey` pattern), so fold anything else to `-` rather than let a hand-written desired-state
 * spec drift outside that alphabet. Project ids are already URL-safe, so this is a no-op in
 * practice.
 */
function namespaceKey(projectId: string, bindingName: string): string {
	const folded = `${projectId}-${bindingName}`.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
	return folded.length > 0 ? folded : 'cache';
}
