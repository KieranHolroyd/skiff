import { readFileSync } from 'node:fs';

/**
 * Bun macro: a file's source text, inlined as a string literal at bundle time.
 *
 * Use it instead of `with { type: 'text' }` for a file the agent also imports as a module
 * (packages/function-bindings/src/nats.js). `bun build` keeps one record per file and drops the
 * text attribute on the second import, failing with `No matching export … for import "default"`.
 * A macro reads the file outside the module graph, so both uses coexist.
 *
 * Import with `with { type: 'macro' }`. `path` is relative to this file.
 */
export function embedSource(path: string): string {
	return readFileSync(new URL(path, import.meta.url), 'utf8');
}
