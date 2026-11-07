<script lang="ts">
	import { resolve } from '$app/paths';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';

	/** Foot of the settings sidebar: a way into the permission table on Settings → General. */
	let { role }: { role: string } = $props();

	const article = $derived(['admin', 'owner'].includes(role) ? 'an' : 'a');
	const href = `${resolve('/(dashboard)/settings')}#access`;
</script>

<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved route plus a fragment -->
<a
	{href}
	class="flex items-start gap-2.5 rounded-lg border border-dashed border-sidebar-border px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:border-solid hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
>
	<ShieldCheckIcon class="mt-px size-3.5 shrink-0" />
	<span>
		What can {article} <span class="font-medium capitalize">{role}</span> do? See every permission your
		role holds.
	</span>
</a>
<!-- eslint-enable svelte/no-navigation-without-resolve -->
