<script lang="ts">
	import ChartLineIcon from '@lucide/svelte/icons/chart-line';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import LinkIcon from '@lucide/svelte/icons/link';
	import { enhance } from '$app/forms';
	import { toast } from 'svelte-sonner';
	import type { MetricsSection } from '@skiff/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const SECTIONS: Array<{ id: MetricsSection; label: string; description: string; path: string }> = [
		{ id: 'usage', label: 'Usage and quotas', description: 'Used and limit per quota metric for the org.', path: '/metrics/usage' },
		{ id: 'apps', label: 'Apps', description: 'Deployments, builds, workloads, domains and release bytes per app.', path: '/metrics/apps[/<slug>]' },
		{ id: 'traffic', label: 'App traffic', description: 'Last-hour requests, egress and latency per app. Reads ClickHouse, the costliest section.', path: '/metrics/traffic[/<slug>]' },
		{ id: 'databases', label: 'Databases', description: 'Size, connections, pooler and last-hour activity per database.', path: '/metrics/databases[/<name>]' },
		{ id: 'storage', label: 'Object storage', description: 'Bytes, objects and buckets per storage instance.', path: '/metrics/storage[/<name>]' },
		{ id: 'brokers', label: 'Queue brokers', description: 'Connections, store, backlog and last-hour message rates per broker, plus one series per stream.', path: '/metrics/brokers[/<name>]' },
		{ id: 'volumes', label: 'App volumes', description: 'Size and usage per app volume.', path: '/metrics/volumes[/<slug>]' },
		{ id: 'platform', label: 'Nodes and node volumes', description: 'Fleet health: node CPU, memory, disk, certificates and volume capacity.', path: '/metrics/platform' }
	];

	// Form state, seeded from the saved settings (and re-seeded after a save).
	let publicPlatform = $state(false);
	let cacheSeconds = $state('15');
	let maxApps = $state('500');
	let sections = $state<Record<MetricsSection, boolean>>({
		usage: true,
		apps: true,
		traffic: true,
		databases: true,
		storage: true,
		brokers: true,
		volumes: true,
		platform: true
	});
	let saving = $state(false);

	$effect.pre(() => {
		publicPlatform = data.settings.publicPlatform;
		cacheSeconds = String(data.settings.cacheSeconds);
		maxApps = String(data.settings.maxApps);
		sections = { ...data.settings.sections };
	});

	const origin = $derived(data.platformOrigin.replace(/\/$/, ''));
	const scrapeConfig = $derived(`scrape_configs:
  - job_name: skiff
    scheme: https
    metrics_path: /metrics/apps   # or /metrics, /metrics/apps/<slug>, …
    scrape_interval: 60s
    authorization:
      credentials: skif_…         # an API key with metrics:read
    static_configs:
      - targets: ['${origin.replace(/^https?:\/\//, '')}']`);
</script>

<svelte:head><title>Metrics · Settings · Skiff</title></svelte:head>

<SettingsHeader id="metrics" />

<form
	method="POST"
	action="?/save"
	class="space-y-6"
	use:enhance={() => {
		saving = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			saving = false;
			if (result.type === 'success') toast.success('Metrics settings saved');
			else if (result.type === 'failure')
				toast.error(String((result.data as { message?: unknown } | undefined)?.message ?? 'Could not save'));
		};
	}}
>
	<Panel
		title="Prometheus export"
		description="Point Prometheus (or Grafana Alloy / Agent) at /metrics with an API key that has metrics:read. Each key sees only its own organisation."
		icon={ChartLineIcon}
	>
		<Field.Group>
			<Field.Field orientation="horizontal" class="gap-2">
				<input type="hidden" name="publicPlatform" value={publicPlatform ? 'true' : ''} />
				<Switch id="metrics-public" bind:checked={publicPlatform} />
				<Field.Content>
					<Field.Label for="metrics-public" class="font-normal">Public fleet summary</Field.Label>
					<Field.Description>
						Answer an unauthenticated <code class="font-mono text-xs">GET /metrics</code> with node, volume and
						platform-wide traffic counts. Turn off to require an API key everywhere.
					</Field.Description>
				</Field.Content>
			</Field.Field>
		</Field.Group>
	</Panel>

	<Panel
		title="Sections"
		description="A disabled section is left out of /metrics and its own path returns 404. Scrape a section path to pull only what a dashboard needs."
		icon={LinkIcon}
	>
		<Field.Group>
			{#each SECTIONS as section (section.id)}
				<Field.Field orientation="horizontal" class="gap-2">
					<input type="hidden" name={`section.${section.id}`} value={sections[section.id] ? 'true' : ''} />
					<Switch id={`metrics-section-${section.id}`} bind:checked={sections[section.id]} />
					<Field.Content>
						<Field.Label for={`metrics-section-${section.id}`} class="font-normal">
							{section.label}
							<code class="ml-2 font-mono text-xs text-muted-foreground">{section.path}</code>
						</Field.Label>
						<Field.Description>
							{section.description}
							{#if section.id === 'traffic' && !data.telemetryInstalled}
								Needs the telemetry store (Settings → Telemetry); empty until it is installed.
							{/if}
						</Field.Description>
					</Field.Content>
				</Field.Field>
			{/each}
		</Field.Group>
	</Panel>

	<Panel
		title="Performance"
		description="Every scrape costs the same few queries however many apps there are; these bound the size and frequency of the work."
		icon={GaugeIcon}
	>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field>
				<Field.Label for="metrics-cache">Cache (seconds)</Field.Label>
				<Input id="metrics-cache" name="cacheSeconds" type="number" min={0} max={300} required bind:value={cacheSeconds} />
				<Field.Description>
					Reuse a rendered scrape for this long. Several Prometheus replicas then cost one render. 0 turns it off.
				</Field.Description>
			</Field.Field>
			<Field.Field>
				<Field.Label for="metrics-max-apps">Max apps per scrape</Field.Label>
				<Input id="metrics-max-apps" name="maxApps" type="number" min={1} max={10000} required bind:value={maxApps} />
				<Field.Description>
					Caps <code class="font-mono text-xs">/metrics</code> and <code class="font-mono text-xs">/metrics/apps</code>
					(alphabetical); <code class="font-mono text-xs">skiff_scrape_truncated</code> reports a cut. Per-app paths are never capped.
				</Field.Description>
			</Field.Field>
		</div>
	</Panel>

	<Panel title="Prometheus scrape config" description="Paste into prometheus.yml, then add Prometheus as a Grafana data source.">
		<pre class="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{scrapeConfig}</pre>
	</Panel>

	<div class="flex justify-end">
		<Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
	</div>
</form>
