// See https://svelte.dev/docs/kit/types#app.d.ts
import type { Principal } from '@skiff/contracts';
import type { Session } from '#lib/server/auth.js';

declare global {
	/** Repository-root VERSION at build time (vite.config.ts). */
	const __SKIFF_VERSION__: string;

	namespace App {
		interface Error {
			/** Settings → Server errors issue id, on unexpected (5xx) errors. */
			errorId?: string;
		}
		interface Locals {
			user?: Session['user'];
			session?: Session['session'];
			principal?: Principal;
		}
	}
}

export {};
