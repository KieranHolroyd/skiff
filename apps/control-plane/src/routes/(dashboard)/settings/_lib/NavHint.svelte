<script lang="ts" module>
	import type { BackupStatus } from './backup-status.js';

	export interface Hints {
		members: number | null;
		invitations: number | null;
		apiKeys: number | null;
		platform: {
			availability: string | null;
			email: boolean;
			alerts: boolean;
			assistant: boolean;
			backups: Promise<BackupStatus | null>;
		} | null;
	}
</script>

<script lang="ts">
	import type { Tone } from '#lib/status.js';
	import type { SectionId } from './sections.js';

	/** The quiet detail at the end of a settings nav item: a count, or a status dot. */
	let {
		id,
		hints,
		update
	}: {
		id: SectionId;
		hints: Hints;
		update: Promise<{ latest: string } | null> | null;
	} = $props();

	const dot: Record<Tone, string> = {
		success: 'bg-success',
		warning: 'bg-warning',
		danger: 'bg-destructive',
		info: 'bg-info',
		brand: 'bg-brand',
		neutral: 'bg-muted-foreground/50'
	};

	const notifications = $derived.by((): { tone: Tone; label: string } | null => {
		const platform = hints.platform;
		if (!platform) return null;
		if (!platform.email && !platform.alerts)
			return { tone: 'warning', label: 'Email and alerts not set up' };
		if (!platform.email) return { tone: 'warning', label: 'Email not set up' };
		if (!platform.alerts) return { tone: 'warning', label: 'No alert channel' };
		return { tone: 'success', label: 'Email and alerts on' };
	});
</script>

{#snippet countHint(value: number | null)}
	{#if value !== null && value > 0}
		<span class="ml-auto text-xs text-muted-foreground tabular-nums">{value}</span>
	{/if}
{/snippet}

{#snippet dotHint(tone: Tone, label: string)}
	<span class="ml-auto flex items-center" title={label}>
		<span class="size-1.5 rounded-full {dot[tone]}" aria-hidden="true"></span>
		<span class="sr-only">({label})</span>
	</span>
{/snippet}

{#if id === 'members'}
	{#if hints.invitations}
		<span
			class="ml-auto rounded-full bg-info/10 px-1.5 text-[0.7rem] font-medium text-info tabular-nums"
			title="{hints.invitations} pending {hints.invitations === 1 ? 'invitation' : 'invitations'}"
		>
			+{hints.invitations}
		</span>
	{:else}
		{@render countHint(hints.members)}
	{/if}
{:else if id === 'api-keys'}
	{@render countHint(hints.apiKeys)}
{:else if id === 'notifications' && notifications}
	{@render dotHint(notifications.tone, notifications.label)}
{:else if id === 'assistant' && hints.platform?.assistant}
	{@render dotHint('success', 'On')}
{:else if id === 'backups' && hints.platform}
	{#await hints.platform.backups then status}
		{#if status}{@render dotHint(status.tone, status.label)}{/if}
	{/await}
{:else if id === 'updates' && update}
	{#await update then available}
		{#if available}
			<span
				class="ml-auto rounded-full bg-brand/10 px-1.5 font-mono text-[0.7rem] font-medium text-brand"
				title="Skiff {available.latest} is available"
			>
				{available.latest}
			</span>
		{/if}
	{/await}
{/if}
