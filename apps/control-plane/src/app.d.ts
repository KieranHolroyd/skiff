// See https://svelte.dev/docs/kit/types#app.d.ts
import type { Session } from '#lib/server/auth.js';

declare global {
	namespace App {
		interface Locals {
			user?: Session['user'];
			session?: Session['session'];
		}
	}
}

export {};
