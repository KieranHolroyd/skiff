<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '#lib/components/ui/button/index.js';
	import PolicyPanel from '../_lib/PolicyPanel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Policies · Settings · Skiff</title></svelte:head>

<SettingsHeader id="policies" />

<div class="space-y-6">
	<p class="text-sm text-muted-foreground">
		Other platform policies sit with what they control: alert thresholds on <Button
			variant="link"
			class="h-auto p-0 align-baseline"
			href={`${resolve('/(dashboard)/alerts')}?tab=system`}>Alerts → System alerts</Button
		>, the ingress driver on <Button
			variant="link"
			class="h-auto p-0 align-baseline"
			href={resolve('/(dashboard)/settings/high-availability')}>High availability</Button
		>, and assistant turn limits on <Button
			variant="link"
			class="h-auto p-0 align-baseline"
			href={resolve('/(dashboard)/settings/assistant')}>Assistant</Button
		>.
	</p>

	<PolicyPanel group="retention" policies={data.policies} defaults={data.policyDefaults} {form} />
	<PolicyPanel
		group="new-databases"
		policies={data.policies}
		defaults={data.policyDefaults}
		{form}
	/>
</div>
