import { describe, expect, test } from 'bun:test';
import { cellView, truncatedSuffix } from './cells.ts';

describe('cellView', () => {
	test('shows plain JSON values as text', () => {
		expect(cellView(null)).toEqual({ kind: 'null' });
		expect(cellView(42)).toEqual({ kind: 'plain', text: '42' });
		expect(cellView(false)).toEqual({ kind: 'plain', text: 'false' });
		expect(cellView('hi')).toEqual({ kind: 'plain', text: 'hi' });
		expect(cellView([1, 'a'])).toEqual({ kind: 'plain', text: '[1,"a"]' });
	});

	test('keeps the tag of a tagged cell', () => {
		expect(cellView({ $t: 'bigint', v: '9007199254740993' })).toEqual({
			kind: 'tagged',
			tag: 'bigint',
			text: '9007199254740993'
		});
		expect(cellView({ $t: 'json', v: { a: 1 } })).toEqual({
			kind: 'tagged',
			tag: 'json',
			text: '{"a":1}'
		});
	});

	test('carries the full size of a truncated cell', () => {
		expect(cellView({ $t: 'truncated', v: 'abc', bytes: 12_345 })).toEqual({
			kind: 'truncated',
			text: 'abc',
			bytes: 12_345
		});
		expect(truncatedSuffix(12_345)).toBe('… (12,345 bytes)');
		expect(truncatedSuffix(null)).toBe('…');
	});
});
