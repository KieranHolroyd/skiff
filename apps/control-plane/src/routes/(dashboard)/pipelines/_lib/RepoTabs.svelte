<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import * as Tabs from '#lib/components/ui/tabs/index.js';

	/** Runs | Settings for one repository. */
	let { repo, current }: { repo: string; current: 'runs' | 'settings' } = $props();

	function open(value: string) {
		void goto(
			value === 'settings'
				? resolve('/(dashboard)/pipelines/[repo]/settings', { repo })
				: resolve('/(dashboard)/pipelines/[repo]', { repo })
		);
	}
</script>

<Tabs.Root value={current} onValueChange={open}>
	<Tabs.List variant="line" class="w-full justify-start border-b" aria-label="Repository sections">
		<Tabs.Trigger value="runs" class="flex-none"><HistoryIcon />Runs</Tabs.Trigger>
		<Tabs.Trigger value="settings" class="flex-none"><SettingsIcon />Settings</Tabs.Trigger>
	</Tabs.List>
</Tabs.Root>
