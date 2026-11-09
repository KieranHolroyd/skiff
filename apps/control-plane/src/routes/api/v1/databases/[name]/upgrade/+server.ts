import type { RequestHandler } from './$types';
import { databaseUpgradeSchema } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * PostgreSQL major upgrades are explicit and manual (docs/OPS.md §4.4). GET plans, POST with
 * `apply: true` queues the pinned pre-upgrade backup and returns the runbook. Neither ever
 * switches the data directory automatically.
 */

export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const targetVersion = event.url.searchParams.get('to');
		if (!targetVersion) throw new Response('Missing ?to=<version>', { status: 400 });
		return {
			plan: core.databases.upgradeDatabase(principal, event.params.name, { targetVersion })
		};
	});

export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, databaseUpgradeSchema);
		return json(
			{ plan: core.databases.upgradeDatabase(principal, event.params.name, input) },
			input.apply ? 202 : 200
		);
	});
