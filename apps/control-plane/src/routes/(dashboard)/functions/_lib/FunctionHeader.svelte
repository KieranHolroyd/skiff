<script lang="ts">
	import type { Snippet } from 'svelte';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import ServiceHeader from '../../_lib/service/ServiceHeader.svelte';

	/**
	 * The top of every function page: identity, one line of facts and actions. Sections are in the
	 * sidebar (`./subnav.ts`); the deployment sub-route renders this too, so a deployment reads as
	 * part of its function.
	 */
	let {
		slug,
		meta,
		children
	}: {
		slug: string;
		meta?: Snippet;
		children?: Snippet;
	} = $props();
</script>

<ServiceHeader icon={ZapIcon} title={slug} target="function.header" {meta} {children} />
