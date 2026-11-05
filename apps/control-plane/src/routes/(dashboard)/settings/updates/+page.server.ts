import { error, fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import {
	canManagePlatform,
	compareToRunning,
	defaultUpdateMethod,
	latestVersion,
	readUpdateLog,
	readUpdateStatus,
	requestUpdate,
	selfUpdateAvailability,
	updateInFlight,
	updateMethodFromForm,
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
		snapshots,
		defaultMethod: defaultUpdateMethod()
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

	update: async ({ locals, request }) => {
		const principal = locals.principal;
		if (!principal || !canManagePlatform(principal))
			return fail(403, { message: 'Only platform owners and admins can update the platform.' });
		const data = await request.formData();
		const submitted = data.get('method');
		const method = submitted === null ? defaultUpdateMethod() : updateMethodFromForm(submitted);
		if (!method) return fail(400, { message: 'Choose how to install the update.' });
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

		// Re-check now rather than trusting the page: the button may be minutes old. A build reads
		// VERSION at the configured ref; a download only considers signed published releases.
		const latest = await latestVersion(updateSource(), { force: true, method });
		const comparison = compareToRunning(latest);
		if (latest.ok && !comparison.available)
			return fail(409, { message: `Already on the latest version (${comparison.current}).` });
		if (!latest.ok && method === 'download') return fail(409, { message: latest.error });

		const target = latest.ok ? latest.version : null;
		try {
			requestUpdate(principal, target, method);
		} catch (cause) {
			core.ctx.audit.record({
				principal,
				action: 'platform.update',
				resource: 'platform',
				args: { from: comparison.current, to: target, method },
				result: 'error',
				error: (cause as Error).message
			});
			return fail(500, { message: `Could not queue the update: ${(cause as Error).message}` });
		}
		core.ctx.audit.record({
			principal,
			action: 'platform.update',
			resource: 'platform',
			args: { from: comparison.current, to: target, method },
			result: 'ok'
		});
		const how =
			method === 'build'
				? 'building it from source on this server'
				: method === 'download'
					? 'downloading the signed release'
					: 'installing the newest version';
		return {
			success: target
				? `Updating to ${target} by ${how}. The dashboard restarts near the end; this page reconnects on its own.`
				: `Update requested (${how}). The updater checks GitHub itself and installs the newest version, if any.`
		};
	}
};
