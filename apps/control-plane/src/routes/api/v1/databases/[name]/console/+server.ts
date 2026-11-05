import type { RequestHandler } from './$types';
import { databaseConsoleOpenSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/** The per-database DBGate studio session (D60). GET polls it; POST opens; DELETE closes. */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { console: core.databases.console(principal, event.params.name) };
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseConsoleOpenSchema);
		return json({ console: core.databases.openConsole(principal, event.params.name, input) }, 201);
	});

export const DELETE: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		return { console: core.databases.closeConsole(principal, event.params.name) };
	});
