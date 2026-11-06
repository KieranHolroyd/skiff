import { describe, expect, test } from 'bun:test';
import {
	collides,
	compact,
	findSpot,
	moveItem,
	resizeItem,
	spotBeside,
	type GridItem
} from './grid.ts';

const item = (id: string, x: number, y: number, w: number, h: number): GridItem => ({
	id,
	x,
	y,
	w,
	h
});
const byId = (items: GridItem[]) => Object.fromEntries(items.map((entry) => [entry.id, entry]));

describe('collides', () => {
	test('edges touching is not a collision', () => {
		expect(collides(item('a', 0, 0, 12, 4), item('b', 12, 0, 12, 4))).toBe(false);
		expect(collides(item('a', 0, 0, 12, 4), item('b', 0, 4, 12, 4))).toBe(false);
		expect(collides(item('a', 0, 0, 12, 4), item('b', 11, 3, 2, 2))).toBe(true);
	});
});

describe('compact', () => {
	test('floats items up into gaps and keeps input order', () => {
		const out = compact([item('b', 0, 10, 12, 4), item('a', 12, 3, 12, 4)]);
		expect(out.map((entry) => entry.id)).toEqual(['b', 'a']);
		expect(byId(out).b).toMatchObject({ y: 0 });
		expect(byId(out).a).toMatchObject({ y: 0 });
	});

	test('stacks overlapping items', () => {
		const out = byId(
			compact([item('a', 0, 0, 24, 4), item('b', 0, 1, 12, 3), item('c', 0, 20, 12, 2)])
		);
		expect(out.a!.y).toBe(0);
		expect(out.b!.y).toBe(4);
		expect(out.c!.y).toBe(7);
	});

	test('clamps width and x to the grid', () => {
		const [out] = compact([item('a', 20, 0, 12, 4)]);
		expect(out).toMatchObject({ x: 12, w: 12 });
	});
});

describe('moveItem', () => {
	const layout = [item('a', 0, 0, 12, 4), item('b', 12, 0, 12, 4), item('c', 0, 4, 24, 4)];

	test('moving onto another pushes it down', () => {
		const out = byId(moveItem(layout, 'c', 0, 0));
		expect(out.c).toMatchObject({ x: 0, y: 0 });
		expect(out.a!.y).toBe(4);
		expect(out.b!.y).toBe(4);
	});

	test('swapping across columns', () => {
		const out = byId(moveItem(layout, 'a', 12, 0));
		expect(out.a).toMatchObject({ x: 12, y: 0 });
		expect(out.b).toMatchObject({ x: 12, y: 4 });
		// c floats up into the space a left only as far as b allows (full width).
		expect(out.c!.y).toBe(8);
	});

	test('dragging into empty space below floats back up', () => {
		const out = byId(moveItem([item('a', 0, 0, 12, 4)], 'a', 0, 30));
		expect(out.a!.y).toBe(0);
	});

	test('no overlaps after any move', () => {
		const out = moveItem(layout, 'b', 6, 2);
		for (const one of out) for (const two of out) expect(collides(one, two)).toBe(false);
	});
});

describe('resizeItem', () => {
	test('growing pushes neighbours below', () => {
		const out = byId(resizeItem([item('a', 0, 0, 12, 4), item('b', 12, 0, 12, 4)], 'a', 24, 6));
		expect(out.a).toMatchObject({ w: 24, h: 6 });
		expect(out.b!.y).toBe(6);
	});

	test('width is capped at the right edge', () => {
		const out = byId(resizeItem([item('a', 12, 0, 6, 4)], 'a', 20, 4));
		expect(out.a!.w).toBe(12);
	});
});

describe('spots', () => {
	test('findSpot uses a gap before the bottom', () => {
		expect(findSpot([item('a', 0, 0, 12, 8)], 12, 8)).toEqual({ x: 12, y: 0 });
		expect(findSpot([item('a', 0, 0, 24, 8)], 12, 8)).toEqual({ x: 0, y: 8 });
		expect(findSpot([], 12, 8)).toEqual({ x: 0, y: 0 });
	});

	test('spotBeside', () => {
		const a = item('a', 0, 0, 12, 8);
		expect(spotBeside([a], a)).toEqual({ x: 12, y: 0 });
		expect(spotBeside([a, item('b', 12, 0, 12, 8)], a)).toEqual({ x: 0, y: 8 });
	});
});
