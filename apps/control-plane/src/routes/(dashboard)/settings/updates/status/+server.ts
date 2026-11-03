import { json } from '@sveltejs/kit';
import { platformVersion } from '#lib/server/version.js';
import {
	canManagePlatform,
	readUpdateStatus,
	updateInFlight,
	updatePending
} from '#lib/server/self-update.js';
import type { RequestHandler } from './$types';

/** Polled by the updates page while an update runs (the page itself would 502 mid-restart). */
export const GET: RequestHandler = ({ locals }) => {
	if (!canManagePlatform(locals.principal)) return json({ message: 'Forbidden' }, { status: 403 });
	const status = readUpdateStatus();
	return json(
		{
			version: platformVersion,
			status,
			pending: updatePending(),
			inFlight: updateInFlight(status)
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
