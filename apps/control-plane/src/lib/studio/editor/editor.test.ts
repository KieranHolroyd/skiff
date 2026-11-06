import { describe, expect, test } from 'bun:test';
import { jsonCursor, monacoLanguage, REDIS_LANGUAGE } from './monaco.ts';
import { absolutePosition, utf16Offset } from './positions.ts';
import { oklchToHex } from './theme.ts';

describe('monacoLanguage', () => {
	test('maps studio languages to Monaco ids', () => {
		expect(monacoLanguage('sql', 'postgres')).toBe('pgsql');
		expect(monacoLanguage('sql', 'mysql')).toBe('mysql');
		expect(monacoLanguage('sql', 'mariadb')).toBe('mysql');
		expect(monacoLanguage('sql')).toBe('pgsql');
		expect(monacoLanguage('mongo')).toBe('json');
		expect(monacoLanguage('redis')).toBe(REDIS_LANGUAGE);
	});
});

describe('jsonCursor', () => {
	test('tells string values from keys and the outside', () => {
		expect(jsonCursor('{"find": "')).toBe('value');
		expect(jsonCursor('{"find":"ord')).toBe('value');
		expect(jsonCursor('{"fi')).toBe('key');
		expect(jsonCursor('{"find": "orders", "')).toBe('key');
		expect(jsonCursor('{"find": "orders"')).toBe('outside');
		expect(jsonCursor('{"a": "x\\"y')).toBe('value');
		expect(jsonCursor('')).toBe('outside');
	});
});

describe('positions', () => {
	test('code point offsets become UTF-16 offsets', () => {
		expect(utf16Offset('select 1', 1)).toBe(0);
		expect(utf16Offset('select 1', 8)).toBe(7);
		// 😀 is two UTF-16 units: the 3rd code point starts at unit 3.
		expect(utf16Offset('😀 x', 3)).toBe(3);
		expect(utf16Offset('abc', 99)).toBe(3);
		expect(utf16Offset('abc', 0)).toBe(0);
	});

	test('a position inside a selection maps onto the whole input', () => {
		const value = 'select 1;\nselect 😀, nope;';
		const offset = value.indexOf('select 😀');
		const target = { text: 'select 😀, nope;', offset };
		// `nope` is code point 11 of the selection.
		const position = absolutePosition(value, target, 11);
		expect(Array.from(value).slice(position - 1, position + 3).join('')).toBe('nope');
		expect(absolutePosition(value, { text: value, offset: 0 }, 1)).toBe(1);
	});
});

describe('theme', () => {
	test('converts OKLCH tokens to hex', () => {
		expect(oklchToHex('oklch(1 0 0)')).toBe('#ffffff');
		expect(oklchToHex('oklch(0 0 0 / 50%)')).toBe('#00000080');
		expect(oklchToHex('#123456')).toBeNull();
	});
});
