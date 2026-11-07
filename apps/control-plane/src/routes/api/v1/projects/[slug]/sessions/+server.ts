import type { RequestHandler } from './$types';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Visitor sessions on a protected project (DESIGN §6.4). `GET` lists live share-link sessions;
 * `DELETE` signs out everyone (password, platform and share sessions on every scope) by rotating
 * the project's site key. Share links keep working; revoke a link to stop new sessions.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { sessions: core.access.listSessions(principal, project) };
	});

export const DELETE: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const project = core.projects.requireRow(principal, event.params.slug);
		return { ok: true, ...(await core.access.signOutEveryone(principal, project)) };
	});
