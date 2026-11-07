import { error, fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import {
	canManagePlatform,
	compareToRunning,
	currentChannel,
	defaultUpdateMethod,
	latestVersion,
	readUpdateLog,
	readUpdateStatus,
	requestUpdate,
	selfUpdateAvailability,
	updateChannelFromForm,
	updateInFlight,
	updateMethodFromForm,
	updatePending,
	updateSource
} from '#lib/server/self-update.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!canManagePlatform(locals.principal))
		error(403, 'Only platform owners and admins can manage platform updates.');
	const source = updateSource();
	// `?channel=` previews the other channel; the host only switches when an update is requested.
	const hostChannel = currentChannel();
	const channel = updateChannelFromForm(url.searchParams.get('channel')) ?? hostChannel;
	const [latest, canary, stable] = await Promise.all([
		latestVersion(source, { channel }),
		latestVersion(source, { channel: 'canary' }),
		latestVersion(source, { channel: 'stable' })
	]);
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
		channel,
		hostChannel,
		channels: {
			canary: canary.ok ? canary.version : null,
			stable: stable.ok ? stable.version : null
		},
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
	check: async ({ locals, request }) => {
		if (!canManagePlatform(locals.principal))
			return fail(403, { message: 'Only platform owners and admins can check for updates.' });
		// The page posts the channel it is previewing (`?/check` drops the page's own query).
		const channel =
			updateChannelFromForm((await request.formData()).get('channel')) ?? currentChannel();
		const source = updateSource();
		const other = channel === 'canary' ? 'stable' : 'canary';
		const [latest] = await Promise.all([
			latestVersion(source, { force: true, channel }),
			latestVersion(source, { force: true, channel: other })
		]);
		if (!latest.ok) return fail(502, { message: latest.error });
		const comparison = compareToRunning(latest);
		return {
			success: comparison.available
				? `Version ${latest.version} is available on ${channel}.`
				: `You're on the latest ${channel} version (${comparison.current}).`
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
		const submittedChannel = data.get('channel');
		const hostChannel = currentChannel();
		const channel =
			submittedChannel === null ? hostChannel : updateChannelFromForm(submittedChannel);
		if (!channel) return fail(400, { message: 'Choose canary or stable.' });
		const switching = channel !== hostChannel;
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
		const latest = await latestVersion(updateSource(), { force: true, method, channel });
		const comparison = compareToRunning(latest);
		// A channel switch is still sent when nothing is newer: the updater records the channel
		// and stays put until that channel passes the running version (it never downgrades).
		if (latest.ok && !comparison.available && !switching)
			return fail(409, {
				message: `Already on the latest ${channel} version (${comparison.current}).`
			});
		if (!latest.ok && (method === 'download' || channel === 'stable'))
			return fail(409, { message: latest.error });

		const target = latest.ok && comparison.available ? latest.version : null;
		try {
			requestUpdate(principal, target, method, channel);
		} catch (cause) {
			core.ctx.audit.record({
				principal,
				action: 'platform.update',
				resource: 'platform',
				args: { from: comparison.current, to: target, method, channel },
				result: 'error',
				error: (cause as Error).message
			});
			return fail(500, { message: `Could not queue the update: ${(cause as Error).message}` });
		}
		core.ctx.audit.record({
			principal,
			action: 'platform.update',
			resource: 'platform',
			args: { from: comparison.current, to: target, method, channel },
			result: 'ok'
		});
		const how =
			method === 'build'
				? 'building it from source on this server'
				: method === 'download'
					? 'downloading the signed release'
					: 'installing the newest version';
		if (switching && !target)
			return {
				success: `Switching this host to the ${channel} channel. It stays on ${comparison.current} until ${channel} has a newer release, then updates as usual.`
			};
		return {
			success: target
				? `Updating to ${target} on ${channel} by ${how}. The dashboard restarts near the end; this page reconnects on its own.`
				: `Update requested (${how}). The updater checks GitHub itself and installs the newest version, if any.`
		};
	}
};
