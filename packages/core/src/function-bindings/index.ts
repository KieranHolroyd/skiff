import type { FunctionBindingType } from '@skiff/contracts';
import { resolveDurableObject } from './durable-object.ts';
import { resolveHyperdrive } from './hyperdrive.ts';
import { resolveKvBinding } from './kv.ts';
import { resolveCacheBinding } from './cache.ts';
import { resolveR2Binding } from './r2.ts';
import { resolveD1Binding } from './d1.ts';
import { resolveQueueBinding } from './queue.ts';
import { resolveAssetsBinding } from './assets.ts';
import { resolveAnalyticsEngineBinding } from './analytics-engine.ts';
import { resolveAuthBinding } from './auth.ts';
import type { BindingResolver } from './types.ts';

/**
 * Resolver dispatch for function binding types (docs/FUNCTIONS.md §4.5).
 *
 * Phase 1 resolved text/json/secret/service/app inline in `FunctionService`. Phase 2 adds native
 * workerd bindings here, one file each. A type with no resolver is either not implemented by this
 * build (the service rejects it with "not supported yet") or still a later phase (the service keeps
 * its phase message).
 */
const RESOLVERS: ReadonlyMap<FunctionBindingType, BindingResolver> = new Map([
	['durable_object', resolveDurableObject],
	['hyperdrive', resolveHyperdrive],
	['kv', resolveKvBinding],
	['cache', resolveCacheBinding],
	['r2', resolveR2Binding],
	['d1', resolveD1Binding],
	['queue', resolveQueueBinding],
	['assets', resolveAssetsBinding],
	['analytics_engine', resolveAnalyticsEngineBinding],
	['auth', resolveAuthBinding],
]);

/** The resolver for a binding type, or undefined when this build cannot resolve it yet. */
export function bindingResolver(type: FunctionBindingType): BindingResolver | undefined {
	return RESOLVERS.get(type);
}

export {
	resolveAnalyticsEngineBinding,
	resolveAssetsBinding,
	resolveCacheBinding,
	resolveD1Binding,
	resolveDurableObject,
	resolveHyperdrive,
	resolveKvBinding,
	resolveQueueBinding,
	resolveR2Binding,
};
