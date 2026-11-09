import type { FunctionRuntimeBinding } from '@yoal/contracts';
import { ValidationError } from '../errors.ts';
import type { BindingResolver } from './types.ts';

/**
 * Analytics Engine dataset names become ClickHouse `dataset` values and part of the node's sink
 * event, so they share one safe alphabet with KV namespace ids. Cloudflare allows more, but a
 * name outside this set gains nothing and only widens what a rendered config has to escape.
 */
export const ANALYTICS_DATASET_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Resolve an Analytics Engine binding to its dataset (docs/FUNCTIONS.md §4.5, D101, FN10).
 *
 * There is no org resource to attach: the datapoints land in the shared telemetry ClickHouse, and
 * the owning project/workload are attached by the node (the wrapper's inner text bindings), so a
 * Worker cannot write another tenant's rows. A missing `dataset` defaults to the binding name,
 * which is the Wrangler convention for a dataset with no explicit name.
 */
export const resolveAnalyticsEngineBinding: BindingResolver = (_context, binding) => {
	if (binding.type !== 'analytics_engine') {
		throw new ValidationError(
			`Binding "${binding.name}" uses type "${binding.type}"; the analytics resolver only handles binding type "analytics_engine".`,
		);
	}
	const dataset = binding.dataset ?? binding.name;
	if (!ANALYTICS_DATASET_PATTERN.test(dataset)) {
		throw new ValidationError(
			`Analytics Engine dataset "${dataset}" is invalid: use 1–100 letters, digits, ".", "_" or "-".`,
		);
	}
	return { name: binding.name, type: 'analytics_engine', dataset } satisfies FunctionRuntimeBinding;
};
