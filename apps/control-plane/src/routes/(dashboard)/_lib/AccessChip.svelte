<script lang="ts">
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LockKeyholeIcon from '@lucide/svelte/icons/lock-keyhole';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { Badge } from '#lib/components/ui/badge/index.js';

	/** Access mode for production or previews: public, password or platform login. */
	let { mode, scope }: { mode: string; scope?: string } = $props();

	const config = $derived(
		mode === 'password'
			? { icon: LockKeyholeIcon, label: 'Password', tone: 'text-warning' }
			: mode === 'platform'
				? { icon: ShieldCheckIcon, label: 'Platform login', tone: 'text-info' }
				: { icon: GlobeIcon, label: 'Public', tone: 'text-success' }
	);
</script>

<Badge variant="outline" class="font-normal">
	<config.icon class={config.tone} />
	{#if scope}<span class="text-muted-foreground">{scope}</span>{/if}
	<span class="font-medium">{config.label}</span>
</Badge>
