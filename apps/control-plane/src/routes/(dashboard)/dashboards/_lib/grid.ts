/**
 * The dashboard grid: 24 columns of 30 px rows, react-grid-layout style. Moving or resizing a
 * panel pushes whatever it lands on downwards, then everything floats up as far as it can
 * (vertical compaction). The moved panel wins ties, so it keeps the spot it was dropped on.
 */

export const COLUMNS = 24;

export interface GridItem {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export function collides(a: GridItem, b: GridItem): boolean {
	if (a.id === b.id) return false;
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** The first row below every item. */
export function bottom(items: GridItem[]): number {
	return items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
}

function clampItem(item: GridItem): GridItem {
	const w = Math.max(1, Math.min(COLUMNS, Math.round(item.w)));
	const h = Math.max(1, Math.round(item.h));
	const x = Math.max(0, Math.min(COLUMNS - w, Math.round(item.x)));
	const y = Math.max(0, Math.round(item.y));
	return { ...item, x, y, w, h };
}

/** Row order, then column; `first` sorts before others on the same row. */
function sortItems(items: GridItem[], first?: string): GridItem[] {
	return [...items].sort((a, b) => {
		if (a.y !== b.y) return a.y - b.y;
		if (first) {
			if (a.id === first) return -1;
			if (b.id === first) return 1;
		}
		return a.x - b.x;
	});
}

/**
 * Float every item up as far as it goes without overlapping the ones already placed. Returns new
 * objects in the input order.
 */
export function compact(items: GridItem[], first?: string): GridItem[] {
	const placed: GridItem[] = [];
	const out = new Map<string, GridItem>();
	for (const original of sortItems(items.map(clampItem), first)) {
		const item = { ...original };
		while (item.y > 0 && !placed.some((other) => collides({ ...item, y: item.y - 1 }, other)))
			item.y--;
		let blocker = placed.find((other) => collides(item, other));
		while (blocker) {
			item.y = blocker.y + blocker.h;
			blocker = placed.find((other) => collides(item, other));
		}
		placed.push(item);
		out.set(item.id, item);
	}
	return items.map((item) => out.get(item.id)!);
}

/** Push everything that overlaps `moved` below it, cascading. */
function pushDown(items: GridItem[], moved: GridItem, depth = 0): void {
	if (depth > items.length) return;
	for (const other of sortItems(items)) {
		if (other.id !== moved.id && collides(moved, other)) {
			other.y = moved.y + moved.h;
			pushDown(items, other, depth + 1);
		}
	}
}

function place(items: GridItem[], id: string, change: (item: GridItem) => GridItem): GridItem[] {
	const next = items.map((item) => ({ ...item }));
	const index = next.findIndex((item) => item.id === id);
	if (index < 0) return compact(next);
	next[index] = clampItem(change(next[index]!));
	pushDown(next, next[index]!);
	return compact(next, id);
}

export function moveItem(items: GridItem[], id: string, x: number, y: number): GridItem[] {
	return place(items, id, (item) => ({ ...item, x, y }));
}

export function resizeItem(items: GridItem[], id: string, w: number, h: number): GridItem[] {
	return place(items, id, (item) => ({ ...item, w: Math.min(w, COLUMNS - item.x), h }));
}

/** Where a new panel of this size goes: the first gap in row order that fits, else the bottom. */
export function findSpot(items: GridItem[], w: number, h: number): { x: number; y: number } {
	const width = Math.min(COLUMNS, Math.max(1, w));
	const end = bottom(items);
	for (let y = 0; y <= end; y++) {
		for (let x = 0; x + width <= COLUMNS; x++) {
			const probe = { id: '\0probe', x, y, w: width, h };
			if (!items.some((item) => collides(probe, item))) {
				// Only accept gaps that are not below the current bottom row (that is the fallback).
				if (y < end) return { x, y };
			}
		}
	}
	return { x: 0, y: end };
}

/** Right of `beside` when it fits on the same rows, else the first free spot. */
export function spotBeside(items: GridItem[], beside: GridItem): { x: number; y: number } {
	const probe = { id: '\0probe', x: beside.x + beside.w, y: beside.y, w: beside.w, h: beside.h };
	if (probe.x + probe.w <= COLUMNS && !items.some((item) => collides(probe, item))) {
		return { x: probe.x, y: probe.y };
	}
	return { x: 0, y: bottom(items) };
}

/** Narrow screens: one column, in reading order. */
export function readingOrder<T extends { gridPos: { x: number; y: number } }>(panels: T[]): T[] {
	return [...panels].sort((a, b) => a.gridPos.y - b.gridPos.y || a.gridPos.x - b.gridPos.x);
}
