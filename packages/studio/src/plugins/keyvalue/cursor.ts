/**
 * Opaque browse cursors. A SCAN cursor alone is not enough: one `SCAN … COUNT 500` call can
 * return more keys than the page needs (the spike saw 501 for COUNT 500), and re-issuing the same
 * scan cursor is not guaranteed to return the same batch once the keyspace changes. So the
 * cursor carries the next scan cursor plus the keys (or fields/members) already scanned but not
 * yet shown. It is base64url JSON, tagged with its shape so a cursor from one object kind is
 * refused by another.
 */
import { StudioError } from '../../protocol.ts';

export type BrowseCursor =
	/** SCAN/HSCAN/SSCAN/ZSCAN: next scan cursor (`null` once it reached 0) and unshown items. */
	| { k: 'scan'; c: string | null; o: string[] }
	/** LRANGE: the next index. */
	| { k: 'list'; i: number }
	/** XRANGE: the last id shown; the next page starts after it. */
	| { k: 'stream'; x: string };

/** The protocol caps cursors at 8,192 characters; stay clearly under it. */
export const MAX_CURSOR_CHARS = 7_000;

export function encodeCursor(cursor: BrowseCursor): string {
	return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor<K extends BrowseCursor['k']>(text: string, kind: K): Extract<BrowseCursor, { k: K }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
	} catch {
		throw invalid();
	}
	if (typeof parsed !== 'object' || parsed === null || (parsed as { k?: unknown }).k !== kind) throw invalid();
	const value = parsed as Record<string, unknown>;
	switch (kind) {
		case 'scan': {
			const { c, o } = value;
			if (!(c === null || (typeof c === 'string' && /^\d{1,20}$/.test(c)))) throw invalid();
			if (!Array.isArray(o) || !o.every((item) => typeof item === 'string')) throw invalid();
			return { k: 'scan', c, o } as Extract<BrowseCursor, { k: K }>;
		}
		case 'list': {
			const { i } = value;
			if (typeof i !== 'number' || !Number.isSafeInteger(i) || i < 0) throw invalid();
			return { k: 'list', i } as Extract<BrowseCursor, { k: K }>;
		}
		case 'stream': {
			const { x } = value;
			if (typeof x !== 'string' || !/^\d{1,20}-\d{1,20}$/.test(x)) throw invalid();
			return { k: 'stream', x } as Extract<BrowseCursor, { k: K }>;
		}
		default:
			throw invalid();
	}
}

function invalid(): StudioError {
	return new StudioError('bad_request', 'The browse cursor is not valid for this object.');
}
