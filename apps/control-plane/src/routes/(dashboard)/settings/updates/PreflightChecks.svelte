<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { plural } from '../../_lib/format.js';
	import { checkLabel } from './update-ui.js';

	interface Check {
		id: string;
		status: 'ok' | 'warn' | 'error';
		message: string;
	}

	/**
	 * Pre-update checks, problems first. Passed checks fold away so the reason an update would be
	 * refused is the first thing read.
	 */
	let {
		checks,
		ok,
		description,
		updateAvailable
	}: {
		checks: Check[];
		ok: boolean;
		description: string;
		/** Without a pending update a failing check is a heads-up, not a refusal. */
		updateAvailable: boolean;
	} = $props();

	const look = {
		ok: { icon: CircleCheckIcon, tone: 'text-success', label: 'Passed' },
		warn: { icon: TriangleAlertIcon, tone: 'text-warning', label: 'Warning' },
		error: { icon: CircleXIcon, tone: 'text-destructive', label: 'Blocks the update' }
	} as const;

	const errors = $derived(checks.filter((check) => check.status === 'error'));
	const warnings = $derived(checks.filter((check) => check.status === 'warn'));
	const passed = $derived(checks.filter((check) => check.status === 'ok'));
	const problems = $derived([...errors, ...warnings]);

	let showPassed = $state(false);

	const badge = $derived(
		!ok
			? {
					status: 'blocked',
					label: updateAvailable ? `${errors.length} blocking` : `${errors.length} would block`,
					tone: 'danger' as const
				}
			: warnings.length > 0
				? {
						status: 'ready',
						label: `Ready · ${warnings.length} to review`,
						tone: 'warning' as const
					}
				: { status: 'ready', label: 'All clear', tone: 'success' as const }
	);

	const segments = $derived(
		[
			{ count: errors.length, class: 'bg-destructive', label: 'blocking' },
			{ count: warnings.length, class: 'bg-warning', label: 'to review' },
			{ count: passed.length, class: 'bg-success', label: 'passed' }
		].filter((segment) => segment.count > 0)
	);
</script>

{#snippet row(check: Check)}
	{@const l = look[check.status]}
	<li class="flex items-start gap-3 py-3">
		<l.icon class="mt-0.5 size-4 shrink-0 {l.tone}" aria-label={l.label} />
		<div class="min-w-0 flex-1 space-y-0.5">
			<p class="text-sm font-medium">{checkLabel(check.id)}</p>
			<p class="text-sm text-pretty break-words text-muted-foreground">{check.message}</p>
		</div>
	</li>
{/snippet}

<Panel id="preflight" title="Pre-update checks" {description} icon={ShieldCheckIcon}>
	{#snippet actions()}
		<StatusBadge status={badge.status} label={badge.label} tone={badge.tone} />
	{/snippet}

	<div class="space-y-2">
		<div class="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
			{#each segments as segment (segment.label)}
				<span class="h-full {segment.class}" style:flex-grow={segment.count}></span>
			{/each}
		</div>
		<p class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
			{#each segments as segment (segment.label)}
				<span class="inline-flex items-center gap-1.5">
					<span class="size-1.5 rounded-full {segment.class}" aria-hidden="true"></span>
					<span class="font-medium text-foreground tabular-nums">{segment.count}</span>
					{segment.label}
				</span>
			{/each}
		</p>
	</div>

	{#if problems.length > 0}
		<ul class="mt-2 divide-y">
			{#each problems as check (check.id + check.message)}
				{@render row(check)}
			{/each}
		</ul>
	{/if}

	{#if passed.length > 0}
		<div class="mt-2 border-t pt-2">
			<button
				type="button"
				class="-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
				aria-expanded={showPassed}
				aria-controls="preflight-passed"
				onclick={() => (showPassed = !showPassed)}
			>
				<CircleCheckIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
				<span class="flex-1">
					{problems.length === 0 ? 'All' : ''}
					{passed.length}
					{plural(passed.length, 'check')} passed
				</span>
				<ChevronDownIcon
					class="size-4 transition-transform {showPassed ? 'rotate-180' : ''}"
					aria-hidden="true"
				/>
			</button>
			{#if showPassed}
				<ul id="preflight-passed" class="divide-y">
					{#each passed as check (check.id + check.message)}
						{@render row(check)}
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		The updater runs these again on the exact release before changing anything, and refuses to
		continue while one is failing.
	{/snippet}
</Panel>
