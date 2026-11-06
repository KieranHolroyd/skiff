<script lang="ts">
	/**
	 * Time range toolbar: shift back, the range picker (quick ranges plus a custom absolute or
	 * relative from/to), shift forward and zoom out. Times are UTC throughout.
	 */
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ZoomOutIcon from '@lucide/svelte/icons/zoom-out';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as ButtonGroup from '#lib/components/ui/button-group/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import Popover from './Popover.svelte';
	import {
		CALENDAR_RANGES,
		QUICK_RANGES,
		formatInput,
		isRelative,
		rangeLabel,
		resolveRange,
		shiftRange,
		zoomOut,
		type TimeRange
	} from './time.js';

	let { value, onchange }: { value: TimeRange; onchange: (range: TimeRange) => void } = $props();

	let open = $state(false);
	let from = $state('');
	let to = $state('');
	let error = $state<string | null>(null);
	let now = $state(Date.now());

	// Fill the custom fields from the current range each time the picker opens.
	$effect(() => {
		if (!open) return;
		now = Date.now();
		const resolved = resolveRange(value, now);
		from = isRelative(value.from) || !resolved ? value.from : formatInput(resolved.from);
		to = isRelative(value.to) || !resolved ? value.to : formatInput(resolved.to);
		error = null;
	});

	const label = $derived(rangeLabel(value, now));

	function pick(range: TimeRange) {
		open = false;
		onchange({ from: range.from, to: range.to });
	}

	function apply(event: SubmitEvent) {
		event.preventDefault();
		const range = {
			from: isRelative(from) ? from.trim() : toIso(from),
			to: isRelative(to) ? to.trim() : toIso(to)
		};
		if (!resolveRange(range, Date.now())) {
			error = 'Use now-6h style times or YYYY-MM-DD HH:mm:ss (UTC), with From before To.';
			return;
		}
		pick(range);
	}

	function toIso(text: string): string {
		const trimmed = text.trim();
		const withZone = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(trimmed)
			? `${trimmed.replace(' ', 'T')}Z`
			: trimmed;
		const ms = Date.parse(withZone);
		return Number.isNaN(ms) ? trimmed : new Date(ms).toISOString();
	}
</script>

<ButtonGroup.Root aria-label="Time range">
	<Button
		variant="outline"
		size="icon"
		aria-label="Move back in time"
		title="Move back"
		onclick={() => onchange(shiftRange(value, -1, Date.now()))}
	>
		<ChevronLeftIcon />
	</Button>
	<Popover bind:open class="w-[min(34rem,calc(100vw-2rem))] p-0">
		{#snippet trigger({ props })}
			<Button
				{...props}
				variant="outline"
				class="max-w-64 font-normal"
				aria-label="Time range: {label}"
			>
				<ClockIcon />
				<span class="truncate">{label}</span>
				<span class="text-xs text-muted-foreground">UTC</span>
			</Button>
		{/snippet}
		<div class="grid sm:grid-cols-[1fr_12rem]">
			<form class="space-y-3 border-b p-3 sm:border-r sm:border-b-0" onsubmit={apply}>
				<p class="text-sm font-medium">Custom range</p>
				<label class="block space-y-1 text-xs text-muted-foreground">
					<span>From</span>
					<Input
						bind:value={from}
						class="font-mono text-xs"
						placeholder="now-6h"
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
				<label class="block space-y-1 text-xs text-muted-foreground">
					<span>To</span>
					<Input
						bind:value={to}
						class="font-mono text-xs"
						placeholder="now"
						autocomplete="off"
						spellcheck="false"
					/>
				</label>
				{#if error}<p class="text-xs text-destructive" role="alert">{error}</p>{/if}
				<p class="text-xs text-muted-foreground">
					Relative: <code class="font-mono">now-2d</code>, <code class="font-mono">now/d</code>.
					Absolute:
					<code class="font-mono">2026-11-06 09:00</code> (UTC).
				</p>
				<Button type="submit" size="sm">Apply time range</Button>
			</form>
			<div class="max-h-80 overflow-y-auto p-1.5">
				<ul class="space-y-0.5">
					{#each [...QUICK_RANGES, ...CALENDAR_RANGES] as range (range.from + range.to)}
						{@const active = range.from === value.from && range.to === value.to}
						<li>
							<button
								type="button"
								class="w-full rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none {active
									? 'bg-muted font-medium text-foreground'
									: 'text-muted-foreground'}"
								onclick={() => pick(range)}
							>
								{range.label}
							</button>
						</li>
					{/each}
				</ul>
			</div>
		</div>
	</Popover>
	<Button
		variant="outline"
		size="icon"
		aria-label="Move forward in time"
		title="Move forward"
		onclick={() => onchange(shiftRange(value, 1, Date.now()))}
	>
		<ChevronRightIcon />
	</Button>
	<Button
		variant="outline"
		size="icon"
		aria-label="Zoom out"
		title="Zoom out (double the range)"
		onclick={() => onchange(zoomOut(value, Date.now()))}
	>
		<ZoomOutIcon />
	</Button>
</ButtonGroup.Root>
