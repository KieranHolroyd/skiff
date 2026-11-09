<script lang="ts">
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';

	const options = [
		{ value: 'light', label: 'Light', icon: SunIcon },
		{ value: 'system', label: 'System', icon: MonitorIcon },
		{ value: 'dark', label: 'Dark', icon: MoonIcon }
	] as const;
</script>

<ToggleGroup.Root
	type="single"
	size="sm"
	variant="outline"
	value={userPrefersMode.current}
	onValueChange={(value) => value && setMode(value as 'light' | 'dark' | 'system')}
	aria-label="Colour theme"
>
	{#each options as option (option.value)}
		<ToggleGroup.Item value={option.value} aria-label="{option.label} theme" class="size-7 px-0">
			<option.icon class="size-3.5" />
		</ToggleGroup.Item>
	{/each}
</ToggleGroup.Root>
