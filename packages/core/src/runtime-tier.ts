import type { WorkloadRuntime } from '@skiff/contracts';

/**
 * The runtime tier a row actually is (D1 as amended by D110).
 *
 * SQLite cannot change a `CHECK` constraint without rebuilding the table, which the additive
 * migration rule forbids (see migration 0028 for the same problem with database engines). The
 * legacy `runtime` columns therefore keep their original four-value CHECK and a new
 * `runtime_name` column holds the tier. `runtime: "function"` is stored as `runtime = "process"`
 * plus `runtime_name = "function"`, so a rollback to a release that predates Functions reads a
 * non-static workload rather than crashing on a value its CHECK rejects.
 */

export type TierRuntime = 'static' | 'process' | 'container' | 'function';
/** The value the legacy `runtime` columns may hold. */
export type StoredRuntime = 'static' | 'process' | 'container';

const TIERS: readonly TierRuntime[] = ['static', 'process', 'container', 'function'];

function isTier(value: unknown): value is TierRuntime {
	return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/** The effective tier: `runtime_name` when present, else the legacy column. */
export function effectiveRuntime(row: { runtime: string; runtimeName?: string | null }): TierRuntime {
	if (isTier(row.runtimeName)) return row.runtimeName;
	return isTier(row.runtime) ? row.runtime : 'static';
}

/** What to write into the legacy `runtime` column for an effective tier. */
export function storedRuntime(runtime: TierRuntime): StoredRuntime {
	return runtime === 'function' ? 'process' : runtime;
}

/** Convenience for the many `project.runtime === 'static'` branches. */
export function isFunctionTier(row: { runtime: string; runtimeName?: string | null }): boolean {
	return effectiveRuntime(row) === 'function';
}

/** Narrow an effective tier to the workload-service type (`static` never has a workload). */
export function workloadRuntimeOf(row: { runtime: string; runtimeName?: string | null }): WorkloadRuntime {
	const runtime = effectiveRuntime(row);
	if (runtime === 'static') throw new Error('A static project has no workload runtime.');
	return runtime;
}
