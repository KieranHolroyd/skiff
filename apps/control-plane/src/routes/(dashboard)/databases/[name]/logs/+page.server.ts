import { error } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { hasPermission, type ServiceLogQueryResult, type DatabaseView } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { databaseCan } from '../../_lib/forms.server.js';
import type { PageServerLoad } from './$types';

/**
 * Postgres container logs (D82). The agent drains the unit's journal like any other workload; this
 * page shows the newest page and tails the JSON endpoint.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let database: DatabaseView;
	try {
		database = core.databases.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	const canRead = hasPermission(principal, 'logs:read');
	let initial: ServiceLogQueryResult | null = null;
	let logsError: string | null = null;
	if (canRead) {
		try {
			initial = core.logs.queryService(principal, 'database', database.id, { limit: 500 });
		} catch (caught) {
			logsError = caught instanceof Error ? caught.message : 'Could not read logs.';
		}
	}

	return {
		database,
		initial,
		logsError,
		canRead,
		dbCan: databaseCan(principal)
	};
};
