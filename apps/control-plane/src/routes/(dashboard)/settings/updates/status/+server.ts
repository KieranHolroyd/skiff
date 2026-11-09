import { json } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { platformVersion } from '#lib/server/version.js';
import {
	readUpdateLog,
	readUpdateStatus,
	updateInFlight,
	updatePending
} from '#lib/server/self-update.js';
import type { RequestHandler } from './$types';

/** Polled by the updates page while an update runs (the page itself would 502 mid-restart). */
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.principal || !core.ctx.platformIam.can(locals.principal, 'platform:updates'))
		return json({ message: 'Forbidden' }, { status: 403 });
	const status = readUpdateStatus();
	return json(
		{
			version: platformVersion,
			status,
			log: readUpdateLog(),
			pending: updatePending(),
			inFlight: updateInFlight(status)
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
