import { error, fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import {
	canManagePlatform,
	compareToRunning,
	latestVersion,
	readUpdateLog,
	readUpdateStatus,
	requestUpdate,
	selfUpdateAvailability,
	updateInFlight,
	updatePending,
	updateSource
} from '#lib/server/self-update.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!canManagePlatform(locals.principal))
		error(403, 'Only platform owners and admins can manage platform updates.');
	const source = updateSource();
	const latest = await latestVersion(source);
	const status = readUpdateStatus();
	const comparison = compareToRunning(latest);
	const preflight = await core.upgrades.preflight({
		targetVersion: latest.ok ? latest.version : comparison.current,
		checkBackupTarget: false
	});
	const snapshots = core.upgrades.listSnapshotBundles().map((bundle) => ({
		dir: bundle.dir,
		createdAt: bundle.manifest.createdAt,
		pinned: bundle.manifest.pinned,
		targetVersion: bundle.manifest.targetVersion,
		hasControlDb: Boolean(bundle.controlDb)
	}));
	return {
		availability: selfUpdateAvailability(),
		source,
		latest,
		comparison,
		status,
		log: readUpdateLog(),
		pending: updatePending(),
		inFlight: updateInFlight(status),
		preflight,
		snapshots
	};
};

export const actions: Actions = {
	check: async ({ locals }) => {
		if (!canManagePlatform(locals.principal))
			return fail(403, { message: 'Only platform owners and admins can check for updates.' });
		const latest = await latestVersion(updateSource(), { force: true });
		if (!latest.ok) return fail(502, { message: latest.error });
		const comparison = compareToRunning(latest);
		return {
			success: comparison.available
				? `Version ${latest.version} is available.`
				: `You're on the latest version (${comparison.current}).`
		};
	},

	update: async ({ locals }) => {
		const principal = locals.principal;
		if (!principal || !canManagePlatform(principal))
			return fail(403, { message: 'Only platform owners and admins can update the platform.' });
		const availability = selfUpdateAvailability();
		if (availability === 'unmanaged')
			return fail(409, {
				message: 'This control plane is not an installed release; there is nothing to update.'
			});
		if (availability === 'not-enabled')
			return fail(409, {
				message:
					'Dashboard updates are not enabled on this host. Run `sudo skiff-update-self check` on the server once.'
			});
		if (updateInFlight()) return fail(409, { message: 'An update is already queued or running.' });

		// Re-check now rather than trusting the page: the button may be minutes old.
		const latest = await latestVersion(updateSource(), { force: true });
		const comparison = compareToRunning(latest);
		if (latest.ok && !comparison.available)
			return fail(409, { message: `Already on the latest version (${comparison.current}).` });

		const target = latest.ok ? latest.version : null;
		try {
			requestUpdate(principal, target);
		} catch (cause) {
			core.ctx.audit.record({
				principal,
				action: 'platform.update',
				resource: 'platform',
				args: { from: comparison.current, to: target },
				result: 'error',
				error: (cause as Error).message
			});
			return fail(500, { message: `Could not queue the update: ${(cause as Error).message}` });
		}
		core.ctx.audit.record({
			principal,
			action: 'platform.update',
			resource: 'platform',
			args: { from: comparison.current, to: target },
			result: 'ok'
		});
		return {
			success: target
				? `Updating to ${target}. The dashboard restarts near the end; this page reconnects on its own.`
				: 'Update requested. The updater checks GitHub itself and installs the newest version, if any.'
		};
	}
};
