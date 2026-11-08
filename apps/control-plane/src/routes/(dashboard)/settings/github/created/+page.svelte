<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import SettingsHeader from '../../_lib/SettingsHeader.svelte';

	/** Only rendered when the GitHub round-trip failed; success redirects to Settings → GitHub. */
	let { data } = $props();
</script>

<svelte:head><title>GitHub · Settings · Skiff</title></svelte:head>

<SettingsHeader id="github" />

<div class="space-y-4">
	<Notice tone="danger" title="GitHub did not finish connecting">{data.error}</Notice>
	<Button variant="outline" href={resolve('/(dashboard)/settings/github')}><ArrowLeftIcon />Back to GitHub settings</Button>
</div>
