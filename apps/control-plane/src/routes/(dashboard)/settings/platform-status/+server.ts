import {
	canConfigurePlatform,
	configInFlight,
	configPending,
	readConfigStatus
} from '#lib/server/platform-config.js';
import type { RequestHandler } from './$types';

/** Polled by Settings → Backups / Notifications while a change is applied (the control plane restarts). */
export const GET: RequestHandler = ({ locals }) => {
	if (!canConfigurePlatform(locals.principal))
		return Response.json({ message: 'Forbidden' }, { status: 403 });
	const status = readConfigStatus();
	return Response.json(
		{ status, pending: configPending(), inFlight: configInFlight(status) },
		{ headers: { 'cache-control': 'no-store' } }
	);
};
