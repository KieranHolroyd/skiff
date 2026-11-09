import { error } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import { hasPermission, type BrokerView, type ServiceLogQueryResult } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { brokerCan } from '../../_lib/forms.server.js';
import type { PageServerLoad } from './$types';

/** Broker container logs. The agent drains the unit's journal; this page tails the JSON endpoint. */
export const load: PageServerLoad = ({ locals, params }) => {
	const principal = locals.principal!;
	let broker: BrokerView;
	try {
		broker = core.brokers.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	const canRead = hasPermission(principal, 'logs:read');
	let initial: ServiceLogQueryResult | null = null;
	let logsError: string | null = null;
	if (canRead) {
		try {
			initial = core.logs.queryService(principal, 'broker', broker.id, { limit: 500 });
		} catch (caught) {
			logsError = caught instanceof Error ? caught.message : 'Could not read logs.';
		}
	}
	return { broker, initial, logsError, canRead, brokerCan: brokerCan(principal) };
};
