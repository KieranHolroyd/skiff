/**
 * Engines report error positions as 1-based character (code point) offsets; JavaScript strings
 * and Monaco's `getPositionAt` count UTF-16 units. Convert so a marker after an emoji still lands
 * on the right token. Out-of-range offsets clamp to the text.
 */
export function utf16Offset(text: string, position: number): number {
	const target = Math.max(0, Math.floor(position) - 1);
	let units = 0;
	let points = 0;
	while (points < target && units < text.length) {
		const code = text.charCodeAt(units);
		units += code >= 0xd800 && code <= 0xdbff && units + 1 < text.length ? 2 : 1;
		points++;
	}
	return Math.min(units, text.length);
}

/**
 * The text a run sends and where it starts in the whole input: the selection when it has
 * non-blank text, else everything. `offset` is in UTF-16 units into `value`.
 */
export interface RunTarget {
	text: string;
	offset: number;
}

/** Shift an engine position inside `target` to a position inside the whole input. */
export function absolutePosition(value: string, target: RunTarget, position: number): number {
	const inTarget = utf16Offset(target.text, position);
	// Back to a code point count over the whole value, as markers expect.
	return Array.from(value.slice(0, target.offset + inTarget)).length + 1;
}
