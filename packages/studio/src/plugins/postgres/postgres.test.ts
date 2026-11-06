import { describe, expect, test } from 'bun:test';
import { StudioError } from '../../protocol.ts';
import { inputPosition, parseExplain } from './index.ts';
import { isStreamable, splitStatements, transactionEffect } from './split.ts';
import {
	arrayLiteral,
	buildBrowse,
	buildFilters,
	decodeCursor,
	encodeCursor,
	keysetCondition,
	Params,
	quoteIdent,
	textParam,
	type ColumnMeta,
	type OrderItem,
	type TableMeta,
} from './sql.ts';
import { builtinType, decoderFor, kindForRow, normaliseTimestamp } from './types.ts';

const texts = (input: string) => splitStatements(input).map((s) => s.text);

describe('splitStatements', () => {
	test('splits on top-level semicolons and drops empty statements', () => {
		expect(texts('select 1; select 2;;  ; select 3')).toEqual(['select 1', 'select 2', 'select 3']);
		expect(texts('  ;  -- only a comment\n; /* and another */ ')).toEqual([]);
	});

	test('keeps semicolons inside strings and quoted identifiers', () => {
		expect(texts(`select 'a;b', 'it''s; fine'; select "we;ird""name" from t`)).toEqual([
			`select 'a;b', 'it''s; fine'`,
			`select "we;ird""name" from t`,
		]);
	});

	test("E'' strings honour backslash escapes; standard strings do not", () => {
		expect(texts(`select E'a\\';b'; select 2`)).toEqual([`select E'a\\';b'`, 'select 2']);
		expect(texts(`select e'\\\\'; select 2`)).toEqual([`select e'\\\\'`, 'select 2']);
		// standard_conforming_strings: the backslash is literal, so the string ends at the quote.
		expect(texts(`select 'a\\'; select 2`)).toEqual([`select 'a\\'`, 'select 2']);
		// A trailing e on an identifier does not start an E'' string.
		expect(texts(`select type'x;y'; select 2`)).toEqual([`select type'x;y'`, 'select 2']);
	});

	test('dollar quotes, with and without tags', () => {
		const fn = `create function f() returns int language plpgsql as $$ begin perform 1; return 2; end $$`;
		expect(texts(`${fn}; select 1`)).toEqual([fn, 'select 1']);
		const tagged = `do $body$ begin raise notice '$$;'; end $body$`;
		expect(texts(`${tagged};select 2`)).toEqual([tagged, 'select 2']);
		// $1 is a parameter and a$b$ is an identifier, neither opens a quote.
		expect(texts('select $1; select a$b$c from t; select 3')).toEqual(['select $1', 'select a$b$c from t', 'select 3']);
	});

	test('nested block comments and line comments', () => {
		expect(texts('select 1 /* outer /* inner; */ still; */; select 2 -- trailing; comment\n; select 3')).toEqual([
			'select 1 /* outer /* inner; */ still; */',
			'select 2 -- trailing; comment',
			'select 3',
		]);
	});

	test('semicolons inside parentheses (rule actions) do not split', () => {
		const rule = 'create rule r as on insert to t do also (insert into a values (1); insert into b values (2))';
		expect(texts(`${rule}; select 1`)).toEqual([rule, 'select 1']);
	});

	test('BEGIN ATOMIC function bodies stay whole, but BEGIN; does not swallow the rest', () => {
		const atomic = 'create or replace function f() returns int language sql begin atomic select 1; select case when true then 2 end; end';
		expect(texts(`${atomic}; select 9`)).toEqual([atomic, 'select 9']);
		expect(texts('begin; delete from t; commit')).toEqual(['begin', 'delete from t', 'commit']);
	});

	test('U& and prefixed literals', () => {
		expect(texts(`select U&'d\\0061t;a', x'1f', b'101', n'x;y'; select 2`)).toEqual([
			`select U&'d\\0061t;a', x'1f', b'101', n'x;y'`,
			'select 2',
		]);
	});

	test('reports offsets and lower-cased bare words', () => {
		const [first, second] = splitStatements('  SELECT "Name" FROM T;\n  /* c */ Update t SET a = 1');
		expect(first?.start).toBe(2);
		expect(first?.words).toEqual(['select', 'from', 't']);
		expect(second?.text).toBe('/* c */ Update t SET a = 1');
		expect(second?.words[0]).toBe('update');
	});

	test('an unterminated string runs to the end instead of splitting', () => {
		expect(texts(`select 'oops; delete from t`)).toEqual([`select 'oops; delete from t`]);
	});
});

describe('statement classification', () => {
	const one = (sql: string) => splitStatements(sql)[0] as NonNullable<ReturnType<typeof splitStatements>[0]>;
	test('streams plain reads only', () => {
		expect(isStreamable(one('select * from t'))).toBe(true);
		expect(isStreamable(one('with x as (select 1) select * from x'))).toBe(true);
		expect(isStreamable(one('values (1), (2)'))).toBe(true);
		expect(isStreamable(one('table t'))).toBe(true);
		expect(isStreamable(one('with d as (delete from t returning *) select * from d'))).toBe(false);
		expect(isStreamable(one('select * into t2 from t'))).toBe(false);
		expect(isStreamable(one('insert into t values (1)'))).toBe(false);
		expect(isStreamable(one('show search_path'))).toBe(false);
	});

	test('tracks transaction boundaries', () => {
		expect(transactionEffect(one('BEGIN'))).toBe('begin');
		expect(transactionEffect(one('start transaction read write'))).toBe('begin');
		expect(transactionEffect(one('commit'))).toBe('end');
		expect(transactionEffect(one('commit and chain'))).toBe('begin');
		expect(transactionEffect(one('commit and no chain'))).toBe('end');
		expect(transactionEffect(one('rollback'))).toBe('end');
		expect(transactionEffect(one('rollback to savepoint a'))).toBe(null);
		expect(transactionEffect(one('prepare transaction \'x\''))).toBe('end');
		expect(transactionEffect(one('select 1'))).toBe(null);
	});
});

describe('quoteIdent', () => {
	test('always quotes and doubles embedded quotes', () => {
		expect(quoteIdent('users')).toBe('"users"');
		expect(quoteIdent('Mixed Case')).toBe('"Mixed Case"');
		expect(quoteIdent('a"b')).toBe('"a""b"');
		expect(quoteIdent('x"; drop table t; --')).toBe('"x""; drop table t; --"');
	});
	test('refuses empty and NUL', () => {
		expect(() => quoteIdent('')).toThrow(StudioError);
		expect(() => quoteIdent('a\0b')).toThrow(StudioError);
	});
});

const col = (name: string, kind: ColumnMeta['kind'], castType: string, nullable = true, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
	name,
	kind,
	castType,
	typeOid: 0,
	nullable,
	...extra,
});

describe('text parameters', () => {
	test('encode every cell kind as server input text', () => {
		expect(textParam(null, 'text')).toBe(null);
		expect(textParam(42, 'number')).toBe('42');
		expect(textParam(true, 'boolean')).toBe('true');
		expect(textParam({ $t: 'bigint', v: '9007199254740993' }, 'bigint')).toBe('9007199254740993');
		expect(textParam({ $t: 'decimal', v: '1.10' }, 'decimal')).toBe('1.10');
		expect(textParam({ $t: 'bytes', v: Buffer.from([0xde, 0xad]).toString('base64') }, 'bytes')).toBe('\\xdead');
		expect(textParam({ $t: 'datetime', v: '2026-01-01T00:00:00.123456Z' }, 'datetime')).toBe('2026-01-01T00:00:00.123456Z');
		expect(textParam({ $t: 'json', v: { a: [1, 'x'] } }, 'json')).toBe('{"a":[1,"x"]}');
		expect(textParam({ $t: 'json', v: 'str' }, 'json')).toBe('"str"');
		expect(textParam('{"typed": true}', 'json')).toBe('{"typed": true}');
	});
	test('refuse truncated previews', () => {
		expect(() => textParam({ $t: 'truncated', v: 'abc', bytes: 99_999 }, 'text')).toThrow(StudioError);
	});
	test('array literals quote, escape and nest', () => {
		expect(arrayLiteral([1, null, 3], 'number')).toBe('{"1",NULL,"3"}');
		expect(arrayLiteral(['a"b', 'c\\d', '{,}'], 'text')).toBe('{"a\\"b","c\\\\d","{,}"}');
		expect(arrayLiteral([[1, 2], [3, 4]], 'number')).toBe('{{"1","2"},{"3","4"}}');
		expect(arrayLiteral([{ $t: 'bigint', v: '9007199254740993' }], 'bigint')).toBe('{"9007199254740993"}');
		expect(arrayLiteral([], 'text')).toBe('{}');
	});
});

describe('filter SQL', () => {
	const columns = new Map(
		[col('id', 'number', 'integer', false), col('name', 'text', 'text'), col('meta', 'json', 'jsonb'), col('pt', 'unknown', 'point')].map((c) => [c.name, c]),
	);
	const build = (filter: Parameters<typeof buildFilters>[0]) => {
		const params = new Params();
		return { sql: buildFilters(filter, columns, params), params: params.values };
	};

	test('comparisons bind text and cast to the column type', () => {
		expect(build([{ column: 'id', op: 'gte', value: 10 }])).toEqual({ sql: ['"id" >= $1::text::integer'], params: ['10'] });
		expect(build([{ column: 'name', op: 'ne', value: 'x' }])).toEqual({ sql: ['"name" <> $1::text'], params: ['x'] });
	});
	test('eq/ne NULL become null checks; other ops refuse NULL', () => {
		expect(build([{ column: 'name', op: 'eq', value: null }]).sql).toEqual(['"name" IS NULL']);
		expect(build([{ column: 'name', op: 'ne' }]).sql).toEqual(['"name" IS NOT NULL']);
		expect(() => build([{ column: 'id', op: 'lt', value: null }])).toThrow(StudioError);
	});
	test('like, ilike, in and null ops', () => {
		expect(build([{ column: 'name', op: 'ilike', value: '%a%' }])).toEqual({ sql: ['"name"::text ILIKE $1::text'], params: ['%a%'] });
		expect(build([{ column: 'id', op: 'in', value: [1, 2] }])).toEqual({
			sql: ['"id" IN ($1::text::integer, $2::text::integer)'],
			params: ['1', '2'],
		});
		expect(build([{ column: 'id', op: 'in', value: [] }]).sql).toEqual(['FALSE']);
		expect(build([{ column: 'id', op: 'is-null' }, { column: 'name', op: 'not-null' }]).sql).toEqual([
			'"id" IS NULL',
			'"name" IS NOT NULL',
		]);
	});
	test('json compares as jsonb; unknown types compare as text', () => {
		expect(build([{ column: 'meta', op: 'eq', value: { $t: 'json', v: { a: 1 } } }])).toEqual({
			sql: ['"meta"::jsonb = $1::text::jsonb'],
			params: ['{"a":1}'],
		});
		expect(build([{ column: 'pt', op: 'eq', value: '(1,2)' }]).sql).toEqual(['"pt"::text = $1::text']);
	});
	test('unknown columns and bad values are refused', () => {
		expect(() => build([{ column: 'nope', op: 'eq', value: 1 }])).toThrow(StudioError);
		expect(() => build([{ column: 'id', op: 'in', value: 1 }])).toThrow(StudioError);
	});
});

describe('keyset SQL', () => {
	const id = col('id', 'number', 'integer', false);
	const name = col('name', 'text', 'text', true);
	const build = (items: OrderItem[], values: Parameters<typeof keysetCondition>[1]) => {
		const params = new Params();
		return { sql: keysetCondition(items, values, params), params: params.values };
	};

	test('a NOT NULL key in one direction is a row comparison', () => {
		expect(build([{ column: id, dir: 'asc' }], [37])).toEqual({ sql: '"id" > $1::text::integer', params: ['37'] });
		expect(build([{ column: id, dir: 'desc' }], [37]).sql).toBe('"id" < $1::text::integer');
		const two = col('b', 'bigint', 'bigint', false);
		expect(build([{ column: id, dir: 'asc' }, { column: two, dir: 'asc' }], [1, { $t: 'bigint', v: '9007199254740993' }])).toEqual({
			sql: '("id", "b") > ($1::text::integer, $2::text::bigint)',
			params: ['1', '9007199254740993'],
		});
	});

	test('a nullable sort column expands with NULLS LAST for asc', () => {
		expect(build([{ column: name, dir: 'asc' }, { column: id, dir: 'asc' }], ['m', 5])).toEqual({
			sql: '(("name" > $1::text OR "name" IS NULL) OR ("name" = $2::text AND "id" > $3::text::integer))',
			params: ['m', 'm', '5'],
		});
		// After a NULL in an asc column only other NULLs remain, ordered by the key.
		expect(build([{ column: name, dir: 'asc' }, { column: id, dir: 'asc' }], [null, 5]).sql).toBe(
			'(("name" IS NULL AND "id" > $1::text::integer))',
		);
	});

	test('desc puts NULLs first', () => {
		expect(build([{ column: name, dir: 'desc' }, { column: id, dir: 'asc' }], [null, 5]).sql).toBe(
			'("name" IS NOT NULL OR ("name" IS NULL AND "id" > $1::text::integer))',
		);
		expect(build([{ column: name, dir: 'desc' }, { column: id, dir: 'asc' }], ['m', 5]).sql).toBe(
			'("name" < $1::text OR ("name" = $2::text AND "id" > $3::text::integer))',
		);
	});

	test('ctid is the tiebreak for key-less tables', () => {
		expect(build([{ column: 'ctid', dir: 'asc' }], ['(0,7)'])).toEqual({ sql: 'ctid > $1::text::tid', params: ['(0,7)'] });
	});

	test('cursors round-trip and refuse another sort order', () => {
		const cursor = encodeCursor({ s: 'sig', k: [1, { $t: 'bigint', v: '9007199254740993' }] });
		expect(decodeCursor(cursor, 'sig')).toEqual({ keys: [1, { $t: 'bigint', v: '9007199254740993' }] });
		expect(() => decodeCursor(cursor, 'other')).toThrow(StudioError);
		expect(() => decodeCursor('not base64 json', 'sig')).toThrow(StudioError);
		expect(decodeCursor(encodeCursor({ s: 'sig', o: 40 }), 'sig')).toEqual({ offset: 40 });
	});
});

describe('buildBrowse', () => {
	const table: TableMeta = {
		schema: 'public',
		name: 'studio_items',
		columns: [
			col('id', 'number', 'integer', false, { typeOid: 23 }),
			col('name', 'text', 'text', false, { typeOid: 25 }),
			col('data', 'bytes', 'bytea', true, { typeOid: 17 }),
			col('created', 'datetime', 'timestamp with time zone', true, { typeOid: 1184 }),
		],
		primaryKey: ['id'],
		ctid: true,
	};
	const query = { limit: 50, sort: [], filter: [] };

	test('keyset on the primary key, with previews and text timestamps', () => {
		const plan = buildBrowse(table, query, 1024);
		expect(plan.mode).toBe('keyset');
		expect(plan.text).toBe(
			'SELECT "id", left("name"::text, 1024), octet_length("name"::text), substring("data" from 1 for 1024), octet_length("data"), "created"::text FROM "public"."studio_items" AS src ORDER BY src."id" ASC NULLS LAST LIMIT 51',
		);
		expect(plan.selected.map((s) => [s.index, s.sizeIndex])).toEqual([[0, undefined], [1, 2], [3, 4], [5, undefined]]);
	});

	test('a cursor adds the keyset condition after the filters', () => {
		const first = buildBrowse(table, { ...query, filter: [{ column: 'name', op: 'like', value: 'a%' }] });
		const cursor = encodeCursor({ s: first.signature, k: [37] });
		const plan = buildBrowse(table, { ...query, cursor, filter: [{ column: 'name', op: 'like', value: 'a%' }] });
		expect(plan.text).toContain('WHERE "name"::text LIKE $1::text AND "id" > $2::text::integer ORDER BY');
		expect(plan.params).toEqual(['a%', '37']);
	});

	test('sorting by another column adds the key as a tiebreak', () => {
		const plan = buildBrowse(table, { ...query, sort: [{ column: 'created', dir: 'desc' }] });
		expect(plan.text).toContain('ORDER BY src."created" DESC NULLS FIRST, src."id" ASC NULLS LAST');
		expect(plan.order.map((o) => (o.column === 'ctid' ? 'ctid' : o.column.name))).toEqual(['created', 'id']);
	});

	test('key-less tables page by ctid; views fall back to OFFSET', () => {
		const noKey = buildBrowse({ ...table, primaryKey: null }, query);
		expect(noKey.text).toContain(', ctid::text FROM');
		expect(noKey.text).toContain('ORDER BY src.ctid ASC NULLS LAST');
		const view = { ...table, primaryKey: null, ctid: false };
		const plan = buildBrowse(view, { ...query, cursor: encodeCursor({ s: buildBrowse(view, query).signature, o: 50 }) });
		expect(plan.mode).toBe('offset');
		expect(plan.text).toEndWith('LIMIT 51 OFFSET 50');
	});

	test('refuses native filters and unknown columns', () => {
		expect(() => buildBrowse(table, { ...query, native: '{}' })).toThrow(StudioError);
		expect(() => buildBrowse(table, { ...query, sort: [{ column: 'nope', dir: 'asc' }] })).toThrow(StudioError);
	});
});

describe('type mapping', () => {
	test('builtin OIDs map to cell kinds', () => {
		const kinds = Object.fromEntries(
			[[21, 'int2'], [23, 'int4'], [701, 'float8'], [20, 'int8'], [1700, 'numeric'], [17, 'bytea'], [1184, 'timestamptz'], [1114, 'timestamp'], [1082, 'date'], [3802, 'jsonb'], [114, 'json'], [25, 'text'], [2950, 'uuid'], [16, 'bool'], [1007, 'int4[]']].map(
				([oid, label]) => [label, builtinType(oid as number)?.kind],
			),
		);
		expect(kinds).toEqual({
			int2: 'number',
			int4: 'number',
			float8: 'number',
			int8: 'bigint',
			numeric: 'decimal',
			bytea: 'bytes',
			timestamptz: 'datetime',
			timestamp: 'datetime',
			date: 'date',
			jsonb: 'json',
			json: 'json',
			text: 'text',
			uuid: 'uuid',
			bool: 'boolean',
			'int4[]': 'array',
		});
		expect(builtinType(1007)?.elem).toBe(23);
		expect(builtinType(1114)?.local).toBe(true);
	});

	test('catalog rows: enums, arrays, strings, domains', () => {
		const row = { oid: 1, name: 'x', typtype: 'b', typcategory: 'U', typelem: 0, typbasetype: 0 };
		expect(kindForRow({ ...row, typtype: 'e', typcategory: 'E' })).toBe('enum');
		expect(kindForRow({ ...row, typcategory: 'A', typelem: 99 })).toBe('array');
		expect(kindForRow({ ...row, typcategory: 'S' })).toBe('text');
		expect(kindForRow({ ...row, typtype: 'd' }, { oid: 20, name: 'bigint', kind: 'bigint' })).toBe('bigint');
		expect(kindForRow(row)).toBe('unknown');
	});

	test('decoders are lossless for awkward values', () => {
		expect(decoderFor('bigint')('9007199254740993')).toEqual({ $t: 'bigint', v: '9007199254740993' });
		expect(decoderFor('bigint')('42')).toBe(42);
		expect(decoderFor('decimal')('12345678901234567890.12')).toEqual({ $t: 'decimal', v: '12345678901234567890.12' });
		expect(decoderFor('number')(Number.NaN)).toEqual({ $t: 'decimal', v: 'NaN' });
		expect(decoderFor('bytes')(Buffer.from([1, 2]))).toEqual({ $t: 'bytes', v: 'AQI=' });
		expect(decoderFor('datetime')('2026-01-01 00:00:00.123456+00')).toEqual({ $t: 'datetime', v: '2026-01-01T00:00:00.123456Z' });
		expect(decoderFor('datetime')(Number.POSITIVE_INFINITY)).toEqual({ $t: 'datetime', v: 'infinity' });
		expect(decoderFor('datetime', { local: true })(new Date('2026-01-01T00:00:00.5Z'))).toEqual({
			$t: 'datetime',
			v: '2026-01-01T00:00:00.500',
		});
		expect(decoderFor('date')(new Date('2026-03-04T00:00:00Z'))).toEqual({ $t: 'date', v: '2026-03-04' });
		expect(decoderFor('json')({ a: 1 })).toEqual({ $t: 'json', v: { a: 1 } });
		// A string from the driver is a JSON string scalar, not JSON source.
		expect(decoderFor('json')('123')).toEqual({ $t: 'json', v: '123' });
		expect(decoderFor('json', { jsonText: true })('123')).toEqual({ $t: 'json', v: 123 });
		const bigints = decoderFor('array', { elem: decoderFor('bigint') });
		expect(bigints(['1', '9007199254740993'])).toEqual([1, { $t: 'bigint', v: '9007199254740993' }]);
		expect(decoderFor('array', { elem: decoderFor('number') })(new Int32Array([1, 2]))).toEqual([1, 2]);
		expect(decoderFor('array', { elem: decoderFor('number') })([[1], [2]])).toEqual([[1], [2]]);
		expect(decoderFor('text', { limit: 4 })('abcdef')).toEqual({ $t: 'truncated', v: 'abcd', bytes: 6 });
	});

	test('normaliseTimestamp', () => {
		expect(normaliseTimestamp('2026-01-01 10:00:00+00')).toBe('2026-01-01T10:00:00Z');
		expect(normaliseTimestamp('2026-01-01 10:00:00.5+05:30')).toBe('2026-01-01T10:00:00.5+05:30');
		expect(normaliseTimestamp('2026-01-01 10:00:00-07')).toBe('2026-01-01T10:00:00-07:00');
		expect(normaliseTimestamp('2026-01-01 10:00:00.123456')).toBe('2026-01-01T10:00:00.123456');
		expect(normaliseTimestamp('infinity')).toBe('infinity');
	});
});

describe('explain and positions', () => {
	test('parseExplain forces JSON and reports ANALYZE', () => {
		expect(parseExplain('select 1')).toEqual({ body: 'select 1', analyze: false, options: [] });
		expect(parseExplain('EXPLAIN ANALYZE VERBOSE select 1')).toEqual({ body: 'select 1', analyze: true, options: ['ANALYZE', 'VERBOSE'] });
		expect(parseExplain('/* hi */ explain (format text, analyze off, buffers) select 1')).toEqual({
			body: 'select 1',
			analyze: false,
			options: ['BUFFERS'],
		});
		expect(parseExplain('explain (analyse) delete from t').analyze).toBe(true);
		expect(() => parseExplain('explain (analyze) ')).toThrow(StudioError);
		expect(() => parseExplain('explain (costs off) select 1); drop table t; --')).not.toThrow();
		expect(() => parseExplain('explain (costs off; drop) select 1')).toThrow(StudioError);
	});

	test('inputPosition maps server positions back to the input', () => {
		const [, second] = splitStatements('select 1; selec 2');
		// The server reports position 1 for "selec" in the second statement.
		expect(inputPosition(second as NonNullable<typeof second>, 'selec 2', 0, 1)).toBe(11);
		// Through the DECLARE prefix.
		expect(inputPosition(second as NonNullable<typeof second>, 'DECLARE c FOR selec 2', 14, 15)).toBe(11);
		// Astral characters count once on the server and twice in UTF-16.
		const [emoji] = splitStatements("select '😀', nope");
		expect(inputPosition(emoji as NonNullable<typeof emoji>, "select '😀', nope", 0, 13)).toBe(14);
	});
});
