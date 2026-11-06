import { describe, expect, test } from 'bun:test';
import { StudioError } from '../../protocol.ts';
import {
	buildBrowse,
	buildDelete,
	buildInsert,
	buildUpdate,
	buildValue,
	cellParam,
	decodeCursor,
	encodeCursor,
	filterSql,
	leadingKeyword,
	nextCursor,
	quoteIdent,
	readOnlyRefusal,
	splitStatements,
	syntaxErrorPosition,
	tokenize,
	withStatementTimeout,
	type ColumnMeta,
	type TableMeta,
} from './sql.ts';

const col = (name: string, kind: ColumnMeta['kind'], extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
	name,
	kind,
	nativeType: kind,
	nullable: true,
	unsigned: false,
	generated: false,
	autoIncrement: false,
	...extra,
});

const items: TableMeta = {
	name: 'studio_items',
	view: false,
	primaryKey: ['id'],
	columns: [
		col('id', 'number', { nullable: false }),
		col('name', 'text', { nullable: false }),
		col('amount', 'decimal'),
		col('big', 'bigint'),
		col('data', 'bytes'),
		col('meta', 'json'),
		col('created', 'datetime'),
		col('gen', 'number', { generated: true }),
	],
};

const composite: TableMeta = {
	name: 'pairs',
	view: false,
	primaryKey: ['a', 'b'],
	columns: [col('a', 'number'), col('b', 'text'), col('v', 'text')],
};

const noKey: TableMeta = {
	name: 'loose',
	view: false,
	primaryKey: null,
	columns: [col('x', 'number'), col('doc', 'json'), col('y', 'text')],
};

const query = (q: Partial<Parameters<typeof buildBrowse>[1]> = {}) => ({ limit: 100, sort: [], filter: [], ...q });

function refused(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(StudioError);
		expect((error as StudioError).code).toBe(code as never);
		return;
	}
	throw new Error('expected a StudioError');
}

describe('quoteIdent', () => {
	test('backtick-quotes and doubles backticks', () => {
		expect(quoteIdent('users')).toBe('`users`');
		expect(quoteIdent('we`ird')).toBe('`we``ird`');
		expect(quoteIdent('a`; DROP TABLE x; --')).toBe('`a``; DROP TABLE x; --`');
	});
	test('refuses empty names and NUL', () => {
		refused(() => quoteIdent(''), 'bad_request');
		refused(() => quoteIdent('a\u0000b'), 'bad_request');
	});
});

describe('splitStatements', () => {
	const texts = (input: string) => splitStatements(input).map((s) => s.text);

	test('splits on top-level semicolons and drops empty fragments', () => {
		expect(texts('SELECT 1; SELECT 2;;  ; ')).toEqual(['SELECT 1', 'SELECT 2']);
	});
	test('ignores semicolons in strings, identifiers and comments', () => {
		expect(texts(`SELECT 'a;b', "c;d", \`e;f\`; SELECT 2`)).toEqual([`SELECT 'a;b', "c;d", \`e;f\``, 'SELECT 2']);
		expect(texts('SELECT 1 -- x; y\n; SELECT 2')).toEqual(['SELECT 1 -- x; y', 'SELECT 2']);
		expect(texts('SELECT 1 # x; y\n; SELECT 2')).toEqual(['SELECT 1 # x; y', 'SELECT 2']);
		expect(texts('SELECT /* a; b */ 1; SELECT 2')).toEqual(['SELECT /* a; b */ 1', 'SELECT 2']);
	});
	test('honours backslash escapes and doubled quotes', () => {
		expect(texts(String.raw`SELECT 'it\'s; fine'; SELECT 2`)).toEqual([String.raw`SELECT 'it\'s; fine'`, 'SELECT 2']);
		expect(texts("SELECT 'it''s; fine'; SELECT 2")).toEqual(["SELECT 'it''s; fine'", 'SELECT 2']);
		expect(texts('SELECT `a``;b`; SELECT 2')).toEqual(['SELECT `a``;b`', 'SELECT 2']);
		expect(texts(String.raw`SELECT "a\";b"; SELECT 2`)).toEqual([String.raw`SELECT "a\";b"`, 'SELECT 2']);
	});
	test('"--" needs whitespace to start a comment', () => {
		expect(texts('SELECT 1--1; SELECT 2')).toEqual(['SELECT 1--1', 'SELECT 2']);
		expect(texts('SELECT 1 --\n; SELECT 2')).toEqual(['SELECT 1 --', 'SELECT 2']);
	});
	test('drops comment-only fragments but keeps executable comments', () => {
		expect(texts('-- just a note\n; /* block */ ; SELECT 1')).toEqual(['SELECT 1']);
		expect(texts('/*!40101 SET NAMES utf8mb4 */')).toEqual(['/*!40101 SET NAMES utf8mb4 */']);
	});
	test('records each statement offset in the input', () => {
		const statements = splitStatements('SELECT 1;\n  SELECT 2');
		expect(statements.map((s) => s.offset)).toEqual([0, 12]);
	});
	test('refuses DELIMITER with an explanation', () => {
		refused(() => splitStatements('DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END //'), 'unsupported');
		refused(() => splitStatements('-- c\ndelimiter $$'), 'unsupported');
	});
	test('unterminated strings run to the end (the server reports them)', () => {
		expect(texts("SELECT 'abc; SELECT 2")).toEqual(["SELECT 'abc; SELECT 2"]);
	});
	test('leadingKeyword skips comments and hints', () => {
		const [statement] = splitStatements('/* hi */ -- there\n  select 1');
		expect(statement && leadingKeyword(statement)).toBe('SELECT');
	});
	test('tokenize classifies hints and executable comments', () => {
		expect(tokenize('SELECT /*+ BKA(t) */ 1 /*!50000 x */ /*M!100100 y */').map((t) => t.kind)).toEqual([
			'word',
			'hint',
			'word',
			'exec-comment',
			'exec-comment',
		]);
	});
});

describe('readOnlyRefusal', () => {
	const refusal = (sql: string) => {
		const [statement] = splitStatements(sql);
		if (!statement) throw new Error('no statement');
		return readOnlyRefusal(statement);
	};

	test('allows reads', () => {
		for (const sql of [
			'SELECT * FROM t',
			'WITH x AS (SELECT 1) SELECT * FROM x',
			'SHOW TABLES',
			'EXPLAIN SELECT 1',
			'DESCRIBE t',
			'SELECT @@transaction_read_only',
			"SET @x = 'COMMIT'",
			'SELECT /*+ MAX_EXECUTION_TIME(10) */ 1',
			// Writes and DDL are left to the read-only transaction, which refuses them (1792).
			'DELETE FROM t',
			'CREATE TABLE x (a INT)',
		])
			expect(refusal(sql), sql).toBeNull();
	});
	test('refuses the escape classes', () => {
		for (const sql of [
			'COMMIT',
			'BEGIN',
			'START TRANSACTION READ WRITE',
			'ROLLBACK',
			'SAVEPOINT a',
			"XA START 'x'",
			'CALL esc()',
			"PREPARE s FROM 'DELETE FROM t'",
			'EXECUTE s',
			"EXECUTE IMMEDIATE 'CALL esc()'",
			'SET SESSION transaction_read_only = OFF',
			'SET @@session.tx_read_only = 0',
			'set session transaction read write',
			'SET autocommit = 0',
			'SET STATEMENT transaction_read_only=0 FOR CREATE TABLE y (a INT)',
			'SET STATEMENT max_statement_time=1 FOR SELECT 1',
			"SET PASSWORD = 'x'",
			'BEGIN NOT ATOMIC COMMIT',
			'IF 1 THEN SELECT 1',
			'lbl: LOOP',
			'/*!50000 CALL esc() */',
			'SELECT 1 /*M!100100 , 2 */',
			"SELECT * FROM t INTO OUTFILE '/tmp/x'",
			"SELECT 1 INTO DUMPFILE '/tmp/x'",
			'ANALYZE TABLE t',
		])
			expect(refusal(sql), sql).not.toBeNull();
	});
});

describe('withStatementTimeout', () => {
	const wrap = (sql: string, dialect: 'mysql' | 'mariadb', ms = 30_000) => {
		const [statement] = splitStatements(sql);
		if (!statement) throw new Error('no statement');
		return withStatementTimeout(statement, dialect, ms);
	};

	test('MySQL puts a MAX_EXECUTION_TIME hint after a top-level SELECT', () => {
		expect(wrap('SELECT SLEEP(10)', 'mysql')).toBe('SELECT /*+ MAX_EXECUTION_TIME(30000) */ SLEEP(10)');
		expect(wrap('-- note\nselect 1', 'mysql', 1_500)).toBe('-- note\nselect /*+ MAX_EXECUTION_TIME(1500) */ 1');
	});
	test('MySQL merges into an existing hint comment', () => {
		expect(wrap('SELECT /*+ NO_ICP(t) */ * FROM t', 'mysql', 1_000)).toBe(
			'SELECT /*+ MAX_EXECUTION_TIME(1000) NO_ICP(t) */ * FROM t',
		);
	});
	test('MySQL leaves other statements to the client-side timer', () => {
		for (const sql of ['UPDATE t SET a = 1', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SHOW TABLES', 'CALL p()'])
			expect(wrap(sql, 'mysql')).toBe(sql);
	});
	test('MariaDB wraps queries and DML in SET STATEMENT max_statement_time', () => {
		expect(wrap('SELECT SLEEP(10)', 'mariadb', 2_500)).toBe('SET STATEMENT max_statement_time=2.500 FOR SELECT SLEEP(10)');
		expect(wrap('delete from t', 'mariadb', 1_000)).toBe('SET STATEMENT max_statement_time=1.000 FOR delete from t');
		expect(wrap('(SELECT 1) UNION (SELECT 2)', 'mariadb', 1_000)).toStartWith('SET STATEMENT max_statement_time=1.000 FOR (');
	});
	test('MariaDB leaves SET, DDL and SHOW alone', () => {
		for (const sql of ['SET STATEMENT max_statement_time=1 FOR SELECT 1', 'CREATE TABLE x (a INT)', 'SHOW TABLES'])
			expect(wrap(sql, 'mariadb')).toBe(sql);
	});
});

describe('cellParam', () => {
	test('BIGINT and DECIMAL go out typed so comparisons stay exact', () => {
		expect(cellParam({ $t: 'bigint', v: '9007199254740993' }, col('big', 'bigint'))).toEqual({
			typed: 'BIGINT',
			value: '9007199254740993',
		});
		expect(cellParam(42, col('big', 'bigint', { unsigned: true }))).toEqual({ typed: 'BIGINT UNSIGNED', value: '42' });
		expect(cellParam({ $t: 'decimal', v: '12.50' }, col('amount', 'decimal'))).toEqual({ typed: 'DECIMAL', value: '12.50' });
		refused(() => cellParam('abc', col('big', 'bigint')), 'bad_request');
		refused(() => cellParam('1;2', col('amount', 'decimal')), 'bad_request');
	});
	test('JSON is sent as text, bytes as a Buffer, temporal values as their text', () => {
		expect(cellParam({ $t: 'json', v: { a: [1, 2] } }, col('meta', 'json'))).toBe('{"a":[1,2]}');
		expect(cellParam({ $t: 'bytes', v: Buffer.from([0, 255]).toString('base64') }, col('data', 'bytes'))).toEqual(
			Buffer.from([0, 255]),
		);
		expect(cellParam({ $t: 'datetime', v: '2026-01-01 00:00:00.123' }, col('created', 'datetime'))).toBe(
			'2026-01-01 00:00:00.123',
		);
		expect(cellParam(true, col('flag', 'number'))).toBe(1);
		expect(cellParam(null, col('name', 'text'))).toBeNull();
	});
	test('refuses truncated previews and structured values for scalar columns', () => {
		refused(() => cellParam({ $t: 'truncated', v: 'abc', bytes: 100_000 }, col('name', 'text')), 'bad_request');
		refused(() => cellParam([1, 2], col('name', 'text')), 'bad_request');
	});
});

describe('filters', () => {
	test('each operator is parameterised and quoted', () => {
		expect(filterSql(items, { column: 'name', op: 'eq', value: 'x' }, 'mysql')).toEqual({ sql: '`name` <=> ?', params: ['x'] });
		expect(filterSql(items, { column: 'name', op: 'eq', value: null }, 'mysql')).toEqual({ sql: '`name` IS NULL', params: [] });
		expect(filterSql(items, { column: 'name', op: 'ne', value: 'x' }, 'mysql')).toEqual({
			sql: 'NOT (`name` <=> ?)',
			params: ['x'],
		});
		expect(filterSql(items, { column: 'id', op: 'gte', value: 5 }, 'mysql')).toEqual({ sql: '`id` >= ?', params: [5] });
		expect(filterSql(items, { column: 'name', op: 'like', value: 'a%' }, 'mysql')).toEqual({
			sql: '`name` LIKE ?',
			params: ['a%'],
		});
		expect(filterSql(items, { column: 'name', op: 'ilike', value: 'A%' }, 'mysql')).toEqual({
			sql: 'LOWER(`name`) LIKE LOWER(?)',
			params: ['A%'],
		});
		expect(filterSql(items, { column: 'id', op: 'in', value: [1, 2] }, 'mysql')).toEqual({
			sql: '`id` IN (?, ?)',
			params: [1, 2],
		});
		expect(filterSql(items, { column: 'id', op: 'in', value: [] }, 'mysql')).toEqual({ sql: '0 = 1', params: [] });
		expect(filterSql(items, { column: 'big', op: 'is-null' }, 'mysql')).toEqual({ sql: '`big` IS NULL', params: [] });
		expect(filterSql(items, { column: 'big', op: 'not-null' }, 'mysql')).toEqual({ sql: '`big` IS NOT NULL', params: [] });
	});
	test('JSON equality compares as JSON per dialect', () => {
		const value = { $t: 'json' as const, v: { a: 1 } };
		expect(filterSql(items, { column: 'meta', op: 'eq', value }, 'mysql').sql).toBe('`meta` <=> CAST(? AS JSON)');
		expect(filterSql(items, { column: 'meta', op: 'eq', value }, 'mariadb').sql).toBe('JSON_EQUALS(`meta`, ?) <=> 1');
	});
	test('unknown columns and missing values are refused', () => {
		refused(() => filterSql(items, { column: 'nope', op: 'eq', value: 1 }, 'mysql'), 'bad_request');
		refused(() => filterSql(items, { column: 'id', op: 'lt' }, 'mysql'), 'bad_request');
		refused(() => filterSql(items, { column: 'id', op: 'in', value: 1 }, 'mysql'), 'bad_request');
	});
});

describe('buildBrowse', () => {
	test('keyset on the primary key by default', () => {
		const plan = buildBrowse(items, query({ limit: 37 }), 'mysql');
		expect(plan.mode).toBe('keyset');
		expect(plan.sql).toBe(
			'SELECT `id`, `name`, `amount`, `big`, `data`, `meta`, `created`, `gen` FROM `studio_items` ORDER BY `id` ASC LIMIT 38',
		);
		expect(plan.params).toEqual([]);
	});
	test('keyset continues after the cursor key, with filters first', () => {
		const first = buildBrowse(items, query({ limit: 10 }), 'mysql');
		const cursor = nextCursor(first, [10]);
		const plan = buildBrowse(
			items,
			query({ limit: 10, cursor, filter: [{ column: 'name', op: 'like', value: 'item%' }] }),
			'mysql',
		);
		expect(plan.sql).toBe(
			'SELECT `id`, `name`, `amount`, `big`, `data`, `meta`, `created`, `gen` FROM `studio_items` WHERE `name` LIKE ? AND `id` > ? ORDER BY `id` ASC LIMIT 11',
		);
		expect(plan.params).toEqual(['item%', 10]);
	});
	test('a descending sort on the key is still keyset', () => {
		const plan = buildBrowse(items, query({ sort: [{ column: 'id', dir: 'desc' }], cursor: encodeCursor({ m: 'k', a: [50] }) }), 'mysql');
		expect(plan.mode).toBe('keyset');
		expect(plan.sql).toEndWith('WHERE `id` < ? ORDER BY `id` DESC LIMIT 101');
	});
	test('composite keys compare as a row constructor', () => {
		const plan = buildBrowse(composite, query({ cursor: encodeCursor({ m: 'k', a: [1, 'x'] }) }), 'mysql');
		expect(plan.sql).toBe('SELECT `a`, `b`, `v` FROM `pairs` WHERE (`a`, `b`) > (?, ?) ORDER BY `a` ASC, `b` ASC LIMIT 101');
		expect(plan.params).toEqual([1, 'x']);
	});
	test('other sorts fall back to offset with the key as tie-breaker', () => {
		const plan = buildBrowse(items, query({ limit: 20, sort: [{ column: 'name', dir: 'desc' }] }), 'mysql');
		expect(plan.mode).toBe('offset');
		expect(plan.sql).toEndWith('ORDER BY `name` DESC, `id` ASC LIMIT 21 OFFSET 0');
		const next = buildBrowse(items, query({ limit: 20, sort: [{ column: 'name', dir: 'desc' }], cursor: nextCursor(plan, null) }), 'mysql');
		expect(next.sql).toEndWith('LIMIT 21 OFFSET 20');
	});
	test('tables without a key use offset ordered by every orderable column', () => {
		const plan = buildBrowse(noKey, query(), 'mysql');
		expect(plan.mode).toBe('offset');
		expect(plan.sql).toBe('SELECT `x`, `doc`, `y` FROM `loose` ORDER BY `x` ASC, `y` ASC LIMIT 101 OFFSET 0');
	});
	test('BIGINT keys in the cursor stay exact', () => {
		const big: TableMeta = { name: 'b', view: false, primaryKey: ['id'], columns: [col('id', 'bigint')] };
		const plan = buildBrowse(big, query({ cursor: encodeCursor({ m: 'k', a: [{ $t: 'bigint', v: '9007199254740993' }] }) }), 'mysql');
		expect(plan.params).toEqual([{ typed: 'BIGINT', value: '9007199254740993' }]);
	});
	test('refuses unknown sort columns, bad and mismatched cursors', () => {
		refused(() => buildBrowse(items, query({ sort: [{ column: 'nope', dir: 'asc' }] }), 'mysql'), 'bad_request');
		refused(() => buildBrowse(items, query({ cursor: 'not base64 json' }), 'mysql'), 'bad_request');
		refused(() => buildBrowse(items, query({ cursor: encodeCursor({ m: 'o', o: 10 }) }), 'mysql'), 'bad_request');
		refused(
			() => buildBrowse(items, query({ sort: [{ column: 'name', dir: 'asc' }], cursor: encodeCursor({ m: 'k', a: [1] }) }), 'mysql'),
			'bad_request',
		);
	});
	test('cursors round-trip', () => {
		expect(decodeCursor(encodeCursor({ m: 'k', a: [1, { $t: 'bytes', v: 'AA==' }] }))).toEqual({
			m: 'k',
			a: [1, { $t: 'bytes', v: 'AA==' }],
		});
		refused(() => decodeCursor(encodeCursor({ m: 'o', o: -1 } as never)), 'bad_request');
	});
});

describe('apply SQL', () => {
	test('update matches the key and the null-safe original', () => {
		expect(
			buildUpdate(items, { key: { id: 1 }, values: { name: 'new', amount: { $t: 'decimal', v: '1.50' } }, original: { name: 'old', big: null } }, 'mysql'),
		).toEqual({
			sql: 'UPDATE `studio_items` SET `name` = ?, `amount` = ? WHERE `id` = ? AND `name` <=> ? AND `big` IS NULL',
			params: ['new', { typed: 'DECIMAL', value: '1.50' }, 1, 'old'],
		});
	});
	test('update compares JSON originals as JSON', () => {
		const sql = buildUpdate(items, { key: { id: 1 }, values: { meta: { $t: 'json', v: [] } }, original: { meta: { $t: 'json', v: { a: 1 } } } }, 'mariadb');
		expect(sql.sql).toBe('UPDATE `studio_items` SET `meta` = ? WHERE `id` = ? AND JSON_EQUALS(`meta`, ?) <=> 1');
		expect(sql.params).toEqual(['[]', 1, '{"a":1}']);
	});
	test('update refuses generated and auto_increment columns, empty changes and bad keys', () => {
		refused(() => buildUpdate(items, { key: { id: 1 }, values: { gen: 1 }, original: {} }, 'mysql'), 'bad_request');
		const auto: TableMeta = { ...items, columns: [col('id', 'number', { autoIncrement: true }), col('name', 'text')] };
		refused(() => buildUpdate(auto, { key: { id: 1 }, values: { id: 2 }, original: {} }, 'mysql'), 'bad_request');
		refused(() => buildUpdate(items, { key: { id: 1 }, values: {}, original: {} }, 'mysql'), 'bad_request');
		refused(() => buildUpdate(items, { key: { id: null }, values: { name: 'x' }, original: {} }, 'mysql'), 'bad_request');
		refused(() => buildUpdate(items, { key: {}, values: { name: 'x' }, original: {} }, 'mysql'), 'bad_request');
		refused(() => buildUpdate(items, { key: { id: 1, name: 'x' }, values: { name: 'x' }, original: {} }, 'mysql'), 'bad_request');
	});
	test('tables without a primary key and views are not editable', () => {
		refused(() => buildDelete(noKey, { key: { x: 1 } }, 'mysql'), 'unsupported');
		refused(() => buildInsert(noKey, { x: 1 }), 'unsupported');
		refused(() => buildUpdate({ ...items, view: true }, { key: { id: 1 }, values: { name: 'x' }, original: {} }, 'mysql'), 'unsupported');
	});
	test('insert, delete and value', () => {
		expect(buildInsert(items, { id: 300, name: 'x', data: { $t: 'bytes', v: 'AQI=' } })).toEqual({
			sql: 'INSERT INTO `studio_items` (`id`, `name`, `data`) VALUES (?, ?, ?)',
			params: [300, 'x', Buffer.from([1, 2])],
		});
		expect(buildDelete(items, { key: { id: 3 }, original: { name: 'x' } }, 'mysql')).toEqual({
			sql: 'DELETE FROM `studio_items` WHERE `id` = ? AND `name` <=> ?',
			params: [3, 'x'],
		});
		expect(buildValue(composite, { a: 1, b: 'x' }, 'v')).toEqual({
			sql: 'SELECT `v` FROM `pairs` WHERE `a` = ? AND `b` = ?',
			params: [1, 'x'],
		});
		refused(() => buildInsert(items, { gen: 1 }), 'bad_request');
		refused(() => buildValue(items, { id: 1 }, 'nope'), 'bad_request');
	});
});

describe('syntaxErrorPosition', () => {
	test('maps the "near" snippet back into the run input', () => {
		const statements = splitStatements('SELECT 1;\nSELEC 2 FROM t');
		const second = statements[1];
		if (!second) throw new Error('no statement');
		const message =
			"ERROR 1064 (42000): You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'SELEC 2 FROM t' at line 1";
		expect(syntaxErrorPosition(second, message)).toBe(11);
		expect(syntaxErrorPosition(second, 'something else')).toBeUndefined();
	});
});
