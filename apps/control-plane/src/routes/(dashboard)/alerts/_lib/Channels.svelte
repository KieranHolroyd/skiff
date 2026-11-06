<script lang="ts">
	/**
	 * Where alerts can go (docs/ALERTS.md §3): every channel Skiff knows, whether it is set up,
	 * and a per-channel test. Setting a channel up (SMTP, Twilio, chat webhooks, push keys) stays
	 * in Settings → Notifications, which writes the host's environment.
	 */
	import { resolve } from '$app/paths';
	import type { SystemAlertsView } from '@skiff/contracts';
	import { createQuery } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import SendIcon from '@lucide/svelte/icons/send';
	import SettingsIcon from '@lucide/svelte/icons/settings-2';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import Panel from '../../_lib/Panel.svelte';

	const query = createQuery(() => ({
		queryKey: ['alerts', 'system'] as const,
		queryFn: ({ signal }) =>
			fetchJson<SystemAlertsView>('/api/v1/alerts/system', {
				signal,
				fallback: 'Could not load channels'
			})
	}));
	const view = $derived(query.data);
	const configured = $derived(view?.channelStatus.filter((channel) => channel.configured) ?? []);
	const available = $derived(view?.channelStatus.filter((channel) => !channel.configured) ?? []);

	let testing = $state<string | null>(null);
	let results = $state<Record<string, string>>({});

	async function test(channel?: string) {
		testing = channel ?? '*';
		try {
			const body = await fetchJson<{ delivery: Record<string, string> }>(
				'/api/v1/alerts/channels/test',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(channel ? { channel } : {}),
					fallback: 'The test failed'
				}
			);
			results = { ...results, ...body.delivery };
			const failed = Object.entries(body.delivery).filter(([, outcome]) => outcome !== 'ok');
			if (failed.length) toast.error(`${failed.map(([name]) => name).join(', ')} failed`);
			else toast.success(channel ? `Test sent via ${channel}` : 'Test sent to every channel');
		} catch (error) {
			toast.error(errorText(error, 'The test failed.'));
		} finally {
			testing = null;
		}
	}
</script>

{#if query.isPending}
	<div class="space-y-2"><Skeleton class="h-16" /><Skeleton class="h-16" /></div>
{:else if query.error}
	<Notice tone="danger" title="Could not load channels">{errorText(query.error)}</Notice>
{:else if view}
	<div class="space-y-4">
		{#if configured.length === 0}
			<Notice tone="warning" title="No alert channels are set up">
				Alerts are only written to the server log and shown here until a channel is configured.
				{#if view.canEdit}<a class="underline" href={resolve('/(dashboard)/settings/notifications')}
						>Set one up in Settings → Notifications</a
					>.{/if}
			</Notice>
		{/if}

		<Panel title="Active channels" icon={BellRingIcon} count={configured.length} flush>
			{#snippet actions()}
				{#if view.canEdit}
					{#if configured.length > 1}
						<Button size="sm" variant="outline" onclick={() => test()} disabled={testing !== null}
							>{#if testing === '*'}<Spinner />{:else}<SendIcon />{/if}Test all</Button
						>
					{/if}
					<Button size="sm" variant="outline" href={resolve('/(dashboard)/settings/notifications')}
						><SettingsIcon />Configure</Button
					>
				{/if}
			{/snippet}
			{#if configured.length === 0}
				<p class="px-4 py-6 text-sm text-muted-foreground">None yet.</p>
			{:else}
				<ul class="divide-y">
					{#each configured as channel (channel.name)}
						<li class="flex flex-wrap items-center gap-3 px-4 py-3">
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<span class="font-medium">{channel.label}</span>
									<code class="font-mono text-xs text-muted-foreground">{channel.name}</code>
								</div>
								{#if channel.description}
									<p class="text-sm text-muted-foreground">{channel.description}</p>
								{/if}
							</div>
							{#if results[channel.name]}
								{#if results[channel.name] === 'ok'}
									<StatusBadge status="ok" tone="success" label="Test delivered" />
								{:else}
									<span class="max-w-xs truncate text-xs text-destructive" title={results[channel.name]}
										>{results[channel.name]}</span
									>
								{/if}
							{:else}
								<StatusBadge status="active" tone="success" label="Configured" />
							{/if}
							{#if view.canEdit}
								<Button
									size="sm"
									variant="ghost"
									onclick={() => test(channel.name)}
									disabled={testing !== null}
									aria-label="Send a test via {channel.label}"
									>{#if testing === channel.name}<Spinner />{:else}<SendIcon />{/if}Test</Button
								>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>

		{#if available.length > 0}
			<Panel title="Available channels" flush>
				<ul class="divide-y">
					{#each available as channel (channel.name)}
						<li class="flex flex-wrap items-center gap-3 px-4 py-3">
							<div class="min-w-0 flex-1">
								<span class="font-medium">{channel.label}</span>
								<p class="text-sm text-muted-foreground">{channel.description}</p>
							</div>
							<StatusBadge status="off" tone="neutral" label="Not set up" />
							{#if view.canEdit}
								<Button size="sm" variant="ghost" href={resolve('/(dashboard)/settings/notifications')}
									>Set up</Button
								>
							{/if}
						</li>
					{/each}
				</ul>
			</Panel>
		{/if}

		<p class="text-xs text-muted-foreground">
			Metric alert rules pick channels per rule; built-in alerts pick them per kind under System
			alerts. A rule or kind with no channels picked uses every active channel.
		</p>
	</div>
{/if}
