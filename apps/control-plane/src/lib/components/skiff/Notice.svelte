<script lang="ts">
	import type { Snippet } from 'svelte';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import InfoIcon from '@lucide/svelte/icons/info';

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
		success: {
			icon: CircleCheckIcon,
			box: 'border-success/30 bg-success-soft text-success-soft-foreground',
			role: 'status'
		},
		danger: {
			icon: CircleAlertIcon,
			box: 'border-danger/30 bg-danger-soft text-danger-soft-foreground',
			role: 'alert'
		},
		warning: {
			icon: TriangleAlertIcon,
			box: 'border-warning/40 bg-warning-soft text-warning-soft-foreground',
			role: 'status'
		},
		info: {
			icon: InfoIcon,
			box: 'border-info/30 bg-info-soft text-info-soft-foreground',
			role: 'status'
		}
	} as const;

	const c = $derived(config[tone]);
</script>

<div
	class="flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[13px] leading-5 {c.box} {className}"
	role={c.role}
>
	<c.icon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
	<div class="min-w-0 flex-1">
		{#if title}<p class="font-medium">{title}</p>{/if}
		{#if children}
			<div class={title ? 'opacity-90' : ''}>{@render children()}</div>
		{/if}
	</div>
</div>
