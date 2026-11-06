/**
 * A cursor stack for keyset/opaque paging (MongoDB `browse`): the protocol only gives the next
 * page's cursor, so going back means remembering the cursors that led here.
 */
export interface PagerState {
	/** Cursors of the pages before the current one; `undefined` is the first page. */
	stack: Array<string | undefined>;
	/** The current page's cursor (`undefined` on the first page). */
	cursor: string | undefined;
}

export function firstPage(): PagerState {
	return { stack: [], cursor: undefined };
}

export function nextPage(state: PagerState, next: string): PagerState {
	return { stack: [...state.stack, state.cursor], cursor: next };
}

export function previousPage(state: PagerState): PagerState {
	if (state.stack.length === 0) return state;
	return { stack: state.stack.slice(0, -1), cursor: state.stack.at(-1) };
}

export function pageNumber(state: PagerState): number {
	return state.stack.length + 1;
}

/** 1-based row range of the current page (every page before it was full). */
export function pageRange(state: PagerState, pageSize: number, rows: number): { from: number; to: number } {
	const from = (pageNumber(state) - 1) * pageSize + 1;
	return rows === 0 ? { from: 0, to: 0 } : { from, to: from + rows - 1 };
}

const count = new Intl.NumberFormat('en-GB');

/** "Rows 101–200 of about 12,345" / "Rows 1–37". */
export function pageLabel(state: PagerState, pageSize: number, rows: number, estimate?: number): string {
	const { from, to } = pageRange(state, pageSize, rows);
	const range = rows === 0 ? 'No rows' : `Rows ${count.format(from)}–${count.format(to)}`;
	return estimate === undefined ? range : `${range} of about ${count.format(estimate)}`;
}
