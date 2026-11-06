<script lang="ts">
	import NetworkIcon from '@lucide/svelte/icons/network';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	// svelte-ignore state_referenced_locally -- the page intentionally seeds the editor once
	let text = $state(JSON.stringify(data.config, null, 2));
	const result = $derived(form as { success?: string; message?: string } | null);
</script>

<SettingsHeader
	id="clustering"
	description="Advanced cluster tunables. Changes apply to the next join, placement, lease cycle or maintenance sweep."
/>

<form method="POST" action="?/save" class="space-y-5">
	<Panel title="Cluster configuration" icon={NetworkIcon} description="Validated against the ClusterConfig schema; unknown keys are rejected.">
		<Field.Field>
			<Field.Label for="cluster-config">JSON</Field.Label>
			<Textarea id="cluster-config" name="config" bind:value={text} rows={26} class="font-mono text-xs" spellcheck="false" />
			<Field.Description>
				Overlay CIDR/MTU/port, endpoint port range and mTLS, replica limits and spread, database replica limits, storage targets, control-plane lease timing, automatic failover and the share mount root.
			</Field.Description>
		</Field.Field>
		{#if result?.message}<p class="text-sm text-destructive">{result.message}</p>{/if}
		{#if result?.success}<p class="text-sm text-success">{result.success}</p>{/if}
	</Panel>
	<div class="flex justify-end">
		<Button type="submit">Save configuration</Button>
	</div>
</form>
