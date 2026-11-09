import { ForbiddenError } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import {
	compareToRunning,
	currentChannel,
	latestVersion,
	updateSource
} from '#lib/server/self-update.js';
import { platformVersion } from '#lib/server/version.js';
import type { RequestHandler } from './$types';

/**
 * Read-only upgrade plan for the CLI/dashboard. The self-updater re-runs the same rules against
 * the exact staged release before it touches anything; this endpoint is advisory and never
 * changes the host.
 */
export const GET: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		if (!core.ctx.platformIam.canView(principal))
			throw new ForbiddenError('only a platform admin can plan an upgrade');
		const source = updateSource();
		const latest = await latestVersion(source);
		const requested = event.url.searchParams.get('version');
		const target = requested ?? (latest.ok ? latest.version : platformVersion);
		const plan = await core.upgrades.preflight({
			targetVersion: target,
			checkBackupTarget: event.url.searchParams.get('check') === '1'
		});
		return {
			plan,
			latest,
			source,
			channel: currentChannel(),
			comparison: compareToRunning(latest),
			snapshots: core.upgrades.listSnapshotBundles().map((bundle) => ({
				dir: bundle.dir,
				createdAt: bundle.manifest.createdAt,
				pinned: bundle.manifest.pinned,
				targetVersion: bundle.manifest.targetVersion,
				controlDb: Boolean(bundle.controlDb)
			}))
		};
	});
