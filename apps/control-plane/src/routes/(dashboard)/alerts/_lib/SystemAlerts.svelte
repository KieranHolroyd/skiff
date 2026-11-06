<script lang="ts">
	/**
	 * Built-in alerts (docs/ALERTS.md): each kind on or off, its channels and thresholds, and how
	 * often a still-true alert repeats. Platform admins read it; the platform owner edits it. One
	 * draft for the whole page, saved together, so thresholds that depend on each other (the two
	 * certificate windows) are validated as a pair.
	 */
	import type {
		PlatformPolicyKey,
		SystemAlertKind,
		SystemAlertRouting,
		SystemAlertsUpdate,
		SystemAlertsView
	} from '@skiff/contracts';
	import { untrack } from 'svelte';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatRelative } from '../../_lib/format.js';

	const KEY = ['alerts', 'system'] as const;
	const queryClient = useQueryClient();
	const query = createQuery(() => ({
		queryKey: KEY,
		queryFn: ({ signal }) =>
			fetchJson<SystemAlertsView>('/api/v1/alerts/system', {
				signal,
				fallback: 'Could not load system alerts'
			})
	}));
	const view = $derived(query.data);

	// --- draft -----------------------------------------------------------------------------

	type Draft = {
		routing: Record<SystemAlertKind, { enabled: boolean; channels: string[] }>;
		values: Partial<Record<PlatformPolicyKey, number>>;
		repeatMinutes: number;
	};

	function fromView(source: SystemAlertsView): Draft {
		return {
			routing: Object.fromEntries(
				source.alerts.map((alert) => [
					alert.kind,
					{ enabled: alert.enabled, channels: [...alert.channels] }
				])
			) as Draft['routing'],
			values: Object.assign({}, ...source.alerts.map((alert) => alert.values)),
			repeatMinutes: source.repeatMinutes
		};
	}

	let draft = $state<Draft | null>(null);
	let baseline = $state('');
	let saving = $state(false);

	$effect(() => {
		// Adopt fresh server state unless the user has unsaved edits. Only `view` is a dependency:
		// reading `draft` here (JSON.stringify walks all of it) and then assigning it would
		// re-run this effect forever.
		const current = view;
		if (!current) return;
		untrack(() => {
			if (draft && JSON.stringify(draft) !== baseline) return;
			const next = fromView(current);
			draft = next;
			baseline = JSON.stringify(next);
		});
	});

	const dirty = $derived(draft !== null && JSON.stringify(draft) !== baseline);
	const canEdit = $derived(view?.canEdit === true);

	function toggleChannel(kind: SystemAlertKind, name: string) {
		if (!draft) return;
		const route = draft.routing[kind];
		route.channels = route.channels.includes(name)
			? route.channels.filter((channel) => channel !== name)
			: [...route.channels, name];
	}

	async function save() {
		if (!draft || !view) return;
		const before = JSON.parse(baseline) as Draft;
		const routing: SystemAlertRouting = {};
		for (const [kind, route] of Object.entries(draft.routing) as Array<
			[SystemAlertKind, Draft['routing'][SystemAlertKind]]
		>) {
			if (JSON.stringify(route) !== JSON.stringify(before.routing[kind])) routing[kind] = route;
		}
		const policies: NonNullable<SystemAlertsUpdate['policies']> = {};
		for (const [key, value] of Object.entries(draft.values) as Array<[PlatformPolicyKey, number]>)
			if (value !== before.values[key]) (policies as Record<string, number>)[key] = Number(value);
		if (draft.repeatMinutes !== before.repeatMinutes)
			policies.systemAlertRepeatMinutes = Number(draft.repeatMinutes);
		saving = true;
		try {
			const saved = await fetchJson<SystemAlertsView>('/api/v1/alerts/system', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ routing, policies }),
				fallback: 'Could not save system alerts'
			});
			const next = fromView(saved);
			draft = next;
			baseline = JSON.stringify(next);
			queryClient.setQueryData(KEY, saved);
			toast.success('System alerts saved');
		} catch (error) {
			toast.error(errorText(error, 'Could not save system alerts.'));
		} finally {
			saving = false;
		}
	}

	function reset() {
		if (!view) return;
		draft = fromView(view);
		baseline = JSON.stringify(draft);
	}

	const unitLabel = { percent: '%', minutes: 'min', days: 'days' } as const;
</script>

{#if query.isPending}
	<div class="space-y-2"><Skeleton class="h-24" /><Skeleton class="h-24" /><Skeleton class="h-24" /></div>
{:else if query.error}
	<Notice tone="danger" title="Could not load system alerts">{errorText(query.error)}</Notice>
{:else if view && draft}
	<div class="space-y-4">
		<p class="max-w-3xl text-sm text-muted-foreground">
			Built-in alerts raised by the platform itself: no rule to write. Choose which ones notify,
			where they go, and when they trigger. Fired alerts appear in History.
			{#if !canEdit}Only the platform owner can change these.{/if}
		</p>

		<Panel title="Built-in alerts" icon={ShieldAlertIcon} flush>
			{#snippet actions()}
				<label class="flex items-center gap-2 text-sm">
					<span class="text-muted-foreground">Repeat while true every</span>
					<Input
						type="number"
						class="h-8 w-20 tabular-nums"
						min={5}
						max={1440}
						bind:value={draft!.repeatMinutes}
						disabled={!canEdit}
						aria-label="Repeat interval in minutes"
					/>
					<span class="text-muted-foreground">min</span>
				</label>
			{/snippet}
			<ul class="divide-y">
				{#each view.alerts as alert (alert.kind)}
					{@const route = draft.routing[alert.kind]}
					<li class="grid gap-3 px-4 py-4 md:grid-cols-[auto_1fr_auto] md:items-start">
						<Switch
							checked={route.enabled}
							onCheckedChange={(value) => (route.enabled = value)}
							disabled={!canEdit}
							aria-label="{alert.label} enabled"
						/>
						<div class="min-w-0 space-y-2" class:opacity-60={!route.enabled}>
							<div>
								<div class="flex flex-wrap items-center gap-2">
									<span class="font-medium">{alert.label}</span>
									<Badge variant="outline" class="font-normal">{alert.severity}</Badge>
									{#if alert.recentCount > 0}
										<Badge variant="warning">{alert.recentCount} in 24 h</Badge>
									{/if}
								</div>
								<p class="text-sm text-muted-foreground">{alert.description}</p>
								{#if alert.lastFiredAt}
									<p class="text-xs text-muted-foreground" title={alert.lastFiredAt}>
										Last: {alert.lastTitle} · {formatRelative(alert.lastFiredAt)}
									</p>
								{/if}
							</div>
							<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Channels for {alert.label}">
								<span class="mr-1 text-xs text-muted-foreground">Send to</span>
								<button
									type="button"
									disabled={!canEdit}
									onclick={() => (route.channels = [])}
									aria-pressed={route.channels.length === 0}
								>
									<Badge variant={route.channels.length === 0 ? 'brand' : 'outline'}>All channels</Badge>
								</button>
								{#each view.channels as channel (channel.name)}
									<button
										type="button"
										disabled={!canEdit}
										onclick={() => toggleChannel(alert.kind, channel.name)}
										aria-pressed={route.channels.includes(channel.name)}
									>
										<Badge variant={route.channels.includes(channel.name) ? 'brand' : 'outline'}
											>{channel.label}</Badge
										>
									</button>
								{/each}
								{#each route.channels.filter((name) => !view.channels.some((channel) => channel.name === name)) as missing (missing)}
									<Badge variant="danger" title="This channel is no longer configured">{missing} (not set up)</Badge>
								{/each}
							</div>
						</div>
						{#if alert.thresholds.length > 0}
							<div class="flex flex-wrap gap-3 md:justify-end">
								{#each alert.thresholds as threshold (threshold.key)}
									<label class="flex items-center gap-1.5 text-sm">
										<span class="text-muted-foreground">{threshold.label}</span>
										<Input
											type="number"
											class="h-8 w-20 tabular-nums"
											min={threshold.min}
											max={threshold.max}
											bind:value={draft.values[threshold.key]}
											disabled={!canEdit}
										/>
										<span class="text-muted-foreground">{unitLabel[threshold.unit]}</span>
									</label>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</Panel>

		{#if canEdit}
			<div class="sticky bottom-4 flex justify-end gap-2">
				{#if dirty}
					<Button variant="outline" onclick={reset} disabled={saving}>Discard</Button>
				{/if}
				<Button onclick={save} disabled={!dirty || saving}>
					{#if saving}<Spinner />{/if}Save changes
				</Button>
			</div>
		{/if}
	</div>
{/if}
