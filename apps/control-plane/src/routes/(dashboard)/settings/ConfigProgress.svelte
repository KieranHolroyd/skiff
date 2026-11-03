<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { PlatformConfigOutcome, PlatformConfigStatus } from '@skiff/contracts';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formatDateTime } from '../_lib/format.js';

	type StatusView = PlatformConfigStatus & { stale: boolean };
	interface Live {
		status: StatusView | null;
		pending: boolean;
		inFlight: boolean;
	}

	/**
	 * Progress and result of a platform-settings change. Applying restarts the control plane, so
	 * polls fail for a few seconds; keep going and say we are reconnecting. Only shows a finished
	 * result for the sections this page owns.
	 */
	let {
		status,
		pending,
		inFlight,
		sections,
		availability,
		restartPending = false
	}: {
		status: StatusView | null;
		pending: boolean;
		inFlight: boolean;
		/** Which results to show here: configure sections and/or `backups` / `restore-drill` actions. */
		sections: string[];
		availability: 'local' | 'unmanaged' | 'not-enabled' | 'ready';
		/** Dev server: settings were saved after it started. */
		restartPending?: boolean;
	} = $props();

	let live = $state<Live | null>(null);
	let reconnecting = $state(false);
	const view = $derived<Live>(live ?? { status, pending, inFlight });
	const relevant = $derived(
		view.status && sections.includes(view.status.section ?? view.status.action) ? view.status : null
	);

	$effect(() => {
		if (!view.inFlight) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			try {
				const response = await fetch('/settings/platform-status', { cache: 'no-store' });
				if (!response.ok) throw new Error(String(response.status));
				const next = (await response.json()) as Live;
				reconnecting = false;
				if (stopped) return;
				live = next;
				if (!next.inFlight) {
					await invalidateAll();
					live = null;
					return;
				}
			} catch {
				reconnecting = true;
			}
			if (!stopped) timer = setTimeout(tick, 1_500);
		};
		timer = setTimeout(tick, 1_000);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});

	const finished: Record<
		PlatformConfigOutcome,
		{ variant: 'success' | 'warning' | 'destructive' | 'info'; title: string }
	> = {
		applied: { variant: 'success', title: 'Applied' },
		unchanged: { variant: 'info', title: 'No change' },
		reverted: { variant: 'warning', title: 'Reverted' },
		rejected: { variant: 'destructive', title: 'Not applied' },
		error: { variant: 'destructive', title: 'Failed' }
	};
	const icons = {
		success: CircleCheckIcon,
		warning: TriangleAlertIcon,
		destructive: CircleAlertIcon,
		info: InfoIcon
	};
	/** Results older than a day are history, not news. */
	const recent = $derived(
		relevant?.finishedAt ? Date.now() - Date.parse(relevant.finishedAt) < 86_400_000 : false
	);
</script>

{#if availability === 'local' && restartPending}
	<Alert.Root variant="warning">
		<TriangleAlertIcon />
		<Alert.Title>Restart the dev server to apply</Alert.Title>
		<Alert.Description>
			The new settings are saved in <code>.data/platform-settings.json</code>, but this server still
			uses the ones it started with. Stop <code>bun run dev</code> and start it again.
		</Alert.Description>
	</Alert.Root>
{:else if availability === 'local'}
	<Alert.Root variant="info">
		<InfoIcon />
		<Alert.Title>Local development server</Alert.Title>
		<Alert.Description>
			Settings saved here go to <code>.data/platform-settings.json</code> (gitignored) and override
			your shell environment after a dev-server restart. On an installed server they are written to
			<code>/etc/skiff/skiff.env</code> instead.
		</Alert.Description>
	</Alert.Root>
{:else if availability === 'unmanaged'}
	<Alert.Root variant="info">
		<InfoIcon />
		<Alert.Title>Not an installed release</Alert.Title>
		<Alert.Description>
			This production build is not running from an installed release, so these settings come from
			its environment and cannot be changed here. Hosts installed with <code>install.sh</code> can change
			them from this page.
		</Alert.Description>
	</Alert.Root>
{:else if availability === 'not-enabled'}
	<Alert.Root variant="warning">
		<TriangleAlertIcon />
		<Alert.Title>Not enabled on this host yet</Alert.Title>
		<Alert.Description>
			Run <code>sudo skiff-update-self check</code> on the server once. It installs the small root helper
			that applies settings from this page; nothing else changes.
		</Alert.Description>
	</Alert.Root>
{/if}

{#if view.inFlight}
	<Alert.Root variant="info" aria-live="polite">
		<Spinner />
		<Alert.Title>Applying…</Alert.Title>
		<Alert.Description>
			{view.status?.running && !view.status.stale
				? view.status.message
				: 'Queued — the server picks it up in a moment.'}
			{#if reconnecting}<span class="block text-xs opacity-80"
					>The control plane is restarting; reconnecting…</span
				>{/if}
		</Alert.Description>
	</Alert.Root>
{:else if view.status?.stale && relevant}
	<Alert.Root variant="warning">
		<TriangleAlertIcon />
		<Alert.Title>The last change stopped reporting</Alert.Title>
		<Alert.Description>
			It last said “{view.status.message}” at {formatDateTime(view.status.updatedAt)}. Check
			<code>journalctl -u skiff-platform-config</code> on the server. You can try again.
		</Alert.Description>
	</Alert.Root>
{:else if relevant?.outcome && recent}
	{@const shown = finished[relevant.outcome]}
	{@const Icon = icons[shown.variant]}
	<Alert.Root variant={shown.variant}>
		<Icon />
		<Alert.Title>{shown.title}</Alert.Title>
		<Alert.Description>
			{relevant.message}
			<span class="block text-xs opacity-80"
				>{formatDateTime(relevant.finishedAt ?? relevant.updatedAt)}</span
			>
		</Alert.Description>
	</Alert.Root>
{/if}
