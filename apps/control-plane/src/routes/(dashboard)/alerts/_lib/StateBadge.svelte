<script lang="ts">
	/** A series or rule state: firing is destructive, pending a warning, no data neutral. */
	import type { AlertState } from '@yoal/contracts';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';

	let {
		state,
		paused = false,
		class: className = ''
	}: { state: AlertState; paused?: boolean; class?: string } = $props();

	const STYLES: Record<AlertState, { label: string; variant: BadgeVariant; dot: string }> = {
		firing: { label: 'Firing', variant: 'danger', dot: 'bg-destructive animate-pulse' },
		pending: { label: 'Pending', variant: 'warning', dot: 'bg-warning' },
		nodata: { label: 'No data', variant: 'neutral', dot: 'bg-muted-foreground' },
		normal: { label: 'OK', variant: 'success', dot: 'bg-success' }
	};
	const style = $derived(STYLES[state]);
</script>

{#if paused}
	<Badge variant="outline" class="text-muted-foreground {className}">Paused</Badge>
{:else}
	<Badge variant={style.variant} class={className}>
		<span class="size-1.5 rounded-full {style.dot}" aria-hidden="true"></span>{style.label}
	</Badge>
{/if}
