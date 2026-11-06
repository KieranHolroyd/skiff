import type { FunctionRuntimeBinding, WorkloadDesired } from '@skiff/contracts';

/**
 * A binding backend rendered for one function host (docs/FUNCTIONS.md §4.5, FN10).
 *
 * Phase 2 bindings fall into two shapes:
 * - native workerd capabilities (Durable Objects, Hyperdrive) add a binding to the user Worker;
 * - Skiff-supplied service Workers (KV, Cache, R2, Analytics, queues) add a sibling service to the
 *   same workerd process and a capability binding to the user Worker.
 *
 * Each backend is a pure renderer: it returns config fragments and worker source files, never
 * touches disk. The function config composer dedupes files and concatenates services in binding
 * order, then hands everything to the helper as systemd credentials.
 */
export interface BindingRenderContext {
	/** The desired workload; its `function` spec is present. */
	workload: WorkloadDesired;
	/**
	 * Activation env for this apply, including secret values. A backend that needs credentials in
	 * the workerd config (Hyperdrive) reads them here; most services use `fromEnvironment` instead.
	 */
	env: Record<string, string>;
	/** The resolved binding to render. */
	binding: FunctionRuntimeBinding;
	/** Absolute release directory (an assets binding serves files from it). */
	releaseDir?: string;
	/** Stable index among service-backed bindings, for unique service/credential names. */
	index: number;
}

export interface RenderedBinding {
	/**
	 * Extra worker source files to embed, keyed by systemd credential name. Names must match
	 * `^[a-z][a-z0-9-]{0,63}$`; the composer refuses duplicates and reserved names.
	 */
	files: Record<string, string>;
	/** Additional top-level services: complete capnp text blocks, indented four spaces. */
	services: string[];
	/**
	 * Capability binding entries for the main Worker's `bindings` list, each already parenthesised
	 * and indented eight spaces, e.g. `( name = "KV", kvNamespace = "kv-api-cache" )`.
	 */
	mainBindings?: string[];
	/**
	 * Durable Object namespaces the main Worker must declare. The composer merges them into one
	 * `durableObjectNamespaces` list (the field cannot be repeated) and sets
	 * `durableObjectStorage = ( localDisk = "do-storage" )` when any backend needs storage.
	 */
	namespaces?: Array<{ className: string; uniqueKey: string; enableSql: boolean }>;
	/** Other Worker fields for the main Worker, indented eight spaces (`cacheApiOutbound = "…"`). */
	mainFields?: string[];
	/** `Config.extensions` module blocks, indented four spaces. */
	extensions?: string[];
	/**
	 * True when any service in the host needs the shared `do-storage` disk service. The composer
	 * adds it to the process; the helper passes its path with `--directory-path`. The main Worker
	 * only gets `durableObjectStorage` when it declares a namespace itself.
	 */
	requiresDurableStorage?: boolean;
}

export type BindingRenderer = (context: BindingRenderContext) => RenderedBinding;
