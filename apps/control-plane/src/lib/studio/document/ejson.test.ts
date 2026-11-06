import { describe, expect, test } from 'bun:test';
import type { Cell, Column } from '@skiff/studio/protocol';
import {
	cellToCanonical,
	cellToDisplay,
	displayToCell,
	documentDelete,
	documentInsert,
	documentPreview,
	documentUpdate,
	formatDocument,
	idLabel,
	jsonErrorPosition,
	parseFilter,
	parseJsonDocument,
	rowToDocument,
	simplify,
	truncatedFields,
	withFields,
} from './ejson.ts';

const oid = { $t: 'ejson', v: { $oid: '65f0a1b2c3d4e5f601234567' } } as const;
const col = (name: string, kind: Column['kind'] = 'text'): Column => ({ name, nativeType: kind, kind });
const columns = [col('_id', 'objectid'), col('name'), col('age', 'number'), col('price', 'number'), col('tags', 'document'), col('nick')];
const row: Cell[] = [
	oid,
	'Ada',
	36,
	{ $t: 'ejson', v: { $numberDouble: '9.5' } },
	{ $t: 'ejson', v: [{ $numberInt: '1' }, 'x'] },
	null,
];

describe('display EJSON', () => {
	test('cells map to canonical EJSON', () => {
		expect(cellToCanonical(36)).toEqual({ $numberInt: '36' });
		expect(cellToCanonical(1.5)).toEqual({ $numberDouble: '1.5' });
		expect(cellToCanonical('a')).toBe('a');
		expect(cellToCanonical(null)).toBe(null);
		expect(cellToCanonical({ $t: 'truncated', v: 'abc', bytes: 99 })).toBeUndefined();
	});

	test('simplify keeps every value lossless under a canonical parse', () => {
		expect(simplify({ $numberInt: '5' })).toBe(5);
		expect(simplify({ $numberDouble: '5.25' })).toBe(5.25);
		// An integral double would read back as an Int32.
		expect(simplify({ $numberDouble: '5.0' })).toEqual({ $numberDouble: '5.0' });
		expect(simplify({ $numberDouble: 'Infinity' })).toEqual({ $numberDouble: 'Infinity' });
		expect(simplify({ $numberLong: '9007199254740993' })).toEqual({ $numberLong: '9007199254740993' });
		expect(simplify({ $date: { $numberLong: '0' } })).toEqual({ $date: '1970-01-01T00:00:00.000Z' });
		expect(simplify({ $date: { $numberLong: '-1000' } })).toEqual({ $date: { $numberLong: '-1000' } });
		expect(simplify({ a: [{ $numberInt: '1' }, { b: { $numberInt: '2' } }] })).toEqual({ a: [1, { b: 2 }] });
	});

	test('displayToCell keeps Int32 plain and tags everything else as EJSON', () => {
		expect(displayToCell(5)).toBe(5);
		expect(displayToCell('x')).toBe('x');
		expect(displayToCell(null)).toBe(null);
		expect(displayToCell(true)).toBe(true);
		expect(displayToCell(2.5)).toEqual({ $t: 'ejson', v: 2.5 });
		expect(displayToCell(3_000_000_000)).toEqual({ $t: 'ejson', v: 3_000_000_000 });
		expect(displayToCell({ $oid: 'x' })).toEqual({ $t: 'ejson', v: { $oid: 'x' } });
		expect(displayToCell([1])).toEqual({ $t: 'ejson', v: [1] });
	});

	test('cellToDisplay for a typical row', () => {
		expect(cellToDisplay(row[3]!)).toBe(9.5);
		expect(cellToDisplay(row[4]!)).toEqual([1, 'x']);
	});
});

describe('documents', () => {
	const doc = rowToDocument(columns, row);

	test('rowToDocument drops null fields but keeps _id', () => {
		expect(doc.id).toEqual(oid);
		expect(doc.fields.map(([name]) => name)).toEqual(['_id', 'name', 'age', 'price', 'tags']);
	});

	test('formatDocument pretty-prints display EJSON', () => {
		expect(JSON.parse(formatDocument(doc))).toEqual({
			_id: { $oid: '65f0a1b2c3d4e5f601234567' },
			name: 'Ada',
			age: 36,
			price: 9.5,
			tags: [1, 'x'],
		});
		expect(documentPreview(doc, 20)).toHaveLength(20);
		expect(idLabel(doc.id)).toBe('65f0a1b2c3d4e5f601234567');
		expect(idLabel(7)).toBe('7');
	});

	test('an unchanged document makes no change', () => {
		expect(documentUpdate(doc, formatDocument(doc))).toEqual({ ok: true, change: null });
	});

	test('changed and added fields become one $set update with originals', () => {
		const edited = JSON.parse(formatDocument(doc));
		edited.age = 37;
		edited.price = 10.25;
		edited.nick = 'ada';
		const result = documentUpdate(doc, JSON.stringify(edited));
		expect(result).toEqual({
			ok: true,
			change: {
				op: 'update',
				key: { _id: oid },
				values: { age: 37, price: { $t: 'ejson', v: 10.25 }, nick: 'ada' },
				original: { age: 36, price: { $t: 'ejson', v: { $numberDouble: '9.5' } }, nick: null },
			},
		});
	});

	test('removing a field is refused with advice', () => {
		const edited = JSON.parse(formatDocument(doc));
		delete edited.tags;
		const result = documentUpdate(doc, JSON.stringify(edited));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("Removing fields isn't supported");
	});

	test('changing _id, operators and dotted names are refused', () => {
		const edited = JSON.parse(formatDocument(doc));
		expect(documentUpdate(doc, JSON.stringify({ ...edited, _id: 1 })).ok).toBe(false);
		expect(documentUpdate(doc, JSON.stringify({ ...edited, $set: { a: 1 } })).ok).toBe(false);
		expect(documentUpdate(doc, JSON.stringify({ ...edited, 'a.b': 1 })).ok).toBe(false);
		// Leaving _id out of the edit is fine.
		const { _id, ...rest } = edited;
		expect(documentUpdate(doc, JSON.stringify({ ...rest, age: 1 })).ok).toBe(true);
	});

	test('truncated fields must be loaded before editing', () => {
		const big = rowToDocument(columns, [oid, { $t: 'truncated', v: 'Ad', bytes: 70_000 }, 1, null, null, null]);
		expect(truncatedFields(big)).toEqual(['name']);
		expect(documentUpdate(big, '{}').ok).toBe(false);
		const loaded = withFields(big, { name: 'Ada Lovelace' });
		expect(truncatedFields(loaded)).toEqual([]);
		expect(documentDelete(big)).toEqual({ op: 'delete', key: { _id: oid }, original: { age: 1 } });
	});

	test('insert takes any document, with or without _id', () => {
		expect(documentInsert('{}')).toEqual({ ok: true, change: { op: 'insert', values: {} } });
		expect(documentInsert('{"_id":{"$oid":"x"},"n":1.5}')).toEqual({
			ok: true,
			change: { op: 'insert', values: { _id: { $t: 'ejson', v: { $oid: 'x' } }, n: { $t: 'ejson', v: 1.5 } } },
		});
		expect(documentInsert('[1]').ok).toBe(false);
	});

	test('delete is guarded by the loaded fields', () => {
		expect(documentDelete(doc)).toEqual({
			op: 'delete',
			key: { _id: oid },
			original: { name: 'Ada', age: 36, price: row[3]!, tags: row[4]! },
		});
	});
});

describe('parsing', () => {
	test('filters: empty means none, objects only', () => {
		expect(parseFilter('  ')).toEqual({ ok: true, native: undefined });
		expect(parseFilter('{}')).toEqual({ ok: true, native: undefined });
		expect(parseFilter(' {"a": 1} ')).toEqual({ ok: true, native: '{"a": 1}' });
		expect(parseFilter('[1]').ok).toBe(false);
		const bad = parseFilter('{_id: ObjectId("x")}');
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('Extended JSON');
	});

	test('error positions from either engine message style', () => {
		expect(jsonErrorPosition('Unexpected token } in JSON at position 4', '{"a"}')).toBe(5);
		expect(jsonErrorPosition('Expected property name (line 2 column 3)', '{\n  x}')).toBe(5);
		expect(jsonErrorPosition('JSON Parse error: Unexpected identifier', '')).toBeUndefined();
		expect(parseJsonDocument('"x"').ok).toBe(false);
	});
});
