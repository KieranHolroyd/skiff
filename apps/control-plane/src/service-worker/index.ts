/**
 * The dashboard's service worker: it makes the dashboard installable as an app and shows Web Push
 * alerts (D108). It deliberately has no `fetch` handler and caches nothing, so the dashboard is
 * never served stale after an update.
 *
 * Payload (packages/core/src/web-push.ts `PushPayload`): { title, body, tag?, url?, severity?, timestamp? }.
 */
import { self } from '$app/service-worker';

interface Payload {
	title?: string;
	body?: string;
	tag?: string;
	url?: string;
	severity?: 'info' | 'warning' | 'critical';
	timestamp?: number;
}

self.addEventListener('install', () => {
	void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
	let payload: Payload;
	try {
		payload = (event.data?.json() ?? {}) as Payload;
	} catch {
		payload = { body: event.data?.text() ?? '' };
	}
	// Same-origin paths only: a payload must never send the user somewhere else.
	const url =
		typeof payload.url === 'string' && payload.url.startsWith('/') && !payload.url.startsWith('//')
			? payload.url
			: '/';
	event.waitUntil(
		self.registration.showNotification(payload.title || 'Yoal', {
			body: payload.body ?? '',
			tag: payload.tag,
			icon: '/icons/icon-192.png',
			badge: '/icons/badge-96.png',
			timestamp: payload.timestamp,
			requireInteraction: payload.severity === 'critical',
			data: { url }
		} as NotificationOptions)
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const path = (event.notification.data as { url?: string } | null)?.url ?? '/';
	const target = new URL(path, self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
			if (open) {
				await open.focus();
				if (open.url !== target) await open.navigate(target).catch(() => undefined);
				return;
			}
			await self.clients.openWindow(target);
		})()
	);
});

// The browser rotated the subscription (expired keys, push service migration): re-register it so
// alerts keep arriving without the owner opening Settings.
self.addEventListener('pushsubscriptionchange', (event) => {
	const change = event as Event & {
		oldSubscription?: PushSubscription | null;
		newSubscription?: PushSubscription | null;
		waitUntil(promise: Promise<unknown>): void;
	};
	change.waitUntil(
		(async () => {
			const subscription =
				change.newSubscription ??
				(change.oldSubscription?.options
					? await self.registration.pushManager.subscribe(change.oldSubscription.options)
					: null);
			if (!subscription) return;
			await fetch('/settings/notifications/push', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					subscription: subscription.toJSON(),
					previousEndpoint: change.oldSubscription?.endpoint ?? null
				})
			});
		})().catch(() => undefined)
	);
});
