import type { FunctionRuntimeBinding } from '@skiff/contracts';
import { renderDurableObject } from './durable-object.ts';
import { renderHyperdrive } from './hyperdrive.ts';
import { renderKvBinding } from './kv.ts';
import { renderCacheBinding } from './cache.ts';
import { renderR2Binding } from './r2.ts';
import { renderD1Binding } from './d1.ts';
import { renderQueueBinding } from './queue.ts';
import { renderAssetsBinding } from './assets.ts';
import { renderAnalyticsEngineBinding } from './analytics-engine.ts';
import { renderAuthBinding } from './auth.ts';
import type { BindingRenderer } from './types.ts';

/**
 * Binding renderer dispatch for the workerd config composer (docs/FUNCTIONS.md §4.5, FN10).
 *
 * Phase 1 rendered its five binding kinds inline in `function-config.ts`. Phase-2 backends live in
 * this directory, one file each, and are pure renderers of config fragments. The composer asks
 * this module for a renderer and falls back to the phase-1 renderer for the five original kinds.
 *
 * A type that has no renderer here is a binding the control plane should have refused. The composer
 * turns that into a clear apply error rather than a half-rendered host (defence in depth).
 */

/** The five kinds `function-config.ts` rendered before phase 2; their output must not change. */
export const PHASE_ONE_BINDING_TYPES: ReadonlySet<FunctionRuntimeBinding['type']> = new Set([
	'text',
	'json',
	'secret',
	'service',
	'app',
]);

/**
 * The renderer for a binding type, or undefined when this build cannot render it yet.
 *
 * A `switch` rather than a module-level `Map`: `function-config.ts` imports this module while the
 * renderers themselves import `capnpText` from it, so the map would run before those bindings are
 * initialised. Resolving at call time is safe and keeps the cycle confined to module loading.
 */
export function bindingRenderer(type: FunctionRuntimeBinding['type']): BindingRenderer | undefined {
	switch (type) {
		case 'durable_object':
			return renderDurableObject;
		case 'hyperdrive':
			return renderHyperdrive;
		case 'kv':
			return renderKvBinding;
		case 'cache':
			return renderCacheBinding;
		case 'r2':
			return renderR2Binding;
		case 'd1':
			return renderD1Binding;
		case 'queue':
			return renderQueueBinding;
		case 'assets':
			return renderAssetsBinding;
		case 'analytics_engine':
			return renderAnalyticsEngineBinding;
		case 'auth':
			return renderAuthBinding;
		default:
			return undefined;
	}
}

export {
	renderAnalyticsEngineBinding,
	renderAssetsBinding,
	renderCacheBinding,
	renderD1Binding,
	renderDurableObject,
	renderHyperdrive,
	renderKvBinding,
	renderQueueBinding,
	renderR2Binding,
	renderAuthBinding,
};
