<script lang="ts">
	import { resolve } from '$app/paths';
	import Notice from '#lib/components/skiff/Notice.svelte';

	/**
	 * The banner every Email page except the overview shows until a mail node is chosen
	 * (docs/EMAIL.md §9, the telemetry pattern). Setup has one home, the overview's checklist, so
	 * this only points there.
	 */
	let { platformAdmin }: { platformAdmin: boolean } = $props();
</script>

<Notice tone="info" title="Email isn't set up yet">
	You can add domains and credentials now; nothing is sent until
	{platformAdmin ? 'you choose' : 'a platform admin chooses'} a mail node.
	<a href={resolve('/(dashboard)/email')} class="font-medium underline underline-offset-4"
		>Continue setup on the overview</a
	>{platformAdmin ? '' : ' to see what is left and who does each step'}.
</Notice>
