<script lang="ts">
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LockKeyholeIcon from '@lucide/svelte/icons/lock-keyhole';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';

	/** Access mode for production or previews: public, password or platform login. */
	let { mode, scope }: { mode: string; scope?: string } = $props();

	const config = $derived(
		mode === 'password'
			? { icon: LockKeyholeIcon, label: 'Password', tone: 'text-warning-soft-foreground' }
			: mode === 'platform'
				? { icon: ShieldCheckIcon, label: 'Platform login', tone: 'text-info-soft-foreground' }
				: { icon: GlobeIcon, label: 'Public', tone: 'text-success-soft-foreground' }
	);
</script>

<span
	class="inline-flex h-6 items-center gap-1.5 rounded-md border bg-card px-2 text-xs whitespace-nowrap"
>
	<span aria-hidden="true"><config.icon class="size-3.5 {config.tone}" /></span>
	{#if scope}<span class="text-muted-foreground">{scope}</span>{/if}
	<span class="font-medium">{config.label}</span>
</span>
