<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import SendIcon from '@lucide/svelte/icons/send';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { enhance } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import { usageMetricKeys, type UsageMetricKey } from '@yoal/contracts';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const view = $derived(data.usageAnalytics);
	let enabled = $state(false);
	let endpoint = $state('');
	let saving = $state(false);
	let sending = $state(false);

	$effect.pre(() => {
		enabled = view.enabled;
		endpoint = view.endpointSource === 'environment' ? '' : view.endpoint;
	});

	const labels: Record<UsageMetricKey, string> = {
		orgs: 'Organisations',
		users: 'User accounts',
		members: 'Organisation memberships',
		nodes: 'Nodes',
		nodesOnline: 'Nodes online',
		projects: 'Projects',
		projectsStatic: 'Static projects',
		projectsProcess: 'Process projects',
		projectsContainer: 'Container projects',
		deployments: 'Deployments',
		deploymentsActive: 'Active deployments',
		deployments30d: 'Deployments in the last 30 days',
		databases: 'Databases',
		databaseEngines: 'Database engines in use',
		storageInstances: 'Object storage instances',
		brokers: 'Queue brokers',
		volumes: 'App volumes',
		functions: 'Functions',
		pipelines: 'Pipeline repositories',
		registryRepositories: 'Registry repositories',
		emailDomains: 'Email domains',
		ssoProviders: 'SSO providers',
		userPools: 'User pools',
		domains: 'Custom domains',
		shareLinks: 'Share links',
		accessKeys: 'Access keys'
	};

	const when = (value: string | null) =>
		value
			? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
			: '—';

	const sample = $derived(view.sample);
	const payload = $derived(JSON.stringify(sample, null, 2));
</script>

<svelte:head><title>Usage analytics · Settings · Yoal</title></svelte:head>

<SettingsHeader id="usage-analytics" />

<div class="space-y-6">
	{#if view.lastError}
		<Alert.Root variant="destructive">
			<TriangleAlertIcon />
			<Alert.Title>The last ping did not reach the collector</Alert.Title>
			<Alert.Description>
				{view.lastError} The next attempt is in about a day. Nothing is retried in a loop.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<Panel
		title="Send anonymous usage data"
		description="This helps us understand how Yoal is used and where to add features. It is off by default, and you can turn it off again at any time."
		icon={ActivityIcon}
	>
		{#snippet actions()}
			<Badge variant={view.enabled ? 'default' : 'secondary'}>{view.enabled ? 'On' : 'Off'}</Badge>
		{/snippet}

		<form
			method="POST"
			action="?/save"
			class="space-y-5"
			use:enhance={() => {
				saving = true;
				return async ({ result, update }) => {
					await update({ reset: false });
					saving = false;
					if (result.type === 'success') toast.success('Preference saved');
					else if (result.type === 'failure')
						toast.error(
							String(
								(result.data as { message?: unknown } | undefined)?.message ?? 'Could not save'
							)
						);
				};
			}}
		>
			<Field.Group>
				<Field.Field orientation="horizontal" class="gap-2">
					<input type="hidden" name="enabled" value={enabled ? 'true' : ''} />
					<Switch id="usage-analytics" bind:checked={enabled} />
					<Field.Content>
						<Field.Label for="usage-analytics" class="font-normal">
							Send anonymous usage data
						</Field.Label>
						<Field.Description>
							One small ping a day with counts — never a hostname, address, user, organisation,
							project or domain name. The payload is listed below and the collector is open source.
						</Field.Description>
					</Field.Content>
				</Field.Field>
			</Field.Group>

			<Field.Field>
				<Field.Label for="usage-endpoint">Collector endpoint</Field.Label>
				<Input
					id="usage-endpoint"
					name="endpoint"
					type="url"
					bind:value={endpoint}
					disabled={view.endpointSource === 'environment'}
					placeholder={view.endpoint}
				/>
				<Field.Description>
					{#if view.endpointSource === 'environment'}
						Set by <code class="font-mono text-xs">YOAL_USAGE_ANALYTICS_ENDPOINT</code> on the server,
						so it cannot be changed here.
					{:else}
						Leave blank for the built-in collector at <code class="font-mono text-xs"
							>{view.endpoint}</code
						>. Point this at your own copy if you would rather not report to us — the source and
						protocol are in the repository.
					{/if}
				</Field.Description>
			</Field.Field>

			<dl class="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Last ping</dt>
					<dd>{when(view.lastSentAt)}</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Next ping</dt>
					<dd>{when(view.nextSendAt)}</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Install id</dt>
					<dd class="font-mono text-xs break-all">
						{view.installId ?? 'Assigned when you turn this on'}
					</dd>
				</div>
			</dl>

			<div class="flex flex-wrap items-center gap-2">
				<Button type="submit" disabled={saving} size="sm">
					{saving ? 'Saving…' : 'Save preference'}
				</Button>
				{#if view.enabled}
					<p class="text-xs text-muted-foreground">
						Turning this off stops all sending immediately. The install id is kept so turning it
						back on does not look like a new install; it is deleted with the platform database.
					</p>
				{/if}
			</div>
		</form>
	</Panel>

	<Panel
		title="Exactly what is sent"
		description="This is the body of the next ping, built from this install right now. Nothing else is transmitted."
		icon={ShieldCheckIcon}
	>
		<dl class="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Protocol</dt>
				<dd class="font-mono">v{sample.v}</dd>
			</div>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Yoal version</dt>
				<dd class="font-mono">{sample.version}</dd>
			</div>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Platform</dt>
				<dd class="font-mono">{sample.os} / {sample.arch}</dd>
			</div>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Frequency</dt>
				<dd>At most once a day</dd>
			</div>
		</dl>

		<div class="mt-6 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
			{#each usageMetricKeys as key (key)}
				<div class="flex items-baseline justify-between gap-3 border-b border-dashed pb-1">
					<span class="text-muted-foreground">{labels[key]}</span>
					<span class="font-mono tabular-nums">{sample.metrics[key]}</span>
				</div>
			{/each}
		</div>

		<div class="mt-6 space-y-3 text-sm">
			<div>
				<p class="text-xs text-muted-foreground">Feature flags that are on</p>
				<div class="mt-1 flex flex-wrap gap-1.5">
					{#each sample.features as feature (feature)}
						<Badge variant="outline" class="font-mono text-xs">{feature}</Badge>
					{:else}
						<span class="text-muted-foreground">None</span>
					{/each}
				</div>
			</div>
			<div>
				<p class="text-xs text-muted-foreground">Optional services that are configured</p>
				<div class="mt-1 flex flex-wrap gap-1.5">
					{#each sample.capabilities as capability (capability)}
						<Badge variant="outline" class="font-mono text-xs">{capability}</Badge>
					{:else}
						<span class="text-muted-foreground">None</span>
					{/each}
				</div>
			</div>
		</div>

		<details class="mt-6">
			<summary class="cursor-pointer text-sm text-muted-foreground">Show the raw JSON</summary>
			<pre
				class="mt-2 max-h-96 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs">{payload}</pre>
			{#if !view.installId}
				<p class="mt-2 text-xs text-muted-foreground">
					While this is off, the install id is shown as zeros. It is generated the first time you
					turn the setting on, so nothing about this install exists at the collector until then.
				</p>
			{/if}
		</details>
	</Panel>

	<Panel
		title="What is never sent"
		description="The collector refuses anything outside the schema above, so a field cannot be added by accident."
		icon={ShieldCheckIcon}
	>
		<ul class="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
			<li>No hostnames, IP addresses or domain names.</li>
			<li>No user, organisation or project names, or their ids.</li>
			<li>No file paths, environment variables or secret names.</li>
			<li>No request logs, page views or visitor addresses.</li>
			<li>No email addresses or billing details.</li>
			<li>No cookies, and no identifier derived from your server.</li>
		</ul>
		<p class="mt-4 text-sm text-muted-foreground">
			The only identifier is the random install id above. The collector keeps raw pings for a
			bounded retention window and never stores an address. Read the design, the payload and the
			collector's source in <a class="underline underline-offset-4" href={data.sourceUrl}
				>docs/USAGE-ANALYTICS.md</a
			>.
		</p>
	</Panel>

	{#if view.enabled}
		<Panel
			title="Send a ping now"
			description="Useful after a firewall change, or to confirm that this host can reach the collector."
			icon={SendIcon}
		>
			<form
				method="POST"
				action="?/send"
				use:enhance={() => {
					sending = true;
					return async ({ result, update }) => {
						await update({ reset: false });
						sending = false;
						if (result.type === 'success') toast.success('Ping sent');
						else if (result.type === 'failure')
							toast.error(
								String(
									(result.data as { message?: unknown } | undefined)?.message ?? 'Could not send'
								)
							);
					};
				}}
			>
				<Button type="submit" variant="outline" size="sm" disabled={sending}>
					<SendIcon />{sending ? 'Sending…' : 'Send one ping'}
				</Button>
			</form>
		</Panel>
	{/if}
</div>
