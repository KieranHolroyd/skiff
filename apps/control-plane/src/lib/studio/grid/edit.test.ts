import { describe, expect, test } from 'bun:test';
import type { Cell, CellKind, Column } from '@yoal/studio/protocol';
import { editInitial, editorFor, parseEdit } from './edit.ts';

const col = (kind: CellKind, extra: Partial<Column> = {}): Column => ({
	name: 'c',
	nativeType: kind,
	kind,
	...extra
});

describe('editorFor', () => {
	test('picks an editor per kind, with the tag winning over the kind', () => {
		expect(editorFor(col('text'), 'a')).toEqual({ ok: true, editor: 'text' });
		expect(editorFor(col('number'), 1)).toEqual({ ok: true, editor: 'number' });
		expect(editorFor(col('boolean'), true)).toEqual({ ok: true, editor: 'boolean' });
		expect(editorFor(col('datetime'), null)).toEqual({ ok: true, editor: 'datetime' });
		expect(editorFor(col('json'), null)).toEqual({ ok: true, editor: 'json' });
		expect(editorFor(col('unknown'), { $t: 'json', v: {} })).toEqual({ ok: true, editor: 'json' });
		expect(editorFor(col('text'), { $t: 'decimal', v: '1.5' })).toEqual({ ok: true, editor: 'number' });
	});

	test('blocks truncated previews and generated columns', () => {
		const truncated = editorFor(col('text'), { $t: 'truncated', v: 'abc', bytes: 99_999 });
		expect(truncated.ok).toBe(false);
		expect(editorFor(col('text', { editable: false }), 'a').ok).toBe(false);
	});

	test('starts JSON editors pretty-printed and NULL empty', () => {
		expect(editInitial(col('json'), { $t: 'json', v: { a: 1 } }, 'json')).toBe('{\n  "a": 1\n}');
		expect(editInitial(col('text'), null, 'text')).toBe('');
		expect(editInitial(col('bigint'), { $t: 'bigint', v: '9007199254740993' }, 'number')).toBe(
			'9007199254740993'
		);
		expect(editInitial(col('boolean'), null, 'boolean')).toBe(false);
	});
});

describe('parseEdit keeps tags', () => {
	const big: Cell = { $t: 'bigint', v: '9007199254740993' };

	test('bigint: a tagged original stays tagged even when the new value is small', () => {
		expect(parseEdit(col('bigint'), big, '12')).toEqual({ ok: true, value: { $t: 'bigint', v: '12' } });
		expect(parseEdit(col('bigint'), big, ' +0042 ')).toEqual({ ok: true, value: { $t: 'bigint', v: '42' } });
	});

	test('bigint: a plain original follows the wire rule (safe → number, else tagged)', () => {
		expect(parseEdit(col('bigint'), 5, '7')).toEqual({ ok: true, value: 7 });
		expect(parseEdit(col('bigint'), null, '9007199254740993')).toEqual({ ok: true, value: big });
		expect(parseEdit(col('bigint'), 5, '1.5').ok).toBe(false);
	});

	test('decimal stays a lossless string', () => {
		expect(parseEdit(col('decimal'), { $t: 'decimal', v: '1.10' }, '3.14159265358979323846')).toEqual({
			ok: true,
			value: { $t: 'decimal', v: '3.14159265358979323846' }
		});
		expect(parseEdit(col('decimal'), null, '2')).toEqual({ ok: true, value: { $t: 'decimal', v: '2' } });
		expect(parseEdit(col('decimal'), null, 'abc').ok).toBe(false);
	});

	test('dates and datetimes keep their tag and are validated', () => {
		expect(parseEdit(col('date'), { $t: 'date', v: '2026-01-01' }, '2026-11-06')).toEqual({
			ok: true,
			value: { $t: 'date', v: '2026-11-06' }
		});
		expect(parseEdit(col('date'), { $t: 'date', v: '2026-01-01' }, '6 Nov').ok).toBe(false);
		expect(
			parseEdit(col('datetime'), { $t: 'datetime', v: '2026-01-01T00:00:00.000Z' }, '2026-11-06T09:30:00Z')
		).toEqual({ ok: true, value: { $t: 'datetime', v: '2026-11-06T09:30:00Z' } });
		expect(parseEdit(col('datetime'), null, 'not a date').ok).toBe(false);
		// An untagged string (e.g. a MySQL zero date) stays untagged.
		expect(parseEdit(col('datetime'), '0000-00-00 00:00:00', '2026-11-06 09:30:00')).toEqual({
			ok: true,
			value: '2026-11-06 09:30:00'
		});
	});

	test('json and ejson keep their tag and must parse', () => {
		expect(parseEdit(col('json'), { $t: 'json', v: 1 }, '{"a":[1,2]}')).toEqual({
			ok: true,
			value: { $t: 'json', v: { a: [1, 2] } }
		});
		expect(parseEdit(col('document'), null, '{"$oid":"6553"}')).toEqual({
			ok: true,
			value: { $t: 'ejson', v: { $oid: '6553' } }
		});
		expect(parseEdit(col('unknown'), { $t: 'ejson', v: {} }, '{"x":1}')).toEqual({
			ok: true,
			value: { $t: 'ejson', v: { x: 1 } }
		});
		expect(parseEdit(col('json'), null, '{oops').ok).toBe(false);
	});

	test('bytes stay base64 under their tag', () => {
		expect(parseEdit(col('bytes'), { $t: 'bytes', v: 'AA==' }, 'AQID')).toEqual({
			ok: true,
			value: { $t: 'bytes', v: 'AQID' }
		});
		expect(parseEdit(col('bytes'), { $t: 'bytes', v: 'AA==' }, 'not base64!').ok).toBe(false);
	});

	test('arrays must be arrays of cells', () => {
		expect(parseEdit(col('array'), [1, 2], '[3, "a", null]')).toEqual({ ok: true, value: [3, 'a', null] });
		expect(parseEdit(col('array'), [1], '{"a":1}').ok).toBe(false);
		expect(parseEdit(col('array'), [1], '[{"a":1}]').ok).toBe(false);
		expect(parseEdit(col('array'), [1], '[{"$t":"json","v":{"a":1}}]').ok).toBe(true);
	});

	test('plain kinds', () => {
		expect(parseEdit(col('number'), 1, '2.5')).toEqual({ ok: true, value: 2.5 });
		expect(parseEdit(col('number'), 1, '').ok).toBe(false);
		expect(parseEdit(col('number'), 1, 'NaN').ok).toBe(false);
		expect(parseEdit(col('boolean'), true, false)).toEqual({ ok: true, value: false });
		expect(parseEdit(col('text'), 'a', '')).toEqual({ ok: true, value: '' });
		expect(parseEdit(col('uuid'), null, 'x')).toEqual({ ok: true, value: 'x' });
	});

	test('refuses truncated previews', () => {
		expect(parseEdit(col('text'), { $t: 'truncated', v: 'a', bytes: 70_000 }, 'b').ok).toBe(false);
	});
});
