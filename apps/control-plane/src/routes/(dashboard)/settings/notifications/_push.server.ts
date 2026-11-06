import { fail, type Actions } from '@sveltejs/kit';
import { deliverPush } from '@skiff/core';
import { configAvailability } from '#lib/server/platform-config.js';
import { pushStore, vapid } from '#lib/server/push.js';
import { formString } from '../../_lib/errors.js';
import { queueConfig, requireOwnerPage } from '../_platform.server.js';

/**
 * Settings → Notifications → Push (D108): Web Push alerts to the owners' devices, usually the
 * dashboard installed as an app. Each browser subscribes itself through `./push/+server.ts`; this
 * module lists the owner's devices, sends tests and removes devices.
 */

export interface PushDeviceView {
	id: string;
	device: string;
	/** Not the full URL (it is a bearer capability); just the push service host. */
	service: string;
	endpoint: string;
	createdAt: string;
	lastSuccessAt: string | null;
	lastError: string | null;
}

export interface PushState {
	/** This control plane has VAPID keys. */
	ready: boolean;
	publicKey: string | null;
	/** Subscribed devices of the signed-in owner. */
	devices: PushDeviceView[];
	/** Devices of every owner (alerts go to all of them). */
	totalDevices: number;
	/** Keys can be created from here (installed host with the root helper). */
	canSetUp: boolean;
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

export function pushState(userId: string): PushState {
	const devices = vapid ? pushStore.listForUser(userId) : [];
	return {
		ready: Boolean(vapid),
		publicKey: vapid?.publicKey ?? null,
		devices: devices.map((device) => ({
			id: device.id,
			device: device.device || 'Unknown browser',
			service: new URL(device.endpoint).hostname,
			endpoint: device.endpoint,
			createdAt: new Date(device.createdAt).toISOString(),
			lastSuccessAt: iso(device.lastSuccessAt),
			lastError: device.lastError
		})),
		totalDevices: vapid ? pushStore.count() : 0,
		canSetUp: configAvailability() === 'ready'
	};
}

export const pushActions = {
	/** A test to one of the owner's own devices (or all of them), not to every owner. */
	testPush: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		if (!vapid) return fail(409, { message: 'Push notifications are not set up yet.' });
		const id = formString(await request.formData(), 'id');
		const mine = pushStore.all().filter((device) => device.userId === principal.userId);
		const targets = id ? mine.filter((device) => device.id === id) : mine;
		if (targets.length === 0)
			return fail(404, { message: 'Turn on push notifications on a device first.' });
		const result = await deliverPush(
			pushStore,
			targets,
			{
				title: 'Skiff: Test alert',
				body: `This is a test push from Skiff, sent by ${locals.user?.email ?? principal.userId}. Real alerts look like this.`,
				tag: 'test',
				url: '/settings/notifications',
				severity: 'info',
				timestamp: Date.now()
			},
			vapid
		);
		if (result.sent === 0)
			return fail(502, {
				message: result.failures.length
					? `Test push failed — ${result.failures.join('; ')}`
					: 'That device is no longer subscribed, so it was removed. Turn push on again there.'
			});
		const removed = result.removed ? ` ${result.removed} unsubscribed device(s) removed.` : '';
		return {
			success: `Test push sent to ${result.sent} device${result.sent === 1 ? '' : 's'}.${removed}`
		};
	},

	removePushDevice: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const id = formString(await request.formData(), 'id');
		if (!id || !pushStore.remove(id, principal.userId))
			return fail(404, { message: 'That device is not subscribed.' });
		return { success: 'Device removed. It no longer receives alerts.' };
	},

	/** Hosts updated by an updater that predates push: create the keys through the root helper. */
	setupPush: async ({ locals }) => {
		requireOwnerPage(locals);
		if (vapid) return { success: 'Push notifications are already set up.' };
		if (configAvailability() === 'local')
			return fail(409, {
				message: 'A dev server creates its own keys in .data/vapid.json; restart it.'
			});
		return queueConfig(
			locals,
			{ action: 'push-keys' },
			'Creating the push keys — the dashboard restarts for a few seconds.'
		);
	}
} satisfies Actions;
