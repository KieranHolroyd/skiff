<script lang="ts">
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import MonitorSmartphoneIcon from '@lucide/svelte/icons/monitor-smartphone';
	import SendIcon from '@lucide/svelte/icons/send';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { invalidateAll } from '$app/navigation';
	import { runAction } from '#lib/actions.js';
	import { formatRelative } from '#lib/assistant/format.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import type { PageProps } from './$types';

	type PushState = PageProps['data']['push'];

	/**
	 * Web Push alerts (D108). Each browser subscribes itself: the dashboard installed as an app on a
	 * phone or desktop is the main case (on iPhone and iPad it is the only one: Safari only allows
	 * push from a Home Screen app). Server actions live in _push.server.ts and ./push/+server.ts.
	 */
	let { push, ready: configReady }: { push: PushState; ready: boolean } = $props();

	type Support = 'checking' | 'supported' | 'unsupported' | 'ios-browser';
	let support = $state<Support>('checking');
	let permission = $state<NotificationPermission>('default');
	let standalone = $state(false);
	/** This browser's current endpoint, if it is subscribed with our key. */
	let endpoint = $state<string | null>(null);
	let busy = $state<'on' | 'off' | 'test' | 'install' | null>(null);
	let installPrompt = $state<(Event & { prompt(): Promise<void> }) | null>(null);

	const thisDevice = $derived(push.devices.find((device) => device.endpoint === endpoint) ?? null);
	const otherDevices = $derived(push.devices.filter((device) => device.endpoint !== endpoint));

	function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
		const binary = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = new Uint8Array(new ArrayBuffer(binary.length));
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	function sameKey(subscription: PushSubscription, publicKey: string): boolean {
		const key = subscription.options?.applicationServerKey;
		if (!key) return true;
		const a = new Uint8Array(key);
		const b = keyBytes(publicKey);
		return a.length === b.length && a.every((value, index) => value === b[index]);
	}

	async function registration(): Promise<ServiceWorkerRegistration> {
		const existing = await navigator.serviceWorker.getRegistration('/');
		if (existing) return existing;
		// SvelteKit registers /service-worker.js on load; wait for it, but not forever.
		return await Promise.race([
			navigator.serviceWorker.ready,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('the service worker did not start')), 10_000)
			)
		]);
	}

	async function refresh() {
		if (support !== 'supported') return;
		permission = Notification.permission;
		try {
			const reg = await navigator.serviceWorker.getRegistration('/');
			const subscription = await reg?.pushManager.getSubscription();
			endpoint =
				subscription && push.publicKey && sameKey(subscription, push.publicKey)
					? subscription.endpoint
					: null;
		} catch {
			endpoint = null;
		}
	}

	onMount(() => {
		standalone =
			window.matchMedia('(display-mode: standalone)').matches ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true;
		const ios =
			/iPad|iPhone|iPod/.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		const capable =
			'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
		support = capable ? 'supported' : ios && !standalone ? 'ios-browser' : 'unsupported';
		void refresh();

		const onPrompt = (event: Event) => {
			event.preventDefault();
			installPrompt = event as Event & { prompt(): Promise<void> };
		};
		const onInstalled = () => (installPrompt = null);
		window.addEventListener('beforeinstallprompt', onPrompt);
		window.addEventListener('appinstalled', onInstalled);
		return () => {
			window.removeEventListener('beforeinstallprompt', onPrompt);
			window.removeEventListener('appinstalled', onInstalled);
		};
	});

	async function turnOn() {
		if (!push.publicKey) return;
		busy = 'on';
		try {
			permission = await Notification.requestPermission();
			if (permission !== 'granted') {
				toast.error(
					permission === 'denied'
						? 'Notifications are blocked for this site. Allow them in the browser or system settings, then try again.'
						: 'Notifications were not allowed.'
				);
				return;
			}
			const reg = await registration();
			let subscription = await reg.pushManager.getSubscription();
			// Subscribed with another server's (or an old) key: start over with ours.
			if (subscription && !sameKey(subscription, push.publicKey)) {
				await subscription.unsubscribe();
				subscription = null;
			}
			subscription ??= await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: keyBytes(push.publicKey)
			});
			const response = await fetch('/settings/notifications/push', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ subscription: subscription.toJSON() })
			});
			const result = (await response.json().catch(() => ({}))) as { message?: string };
			if (!response.ok) throw new Error(result.message ?? `the server answered ${response.status}`);
			endpoint = subscription.endpoint;
			toast.success('Push alerts are on for this device.');
			await invalidateAll();
		} catch (error) {
			toast.error(`Could not turn on push alerts: ${(error as Error).message}`);
		} finally {
			busy = null;
		}
	}

	async function turnOff() {
		busy = 'off';
		try {
			const reg = await navigator.serviceWorker.getRegistration('/');
			const subscription = await reg?.pushManager.getSubscription();
			const current = subscription?.endpoint ?? endpoint;
			await subscription?.unsubscribe();
			if (current)
				await fetch('/settings/notifications/push', {
					method: 'DELETE',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ endpoint: current })
				});
			endpoint = null;
			toast.success('Push alerts are off for this device.');
			await invalidateAll();
		} catch (error) {
			toast.error(`Could not turn off push alerts: ${(error as Error).message}`);
		} finally {
			busy = null;
		}
	}

	async function test(id?: string) {
		busy = 'test';
		await runAction('?/testPush', id ? { id } : {}, { apply: false });
		busy = null;
	}

	function remove(device: PushState['devices'][number]) {
		askConfirm({
			title: `Stop alerts to ${device.device}?`,
			description:
				'That device stops receiving push alerts. Turn push on there again to get them back.',
			confirmLabel: 'Remove',
			tone: 'danger',
			action: '?/removePushDevice',
			fields: { id: device.id }
		});
	}

	async function install() {
		if (!installPrompt) return;
		busy = 'install';
		await installPrompt.prompt().catch(() => undefined);
		installPrompt = null;
		busy = null;
	}

	function setUp() {
		askConfirm({
			title: 'Set up push notifications?',
			description:
				'Skiff creates a key pair for signing push alerts and restarts the dashboard for a few seconds.',
			confirmLabel: 'Set up',
			action: '?/setupPush'
		});
	}

	function when(iso: string | null): string {
		return iso ? formatRelative(Date.parse(iso)) : 'never';
	}
</script>

<Panel
	title="Push notifications"
	icon={BellRingIcon}
	description="Alerts on your phone or computer, from Skiff installed as an app."
>
	{#snippet actions()}
		<StatusBadge
			status={!push.ready ? 'unverified' : push.totalDevices ? 'active' : 'unverified'}
			label={!push.ready
				? 'Not set up'
				: push.totalDevices
					? `${push.totalDevices} device${push.totalDevices === 1 ? '' : 's'}`
					: 'No devices'}
		/>
	{/snippet}

	{#if !push.ready}
		<div class="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
			<p class="min-w-0 flex-1">
				{#if push.canSetUp}
					This server has no push keys yet: it was updated by an older updater. Set them up once
					here, or run <code>sudo skiff-update-self check</code> on the server.
				{:else}
					This server has no push keys. Set <code>SKIFF_VAPID_PUBLIC_KEY</code> and
					<code>SKIFF_VAPID_PRIVATE_KEY</code>, or run the installer or
					<code>skiff-update-self</code>, which create them.
				{/if}
			</p>
			{#if push.canSetUp}
				<Button size="sm" onclick={setUp} disabled={!configReady}
					><KeyRoundIcon />Set up push</Button
				>
			{/if}
		</div>
	{:else}
		<div class="space-y-4">
			{#if support === 'ios-browser'}
				<Alert.Root>
					<MonitorSmartphoneIcon />
					<Alert.Title>Add Skiff to your Home Screen first</Alert.Title>
					<Alert.Description>
						On iPhone and iPad, Safari only allows notifications from installed apps. Tap Share,
						then Add to Home Screen, open Skiff from there and come back to this page.
					</Alert.Description>
				</Alert.Root>
			{:else if support === 'unsupported'}
				<Alert.Root variant="warning">
					<TriangleAlertIcon />
					<Alert.Description>This browser cannot receive push notifications.</Alert.Description>
				</Alert.Root>
			{:else if support === 'supported'}
				<Item.Root variant="outline" size="sm">
					<Item.Media variant="icon"><MonitorSmartphoneIcon /></Item.Media>
					<Item.Content class="min-w-0">
						<Item.Title>
							This device
							{#if endpoint && thisDevice}
								<StatusBadge status="active" label="On" />
							{:else if permission === 'denied'}
								<StatusBadge status="failed" label="Blocked" />
							{/if}
						</Item.Title>
						<Item.Description>
							{#if endpoint && thisDevice}
								{thisDevice.device} · last delivered {when(thisDevice.lastSuccessAt)}
								{#if thisDevice.lastError}<span class="text-destructive">
										· {thisDevice.lastError}</span
									>{/if}
							{:else if permission === 'denied'}
								Notifications are blocked for this site; allow them in the browser or system
								settings.
							{:else if !standalone}
								Works in this browser, or install Skiff as an app to get alerts like any other app.
							{:else}
								Get Skiff alerts here even when the app is closed.
							{/if}
						</Item.Description>
					</Item.Content>
					<Item.Actions>
						{#if installPrompt && !standalone}
							<Button variant="outline" size="sm" onclick={install} disabled={busy !== null}>
								{#if busy === 'install'}<Spinner />{:else}<DownloadIcon />{/if}
								Install app
							</Button>
						{/if}
						{#if endpoint && thisDevice}
							<Button
								variant="outline"
								size="sm"
								onclick={() => test(thisDevice.id)}
								disabled={busy !== null}
							>
								{#if busy === 'test'}<Spinner />{:else}<SendIcon />{/if}
								Test
							</Button>
							<Button variant="ghost-danger" size="sm" onclick={turnOff} disabled={busy !== null}>
								{#if busy === 'off'}<Spinner />{:else}<BellOffIcon />{/if}
								Turn off
							</Button>
						{:else}
							<Button
								size="sm"
								onclick={turnOn}
								disabled={busy !== null || permission === 'denied'}
							>
								{#if busy === 'on'}<Spinner />{:else}<BellRingIcon />{/if}
								Turn on
							</Button>
						{/if}
					</Item.Actions>
				</Item.Root>
			{/if}

			{#if otherDevices.length}
				<Item.Group class="gap-2">
					{#each otherDevices as device (device.id)}
						<Item.Root variant="outline" size="sm">
							<Item.Media variant="icon"><MonitorSmartphoneIcon /></Item.Media>
							<Item.Content class="min-w-0">
								<Item.Title>{device.device}</Item.Title>
								<Item.Description class="truncate">
									Added {when(device.createdAt)} · last delivered {when(device.lastSuccessAt)}
									{#if device.lastError}<span class="text-destructive">
											· {device.lastError}</span
										>{/if}
								</Item.Description>
							</Item.Content>
							<Item.Actions>
								<Button
									variant="outline"
									size="sm"
									onclick={() => test(device.id)}
									disabled={busy !== null}><SendIcon />Test</Button
								>
								<Button variant="ghost-danger" size="sm" onclick={() => remove(device)}
									>Remove</Button
								>
							</Item.Actions>
						</Item.Root>
					{/each}
				</Item.Group>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		Every owner’s subscribed devices get the same alerts as the other channels. A device that
		uninstalls the app or blocks notifications is removed automatically.
	{/snippet}
</Panel>
