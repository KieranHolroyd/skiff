import { describe, expect, test } from 'bun:test';
import type { Column } from '@skiff/studio/protocol';
import {
	cellClipboardText,
	cellPretty,
	cellsEqual,
	cellView,
	isCell,
	rowJson,
	truncatedSuffix
} from './cells.ts';

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
		expect(cellView({ $t: 'json', v: { a: 1 } })).toEqual({ kind: 'tagged', tag: 'json', text: '{"a":1}' });
	});

	test('carries the full size of a truncated cell', () => {
		expect(cellView({ $t: 'truncated', v: 'abc', bytes: 12_345 })).toEqual({
			kind: 'truncated',
			text: 'abc',
			bytes: 12_345
		});
		expect(truncatedSuffix(12_345)).toBe('… 12,345 bytes');
		expect(truncatedSuffix(null)).toBe('…');
	});
});

describe('copy and inspect', () => {
	const json: Column = { name: 'j', nativeType: 'jsonb', kind: 'json' };

	test('copies the bare value', () => {
		expect(cellClipboardText(null)).toBe('');
		expect(cellClipboardText(1.5)).toBe('1.5');
		expect(cellClipboardText({ $t: 'bigint', v: '12' })).toBe('12');
		expect(cellClipboardText({ $t: 'json', v: { a: 1 } })).toBe('{"a":1}');
	});

	test('pretty-prints JSON documents', () => {
		expect(cellPretty({ $t: 'json', v: { a: 1 } }, json)).toBe('{\n  "a": 1\n}');
		expect(cellPretty('{"a":1}', json)).toBe('{\n  "a": 1\n}');
		expect(cellPretty(null)).toBe('NULL');
	});

	test('copies a row as JSON with tags dropped', () => {
		const columns: Column[] = [
			{ name: 'id', nativeType: 'bigint', kind: 'bigint' },
			{ name: 'j', nativeType: 'jsonb', kind: 'json' }
		];
		expect(JSON.parse(rowJson(columns, [{ $t: 'bigint', v: '9' }, { $t: 'json', v: [1] }]))).toEqual({
			id: '9',
			j: [1]
		});
	});
});

describe('cellsEqual and isCell', () => {
	test('compares tagged cells structurally, key order aside', () => {
		expect(cellsEqual({ $t: 'json', v: { a: 1, b: 2 } }, { $t: 'json', v: { b: 2, a: 1 } })).toBe(true);
		expect(cellsEqual({ $t: 'json', v: 1 }, { $t: 'ejson', v: 1 })).toBe(false);
		expect(cellsEqual(1, '1')).toBe(false);
		expect(cellsEqual(null, null)).toBe(true);
	});

	test('objects must be tagged', () => {
		expect(isCell([1, { $t: 'json', v: {} }])).toBe(true);
		expect(isCell({ a: 1 })).toBe(false);
		expect(isCell(Number.NaN)).toBe(false);
	});
});
