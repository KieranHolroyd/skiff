<script lang="ts" module>
	export const ROW = 30;
	export const GAP = 8;
</script>

<script lang="ts">
	/**
	 * The 24-column panel grid. Panels are absolutely positioned; in edit mode a panel's
	 * `[data-drag-handle]` drags it and the corner handle resizes it. While a gesture runs, the
	 * layout preview (with collisions pushed down and everything compacted, see grid.ts) is shown
	 * live and committed on release. Below 768 px panels stack full width in reading order.
	 */
	import type { DashboardPanel } from '@skiff/contracts';
	import type { Snippet } from 'svelte';
	import { COLUMNS, bottom, moveItem, readingOrder, resizeItem, type GridItem } from './grid.js';

	let {
		panels,
		editing = false,
		onlayout,
		item
	}: {
		panels: DashboardPanel[];
		editing?: boolean;
		onlayout: (items: GridItem[]) => void;
		item: Snippet<[DashboardPanel]>;
	} = $props();

	let width = $state(0);
	const narrow = $derived(width > 0 && width < 768);
	const column = $derived((width - GAP * (COLUMNS - 1)) / COLUMNS);

	const layout = $derived<GridItem[]>(panels.map((panel) => ({ id: panel.id, ...panel.gridPos })));

	interface Gesture {
		kind: 'move' | 'resize';
		id: string;
		pointer: number;
		startX: number;
		startY: number;
		origin: GridItem;
		/** Pixel offset of the dragged panel while it follows the pointer. */
		dx: number;
		dy: number;
		preview: GridItem[];
	}
	let gesture = $state<Gesture | null>(null);

	const shown = $derived(gesture?.preview ?? layout);
	const byId = $derived(new Map(shown.map((entry) => [entry.id, entry])));

	const px = (entry: GridItem) => ({
		left: entry.x * (column + GAP),
		top: entry.y * (ROW + GAP),
		width: entry.w * column + (entry.w - 1) * GAP,
		height: entry.h * ROW + (entry.h - 1) * GAP
	});

	const height = $derived(Math.max(1, bottom(shown)) * (ROW + GAP));

	function start(event: PointerEvent, panel: DashboardPanel, kind: Gesture['kind']) {
		if (!editing || narrow || event.button !== 0) return;
		const target = event.target as HTMLElement;
		if (kind === 'move') {
			if (
				!target.closest('[data-drag-handle]') ||
				target.closest('button, a, input, select, textarea')
			)
				return;
		}
		event.preventDefault();
		const origin = layout.find((entry) => entry.id === panel.id);
		if (!origin) return;
		capture(event);
		gesture = {
			kind,
			id: panel.id,
			pointer: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			origin,
			dx: 0,
			dy: 0,
			preview: layout
		};
	}

	function move(event: PointerEvent) {
		if (!gesture || event.pointerId !== gesture.pointer) return;
		const dx = event.clientX - gesture.startX;
		const dy = event.clientY - gesture.startY;
		const { origin } = gesture;
		if (gesture.kind === 'move') {
			const x = Math.round(origin.x + dx / (column + GAP));
			const y = Math.round(origin.y + dy / (ROW + GAP));
			gesture = { ...gesture, dx, dy, preview: moveItem(layout, origin.id, x, y) };
		} else {
			const w = Math.max(2, Math.round(origin.w + dx / (column + GAP)));
			const h = Math.max(2, Math.round(origin.h + dy / (ROW + GAP)));
			gesture = { ...gesture, dx, dy, preview: resizeItem(layout, origin.id, w, h) };
		}
	}

	function end(event: PointerEvent) {
		if (!gesture || event.pointerId !== gesture.pointer) return;
		const done = gesture;
		gesture = null;
		const changed = done.preview.some((entry) => {
			const before = layout.find((other) => other.id === entry.id);
			return (
				!before ||
				before.x !== entry.x ||
				before.y !== entry.y ||
				before.w !== entry.w ||
				before.h !== entry.h
			);
		});
		if (changed) onlayout(done.preview);
	}

	function cancel() {
		gesture = null;
	}

	/** Where the dragged panel is drawn: following the pointer (move) or growing (resize). */
	function liveBox(entry: GridItem) {
		const box = px(entry);
		if (!gesture || gesture.id !== entry.id) return box;
		const origin = px(gesture.origin);
		if (gesture.kind === 'move')
			return { ...origin, left: origin.left + gesture.dx, top: origin.top + gesture.dy };
		return {
			...origin,
			width: Math.max(column * 2, origin.width + gesture.dx),
			height: Math.max(ROW * 2, origin.height + gesture.dy)
		};
	}

	/** Keep receiving moves outside the element; fails harmlessly for pointers already gone. */
	function capture(event: PointerEvent) {
		try {
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			// The pointer was released before capture.
		}
	}
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && gesture && cancel()} />

<div bind:clientWidth={width} class="w-full">
	{#if narrow}
		<div class="flex flex-col gap-2">
			{#each readingOrder(panels) as panel (panel.id)}
				<div
					style:height="{Math.max(panel.gridPos.h, panel.viz === 'stat' ? 4 : 6) * (ROW + GAP) -
						GAP}px"
				>
					{@render item(panel)}
				</div>
			{/each}
		</div>
	{:else if width > 0}
		<div class="relative" style:height="{height}px">
			{#if gesture}
				{@const target = byId.get(gesture.id)}
				{#if target}
					{@const box = px(target)}
					<div
						class="pointer-events-none absolute rounded-xl border-2 border-dashed border-brand/50 bg-brand/5 transition-all duration-100"
						style:left="{box.left}px"
						style:top="{box.top}px"
						style:width="{box.width}px"
						style:height="{box.height}px"
					></div>
				{/if}
			{/if}
			{#each panels as panel (panel.id)}
				{@const entry = byId.get(panel.id) ?? { id: panel.id, ...panel.gridPos }}
				{@const box = liveBox(entry)}
				{@const active = gesture?.id === panel.id}
				<div
					class="absolute {active
						? 'z-20 opacity-90 shadow-xl'
						: 'transition-[left,top,width,height] duration-150'}"
					style:left="{box.left}px"
					style:top="{box.top}px"
					style:width="{box.width}px"
					style:height="{box.height}px"
					role="presentation"
					onpointerdown={(event) => start(event, panel, 'move')}
					onpointermove={move}
					onpointerup={end}
					onpointercancel={cancel}
				>
					{@render item(panel)}
					{#if editing}
						<span
							class="absolute right-0.5 bottom-0.5 z-10 size-4 cursor-se-resize touch-none rounded-br-lg"
							role="presentation"
							title="Resize"
							onpointerdown={(event) => {
								event.stopPropagation();
								start(event, panel, 'resize');
							}}
							onpointermove={move}
							onpointerup={end}
							onpointercancel={cancel}
						>
							<svg viewBox="0 0 10 10" class="size-full text-muted-foreground" aria-hidden="true">
								<path
									d="M9 3 L3 9 M9 6 L6 9"
									stroke="currentColor"
									stroke-width="1.2"
									stroke-linecap="round"
								/>
							</svg>
						</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
