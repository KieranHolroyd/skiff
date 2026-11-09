<script lang="ts">
	import { resolve } from '$app/paths';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let format = $state<'yaml' | 'json'>('yaml');
	let scope = $state<'all' | 'some'>('all');
	let chosen = $state(new Set<string>());

	const blocked = $derived(scope === 'some' && chosen.size === 0);
	// The download is a plain GET so the browser saves the attachment; see the form below. The route
	// is real; `resolve()` cannot infer past its 25-member union (see SectionHref in sections.ts).
	const action = resolve(
		'/(dashboard)/settings/export/download' as unknown as '/(dashboard)/settings'
	);

	const INCLUDED = [
		['Projects', 'Settings, access modes, environments, domains, workload spec, function, jobs, volumes, secret names and attachments'],
		['Managed services', 'Databases, object storage with buckets, and queue brokers'],
		['Access and identity', 'Roles, bindings, groups, guardrails, auth policy, service accounts, access keys, federation, Yoal Access policies, user pools and clients'],
		['Integrations', 'Log drains, backup targets, event rules, alert rules, email settings and domains, pipeline repositories with variables and environments, registry logins, Git providers, shares and templates']
	] as const;
</script>

<svelte:head><title>Config export · Settings · Yoal</title></svelte:head>

<SettingsHeader id="export" />

<div class="space-y-6">
	<Panel
		title="Download"
		icon={DownloadIcon}
		description="Each section is read with your own permissions. A section you cannot read is listed under skipped in the file instead of failing the export."
	>
		<!-- data-sveltekit-reload: let the browser submit the GET itself so the file downloads. -->
		<form method="GET" {action} data-sveltekit-reload class="space-y-5 px-4 py-4">
			<input type="hidden" name="format" value={format} />

			<Field.Field>
				<Field.Label>Format</Field.Label>
				<ToggleGroup.Root
					type="single"
					variant="outline"
					value={format}
					onValueChange={(value) => value && (format = value as 'yaml' | 'json')}
					class="w-full max-w-xs"
					aria-label="File format"
				>
					<ToggleGroup.Item value="yaml" class="flex-1">YAML</ToggleGroup.Item>
					<ToggleGroup.Item value="json" class="flex-1">JSON</ToggleGroup.Item>
				</ToggleGroup.Root>
			</Field.Field>

			<Field.Set>
				<Field.Legend variant="label">Projects</Field.Legend>
				<Field.Description>
					Organisation-level configuration is always included. Limiting projects only shortens the
					projects list.
				</Field.Description>
				<ToggleGroup.Root
					type="single"
					variant="outline"
					value={scope}
					onValueChange={(value) => value && (scope = value as 'all' | 'some')}
					class="w-full max-w-xs"
					aria-label="Which projects"
				>
					<ToggleGroup.Item value="all" class="flex-1">All ({data.projects.length})</ToggleGroup.Item>
					<ToggleGroup.Item value="some" class="flex-1" disabled={data.projects.length === 0}
						>Choose…</ToggleGroup.Item
					>
				</ToggleGroup.Root>
				{#if scope === 'some'}
					<div class="grid max-h-72 gap-2 overflow-y-auto pt-1 sm:grid-cols-2">
						{#each data.projects as project (project.slug)}
							<Field.Field orientation="horizontal">
								<Checkbox
									id="export-project-{project.slug}"
									name="project"
									value={project.slug}
									bind:checked={
										() => chosen.has(project.slug),
										(value) => {
											const next = new Set(chosen);
											if (value) next.add(project.slug);
											else next.delete(project.slug);
											chosen = next;
										}
									}
								/>
								<Field.Label for="export-project-{project.slug}" class="font-normal">
									<span class="font-mono text-xs">{project.slug}</span>
									<span class="text-muted-foreground">· {project.runtime}</span>
								</Field.Label>
							</Field.Field>
						{/each}
					</div>
				{/if}
			</Field.Set>

			<div class="flex flex-wrap items-center gap-3">
				<Button type="submit" disabled={blocked}>
					<DownloadIcon class="size-4" />
					Download {format === 'json' ? 'JSON' : 'YAML'}
				</Button>
				<span class="text-sm text-muted-foreground">
					{#if blocked}
						Tick at least one project, or choose All.
					{:else}
						Each download is recorded in the audit log as <span class="font-mono text-xs"
							>config.export</span
						>.
					{/if}
				</span>
			</div>
		</form>
	</Panel>

	<Panel
		title="What the file holds"
		icon={ListChecksIcon}
		description="Configuration only, no data. Recreate it on another instance with yoal import. To recover the whole platform with its data, use yoal-restore with a recovery kit."
	>
		<dl class="divide-y text-sm">
			{#each INCLUDED as [label, detail] (label)}
				<div class="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr]">
					<dt class="font-medium">{label}</dt>
					<dd class="text-muted-foreground">{detail}</dd>
				</div>
			{/each}
			<div class="grid gap-1 px-4 py-3 sm:grid-cols-[12rem_1fr]">
				<dt class="font-medium">Never included</dt>
				<dd class="text-muted-foreground">
					Secret values, passwords and credentials (secrets are listed by name only), deployments,
					database rows, bucket objects, volume contents, logs, metrics, pool users and audit
					history.
				</dd>
			</div>
		</dl>
	</Panel>

	<Panel
		title="From the CLI"
		icon={TerminalIcon}
		description="The same export, written to a file, and the import that recreates it elsewhere. Import only creates what is missing and is safe to run again."
	>
		<pre class="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed">yoal export
yoal export --project shop-web,shop-api --out -

# on the new instance: see the plan, then apply it with the secret values
yoal import yoal-config-acme-2026-11-09.yaml
yoal import yoal-config-acme-2026-11-09.yaml --secrets secrets.env --apply</pre>
	</Panel>
</div>
