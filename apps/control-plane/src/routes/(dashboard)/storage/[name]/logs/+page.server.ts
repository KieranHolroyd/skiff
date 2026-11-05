import { error } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import { hasPermission, type ServiceLogQueryResult, type StorageView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { storageCan } from '../../_lib/forms.server.js';
import type { PageServerLoad } from './$types';

/**
 * RustFS container logs (D82). The agent drains the unit's journal like any other workload; this
 * page shows the newest page and tails the JSON endpoint.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let storage: StorageView;
	try {
		storage = core.storage.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	const canRead = hasPermission(principal, 'logs:read');
	let initial: ServiceLogQueryResult | null = null;
	let logsError: string | null = null;
	if (canRead) {
		try {
			initial = core.logs.queryService(principal, 'storage', storage.id, { limit: 500 });
		} catch (caught) {
			logsError = caught instanceof Error ? caught.message : 'Could not read logs.';
		}
	}

	return {
		storage,
		initial,
		logsError,
		canRead,
		storageCan: storageCan(principal)
	};
};
