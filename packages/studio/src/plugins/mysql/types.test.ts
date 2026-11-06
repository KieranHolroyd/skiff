import { describe, expect, test } from 'bun:test';
import { BINARY_CHARSET, encodeCell, FieldType, fieldMapping, jsonCheckColumn, schemaKind } from './types.ts';

const UTF8MB4 = 255;

describe('fieldMapping (result sets)', () => {
	const kind = (columnType: number, extra: Record<string, unknown> = {}) =>
		fieldMapping({ name: 'c', columnType, characterSet: BINARY_CHARSET, ...extra }).kind;

	test('numbers, bigints and decimals', () => {
		expect(kind(FieldType.LONG)).toBe('number');
		expect(kind(FieldType.TINY, { columnLength: 1 })).toBe('number'); // TINYINT(1) stays a number
		expect(kind(FieldType.DOUBLE)).toBe('number');
		expect(kind(FieldType.LONGLONG)).toBe('bigint');
		expect(kind(FieldType.NEWDECIMAL)).toBe('decimal');
		expect(fieldMapping({ name: 'c', columnType: FieldType.LONGLONG, flags: 32 }).nativeType).toBe('bigint unsigned');
	});
	test('temporal types', () => {
		expect(kind(FieldType.DATE)).toBe('date');
		expect(kind(FieldType.DATETIME)).toBe('datetime');
		expect(kind(FieldType.TIMESTAMP)).toBe('datetime');
		expect(kind(FieldType.TIME)).toBe('time');
	});
	test('binary charset separates bytes from text', () => {
		expect(kind(FieldType.BLOB)).toBe('bytes');
		expect(kind(FieldType.VAR_STRING)).toBe('bytes');
		expect(kind(FieldType.STRING)).toBe('bytes');
		expect(kind(FieldType.BLOB, { characterSet: UTF8MB4 })).toBe('text');
		expect(kind(FieldType.VAR_STRING, { characterSet: UTF8MB4 })).toBe('text');
	});
	test('JSON: MySQL type 245, MariaDB extended metadata on LONGTEXT', () => {
		expect(kind(FieldType.JSON)).toBe('json');
		expect(kind(FieldType.BLOB, { characterSet: UTF8MB4, extendedFormat: 'json' })).toBe('json');
		expect(kind(FieldType.BLOB, { characterSet: UTF8MB4, extendedTypeName: 'uuid' })).toBe('uuid');
	});
	test('BIT is a number up to 48 bits, bytes beyond', () => {
		expect(kind(FieldType.BIT, { columnLength: 3 })).toBe('number');
		expect(kind(FieldType.BIT, { columnLength: 64 })).toBe('bytes');
	});
	test('ENUM and SET arrive as STRING with a flag', () => {
		expect(kind(FieldType.STRING, { characterSet: UTF8MB4, flags: 256 })).toBe('enum');
		expect(fieldMapping({ name: 'c', columnType: FieldType.STRING, characterSet: UTF8MB4, flags: 2048 }).nativeType).toBe('set');
	});
});

describe('schemaKind (describe)', () => {
	test('maps information_schema types', () => {
		expect(schemaKind('int', 'int')).toBe('number');
		expect(schemaKind('tinyint', 'tinyint(1)')).toBe('number');
		expect(schemaKind('bigint', 'bigint unsigned')).toBe('bigint');
		expect(schemaKind('decimal', 'decimal(12,2)')).toBe('decimal');
		expect(schemaKind('varbinary', 'varbinary(64)')).toBe('bytes');
		expect(schemaKind('json', 'json')).toBe('json');
		expect(schemaKind('datetime', 'datetime(3)')).toBe('datetime');
		expect(schemaKind('date', 'date')).toBe('date');
		expect(schemaKind('varchar', 'varchar(100)')).toBe('text');
		expect(schemaKind('enum', "enum('a','b')")).toBe('enum');
		expect(schemaKind('bit', 'bit(1)')).toBe('number');
		expect(schemaKind('bit', 'bit(64)')).toBe('bytes');
		expect(schemaKind('uuid', 'uuid')).toBe('uuid');
	});
	test('MariaDB LONGTEXT with a json_valid CHECK is json', () => {
		expect(schemaKind('longtext', 'longtext', true)).toBe('json');
		expect(schemaKind('longtext', 'longtext')).toBe('text');
	});
	test('jsonCheckColumn reads the json_valid clause', () => {
		expect(jsonCheckColumn('json_valid(`meta`)')).toBe('meta');
		expect(jsonCheckColumn('json_valid(`we``ird`)')).toBe('we`ird');
		expect(jsonCheckColumn('`a` > 0')).toBeNull();
		expect(jsonCheckColumn('json_valid(`a`) and `b` > 0')).toBeNull();
	});
});

describe('encodeCell', () => {
	test('BIGINT beyond 2^53 stays exact, small ones become numbers', () => {
		expect(encodeCell('bigint', '9007199254740993')).toEqual({ $t: 'bigint', v: '9007199254740993' });
		expect(encodeCell('bigint', '18446744073709551615')).toEqual({ $t: 'bigint', v: '18446744073709551615' });
		expect(encodeCell('bigint', '42')).toBe(42);
	});
	test('DECIMAL is always a tagged string', () => {
		expect(encodeCell('decimal', '123.45')).toEqual({ $t: 'decimal', v: '123.45' });
	});
	test('bytes, BIT and TINYINT(1)', () => {
		expect(encodeCell('bytes', Buffer.from([0, 255]))).toEqual({ $t: 'bytes', v: 'AP8=' });
		expect(encodeCell('number', Buffer.from([5]))).toBe(5);
		expect(encodeCell('bytes', Buffer.alloc(8, 0xff))).toEqual({ $t: 'bytes', v: '//////////8=' });
		expect(encodeCell('number', 1)).toBe(1);
	});
	test('temporal values keep the server text, including zero dates', () => {
		expect(encodeCell('datetime', '2026-01-02 03:04:05.678')).toEqual({ $t: 'datetime', v: '2026-01-02 03:04:05.678' });
		expect(encodeCell('datetime', '0000-00-00 00:00:00')).toEqual({ $t: 'datetime', v: '0000-00-00 00:00:00' });
		expect(encodeCell('date', '0000-00-00')).toEqual({ $t: 'date', v: '0000-00-00' });
		expect(encodeCell('time', '-12:00:01')).toBe('-12:00:01');
	});
	test('JSON text is parsed; invalid or huge JSON becomes text', () => {
		expect(encodeCell('json', '{"a": [1, 2]}')).toEqual({ $t: 'json', v: { a: [1, 2] } });
		expect(encodeCell('json', 'not json')).toBe('not json');
		const huge = JSON.stringify({ s: 'x'.repeat(70_000) });
		const cell = encodeCell('json', huge);
		expect(cell).toMatchObject({ $t: 'truncated', bytes: huge.length });
		expect(encodeCell('json', huge, Number.POSITIVE_INFINITY)).toEqual({ $t: 'json', v: { s: 'x'.repeat(70_000) } });
	});
	test('text previews and NULL', () => {
		expect(encodeCell('text', 'hello')).toBe('hello');
		expect(encodeCell('text', 'x'.repeat(70_000))).toMatchObject({ $t: 'truncated', bytes: 70_000 });
		expect(encodeCell('text', null)).toBeNull();
		expect(encodeCell('unknown', 3.5)).toBe(3.5);
	});
});
