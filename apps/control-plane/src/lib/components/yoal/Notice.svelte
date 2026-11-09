<script lang="ts">
	import type { Snippet } from 'svelte';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import InfoIcon from '@lucide/svelte/icons/info';
	import * as Alert from '#lib/components/ui/alert/index.js';

	/** A shadcn Alert with an icon picked from the tone. */
	let {
		tone = 'info',
		title,
		children,
		class: className = ''
	}: {
		tone?: 'success' | 'danger' | 'warning' | 'info';
		title?: string;
		children?: Snippet;
		class?: string;
	} = $props();

	const config = {
		success: { icon: CircleCheckIcon, variant: 'success', role: 'status' },
		danger: { icon: CircleAlertIcon, variant: 'destructive', role: 'alert' },
		warning: { icon: TriangleAlertIcon, variant: 'warning', role: 'status' },
		info: { icon: InfoIcon, variant: 'info', role: 'status' }
	} as const;

	const c = $derived(config[tone]);
</script>

<Alert.Root variant={c.variant} role={c.role} class={className}>
	<c.icon />
	{#if title}<Alert.Title>{title}</Alert.Title>{/if}
	{#if children}
		<Alert.Description>{@render children()}</Alert.Description>
	{/if}
</Alert.Root>
