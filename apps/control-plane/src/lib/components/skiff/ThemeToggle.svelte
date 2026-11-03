<script lang="ts">
	import { onMount } from 'svelte';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';

	type Theme = 'light' | 'system' | 'dark';
	let theme = $state<Theme>('system');
	let { class: className = '' }: { class?: string } = $props();

	const options = [
		{ value: 'light', label: 'Light theme', icon: SunIcon },
		{ value: 'system', label: 'System theme', icon: MonitorIcon },
		{ value: 'dark', label: 'Dark theme', icon: MoonIcon }
	] as const;

	function apply(value: Theme) {
		const dark =
			value === 'dark' ||
			(value === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
		document.documentElement.classList.toggle('dark', dark);
	}

	function choose(value: Theme) {
		theme = value;
		try {
			localStorage.setItem('skiff-theme', value);
		} catch {
			// Storage can be unavailable (private mode); the choice still applies for this page.
		}
		apply(value);
	}

	onMount(() => {
		try {
			theme = (localStorage.getItem('skiff-theme') as Theme | null) ?? 'system';
		} catch {
			theme = 'system';
		}
		const media = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => theme === 'system' && apply('system');
		media.addEventListener('change', onChange);
		return () => media.removeEventListener('change', onChange);
	});
</script>

<div
	class="inline-flex items-center gap-0.5 rounded-lg border border-sidebar-border bg-black/15 p-0.5 {className}"
	role="radiogroup"
	aria-label="Colour theme"
>
	{#each options as option (option.value)}
		{@const Icon = option.icon}
		<button
			type="button"
			role="radio"
			aria-checked={theme === option.value}
			aria-label={option.label}
			title={option.label}
			onclick={() => choose(option.value)}
			class="grid size-6 place-items-center rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {theme ===
			option.value
				? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-xs'
				: 'text-sidebar-muted hover:text-sidebar-foreground'}"
		>
			<Icon class="size-3.5" aria-hidden="true" />
		</button>
	{/each}
</div>
