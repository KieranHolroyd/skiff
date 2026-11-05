import { json } from '#lib/server/api.js';
import { core } from '#lib/server/core.js';
import type { RequestHandler } from './$types';

/**
 * Public readiness (docs/OPS.md §4.2.3). Reports the app/schema/agent versions, data directories,
 * disk headroom and backup target reachability. Never includes secrets or environment values.
 *
 * 200 = serving; 503 = the control plane or schema is not usable, which is what the self-updater
 * uses to decide whether a just-switched release should be rolled back.
 */
export const GET: RequestHandler = async () => {
	const report = await core.upgrades.readyz();
	return json(report, report.ok ? 200 : 503, { 'cache-control': 'no-store' });
};
