import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// Kit's built-in CSRF check runs before hooks and can only be disabled globally; it would
			// block cross-origin OAuth endpoints (token/register) that MCP clients call by design.
			// Replaced by a stricter Origin policy in src/lib/server/csrf.ts, enforced in hooks.
			csrf: { trustedOrigins: ['*'] }
		})
	],
	// DuckDB is a native N-API addon; never bundle it. It is loaded dynamically at runtime
	// (packages/core/src/telemetry.ts) and degrades to no-op telemetry if unavailable.
	ssr: { external: ['@duckdb/node-api', '@duckdb/node-bindings'] },
	optimizeDeps: { exclude: ['@duckdb/node-api'] }
});
