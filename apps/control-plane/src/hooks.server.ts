import { building } from '$app/env';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { getMigrations } from 'better-auth/db/migration';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { auth } from '#lib/server/auth.js';
import { platformOrigin } from '#lib/server/config.js';
import { checkCsrf } from '#lib/server/csrf.js';
import { core } from '#lib/server/core.js';
import { principalFromRequest, principalFromSession } from '#lib/server/principal.js';

/**
 * Apply Better Auth's schema on boot.
 * TODO(release): replace with forward-only Drizzle migrations run by the updater after a
 * SQLite snapshot (DESIGN §12); auto-migrate is only acceptable during the build phase.
 */
export const init: ServerInit = async () => {
	if (building) return;
	const { runMigrations } = await getMigrations(auth.options);
	await runMigrations();

	// One maintenance loop per process (HMR can call init more than once).
	const global = globalThis as typeof globalThis & { __skiffMaintenance?: ReturnType<typeof setInterval> };
	if (!global.__skiffMaintenance) {
		global.__skiffMaintenance = setInterval(() => {
			void core.maintenance.run().catch((error) => console.error('[maintenance]', error));
		}, 60_000);
		global.__skiffMaintenance.unref?.();
	}
};

export const handle: Handle = async ({ event, resolve }) => {
	const csrf = checkCsrf(event.request, event.url, platformOrigin);
	if (!csrf.ok) return new Response(`Forbidden: ${csrf.reason}`, { status: 403 });

	const session = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = session?.user;
	event.locals.session = session?.session;
	if (session?.user) {
		event.locals.principal = principalFromSession(session.user.id, event.request, {
			name: session.user.name ?? undefined,
		});
	} else if (event.request.headers.get('authorization')) {
		event.locals.principal = await principalFromRequest(event.request);
	}

	return svelteKitHandler({ event, resolve, auth, building });
};
