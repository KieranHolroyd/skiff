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
	]
});
