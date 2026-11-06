import { describe, expect, test } from 'bun:test';
import { BSON } from 'mongodb';
import { StudioError } from '../../protocol.ts';
import { bsonType, fieldTypes, fromCell, inferColumns, toCell } from './cells.ts';
import {
	assertReadOnlyAllowed,
	browsePlan,
	buildFilter,
	containsWriteStage,
	decodeCursor,
	encodeCursor,
	keysetFilter,
	likeToRegex,
	parseCommand,
} from './commands.ts';
import { clientOptions, connectionUrl, mongodbPlugin, prepareChange } from './index.ts';

function refusedReadOnly(input: string): boolean {
	try {
		assertReadOnlyAllowed(parseCommand(input));
		return false;
	} catch (error) {
		return error instanceof StudioError && error.code === 'read_only';
	}
}

describe('read-only allowlist', () => {
	test('allows reads', () => {
		for (const input of [
			'{"find":"c","filter":{}}',
			'{"find":"c","filter":{"$where":"sleep(100) || true"}}',
			'{"aggregate":"c","pipeline":[{"$match":{}}],"cursor":{}}',
			'{"count":"c"}',
			'{"distinct":"c","key":"a"}',
			'{"listCollections":1}',
			'{"listIndexes":"c"}',
			'{"dbStats":1}',
			'{"ping":1}',
			'{"hello":1}',
			'{"explain":{"find":"c","filter":{}},"verbosity":"queryPlanner"}',
		])
			expect(refusedReadOnly(input), input).toBe(false);
	});

	test('refuses writes, admin commands and unknown commands', () => {
		for (const input of [
			'{"insert":"c","documents":[{"a":1}]}',
			'{"update":"c","updates":[{"q":{},"u":{"$set":{"a":1}}}]}',
			'{"delete":"c","deletes":[{"q":{},"limit":0}]}',
			'{"drop":"c"}',
			'{"dropDatabase":1}',
			'{"eval":"1"}',
			'{"findAndModify":"c","query":{},"remove":true}',
			'{"createIndexes":"c","indexes":[]}',
			'{"mapReduce":"c"}',
			'{"Find":"c"}',
			'{"explain":{"delete":"c","deletes":[]}}',
			'{"explain":{"update":"c","updates":[]}}',
		])
			expect(refusedReadOnly(input), input).toBe(true);
	});

	test('refuses $out and $merge at any depth', () => {
		for (const input of [
			'{"aggregate":"c","pipeline":[{"$out":"x"}],"cursor":{}}',
			'{"aggregate":"c","pipeline":[{"$merge":{"into":"x"}}],"cursor":{}}',
			'{"aggregate":"c","pipeline":[{"$facet":{"a":[{"$merge":{"into":"x"}}]}}],"cursor":{}}',
			'{"aggregate":"c","pipeline":[{"$lookup":{"from":"d","pipeline":[{"$out":"x"}],"as":"y"}}],"cursor":{}}',
			'{"aggregate":"c","pipeline":[{"$unionWith":{"coll":"d","pipeline":[{"$facet":{"z":[{"$out":"x"}]}}]}}],"cursor":{}}',
			'{"explain":{"aggregate":"c","pipeline":[{"$out":"x"}],"cursor":{}}}',
		])
			expect(refusedReadOnly(input), input).toBe(true);
		// A field merely named like a stage value is fine; only keys count.
		expect(containsWriteStage([{ $match: { note: '$out' } }])).toBe(false);
	});

	test('parses only EJSON documents', () => {
		for (const input of ['[1]', '1', 'null', '"find"', '{}', 'db.c.find()', '{"find":'])
			expect(() => parseCommand(input), input).toThrow(StudioError);
		const parsed = parseCommand('{"find":"c","limit":5,"filter":{"_id":{"$oid":"64b7f0000000000000000001"}}}');
		expect(parsed.name).toBe('find');
		expect(bsonType(parsed.doc.limit)).toBe('int');
		expect(bsonType((parsed.doc.filter as BSON.Document)._id)).toBe('objectId');
	});
});

describe('EJSON cells', () => {
	const roundTrip = (value: unknown) => fromCell(JSON.parse(JSON.stringify(toCell(value))));

	test('ObjectId', () => {
		const id = new BSON.ObjectId();
		const cell = toCell(id);
		expect(cell).toEqual({ $t: 'ejson', v: { $oid: id.toHexString() } });
		const back = roundTrip(id) as BSON.ObjectId;
		expect(back._bsontype).toBe('ObjectId');
		expect(back.equals(id)).toBe(true);
	});

	test('Decimal128 keeps every digit', () => {
		const value = BSON.Decimal128.fromString('12345678901234567890.123456789');
		expect(toCell(value)).toEqual({ $t: 'ejson', v: { $numberDecimal: '12345678901234567890.123456789' } });
		expect((roundTrip(value) as BSON.Decimal128).toString()).toBe('12345678901234567890.123456789');
	});

	test('Long above 2^53 is exact', () => {
		const value = BSON.Long.fromString('9007199254740993');
		expect(toCell(value)).toEqual({ $t: 'ejson', v: { $numberLong: '9007199254740993' } });
		const back = roundTrip(value) as BSON.Long;
		expect(back._bsontype).toBe('Long');
		expect(back.toString()).toBe('9007199254740993');
	});

	test('Int32 is plain, Double keeps its type', () => {
		expect(toCell(new BSON.Int32(7))).toBe(7);
		expect(toCell(new BSON.Double(5))).toEqual({ $t: 'ejson', v: { $numberDouble: '5.0' } });
		expect((roundTrip(new BSON.Double(5)) as BSON.Double)._bsontype).toBe('Double');
	});

	test('Date, Binary and nested documents', () => {
		const date = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678));
		expect((roundTrip(date) as Date).toISOString()).toBe(date.toISOString());
		const binary = new BSON.Binary(Buffer.from([0, 1, 2, 255]), 0);
		const binaryBack = roundTrip(binary) as BSON.Binary;
		expect(Buffer.from(binaryBack.buffer).equals(Buffer.from([0, 1, 2, 255]))).toBe(true);
		const nested = { a: [new BSON.Int32(1), BSON.Long.fromString('9007199254740993')], b: { c: date, d: null } };
		expect(BSON.EJSON.stringify(roundTrip(nested), { relaxed: false })).toBe(
			BSON.EJSON.stringify(nested, { relaxed: false }),
		);
	});

	test('strings, booleans and null stay plain; truncated cannot be written', () => {
		expect(toCell('hi')).toBe('hi');
		expect(toCell(true)).toBe(true);
		expect(toCell(null)).toBe(null);
		expect(toCell(undefined)).toBe(null);
		const big = toCell('x'.repeat(70_000));
		expect(typeof big === 'object' && big !== null && !Array.isArray(big) && big.$t).toBe('truncated');
		expect(() => fromCell(big)).toThrow(StudioError);
	});

	test('inferColumns orders _id first, then by frequency, and marks mixed types', () => {
		const docs = [
			{ _id: new BSON.ObjectId(), a: 'x', b: new BSON.Int32(1) },
			{ _id: new BSON.ObjectId(), b: 'two', c: new Date() },
			{ _id: new BSON.ObjectId(), b: new BSON.Int32(3), m: { z: 1 } },
		];
		const columns = inferColumns(docs.map(fieldTypes), { editable: true });
		expect(columns.map((c) => c.name)).toEqual(['_id', 'b', 'a', 'c', 'm']);
		expect(columns[0]).toMatchObject({ kind: 'objectid', key: 'primary', editable: false, nullable: false });
		expect(columns[1]).toMatchObject({ nativeType: 'mixed(int, string)', kind: 'unknown', nullable: false });
		expect(columns[2]).toMatchObject({ kind: 'text', nullable: true, editable: true });
		expect(columns[3]?.kind).toBe('datetime');
		expect(columns[4]?.kind).toBe('document');
		expect(inferColumns([], { editable: false }).map((c) => c.name)).toEqual(['_id']);
	});
});

describe('page cursor', () => {
	test('keyset round-trips the exact _id type', () => {
		for (const id of [new BSON.ObjectId(), 'abc', new BSON.Int32(42), BSON.Long.fromString('9007199254740993')]) {
			const decoded = decodeCursor(encodeCursor({ mode: 'keyset', after: id }));
			expect(decoded.mode).toBe('keyset');
			if (decoded.mode === 'keyset') {
				expect(bsonType(decoded.after)).toBe(bsonType(id));
				expect(BSON.EJSON.stringify(decoded.after, { relaxed: false })).toBe(BSON.EJSON.stringify(id, { relaxed: false }));
			}
		}
	});

	test('skip round-trips and garbage is refused', () => {
		expect(decodeCursor(encodeCursor({ mode: 'skip', skip: 74 }))).toEqual({ mode: 'skip', skip: 74 });
		for (const bad of ['', 'not-base64!', Buffer.from('{"s":-1}').toString('base64url'), Buffer.from('[1]').toString('base64url')])
			expect(() => decodeCursor(bad), bad).toThrow(StudioError);
	});

	test('keyset crosses BSON type brackets', () => {
		expect(keysetFilter(new BSON.Int32(5), 1, bsonType)).toEqual({
			$or: [
				{ _id: { $gt: new BSON.Int32(5) } },
				{
					_id: {
						$type: ['symbol', 'string', 'object', 'array', 'binData', 'objectId', 'bool', 'date', 'timestamp', 'regex', 'maxKey'],
					},
				},
			],
		});
		const desc = keysetFilter('m', -1, bsonType);
		expect(desc).toEqual({
			$or: [{ _id: { $lt: 'm' } }, { _id: { $type: ['minKey', 'null', 'undefined', 'int', 'long', 'double', 'decimal'] } }],
		});
	});

	test('browsePlan uses keyset only for _id order', () => {
		expect(browsePlan([])).toEqual({ sort: { _id: 1 }, mode: 'keyset', dir: 1 });
		expect(browsePlan([{ column: '_id', dir: 'desc' }])).toEqual({ sort: { _id: -1 }, mode: 'keyset', dir: -1 });
		expect(browsePlan([{ column: 'name', dir: 'desc' }])).toEqual({ sort: { name: -1, _id: 1 }, mode: 'skip', dir: 1 });
		expect(browsePlan([], true).mode).toBe('skip');
		expect(() => browsePlan([{ column: '$where', dir: 'asc' }])).toThrow(StudioError);
	});
});

describe('browse filters', () => {
	test('native EJSON AND structured filters', () => {
		const filter = buildFilter({
			native: '{"meta.even":true}',
			filter: [
				{ column: '_id', op: 'eq', value: { $t: 'ejson', v: { $oid: '64b7f0000000000000000001' } } },
				{ column: 'big', op: 'gte', value: { $t: 'ejson', v: { $numberLong: '9007199254740993' } } },
				{ column: 'name', op: 'ilike', value: 'item 0%' },
				{ column: 'tag', op: 'in', value: ['a', 'b'] },
				{ column: 'gone', op: 'is-null' },
			],
		});
		const clauses = filter.$and as BSON.Document[];
		expect(clauses).toHaveLength(6);
		expect(clauses[0]).toEqual({ 'meta.even': true });
		expect(bsonType(clauses[1]?._id.$eq)).toBe('objectId');
		expect((clauses[2]?.big.$gte as BSON.Long).toString()).toBe('9007199254740993');
		expect(clauses[3]).toEqual({ name: { $regex: '^item 0.*$', $options: 'is' } });
		expect(clauses[4]).toEqual({ tag: { $in: ['a', 'b'] } });
		expect(clauses[5]).toEqual({ gone: { $eq: null } });
	});

	test('single clauses are not wrapped; bad input is refused', () => {
		expect(buildFilter({ filter: [] })).toEqual({});
		expect(buildFilter({ native: '{}', filter: [] })).toEqual({});
		expect(buildFilter({ filter: [{ column: 'a', op: 'ne', value: 1 }] })).toEqual({ a: { $ne: 1 } });
		expect(() => buildFilter({ native: '[{"a":1}]', filter: [] })).toThrow(StudioError);
		expect(() => buildFilter({ native: '"x"', filter: [] })).toThrow(StudioError);
		expect(() => buildFilter({ filter: [{ column: '$where', op: 'eq', value: '1' }] })).toThrow(StudioError);
		expect(() => buildFilter({ filter: [{ column: 'a.b', op: 'eq', value: '1' }] })).toThrow(StudioError);
		expect(() => buildFilter({ filter: [{ column: 'a', op: 'like', value: 1 }] })).toThrow(StudioError);
	});

	test('LIKE patterns escape regex metacharacters', () => {
		expect(likeToRegex('a.b%_(x)')).toBe('^a\\.b.*.\\(x\\)$');
		expect(new RegExp(likeToRegex('50%')).test('50% off')).toBe(true);
		expect(new RegExp(likeToRegex('a.c')).test('abc')).toBe(false);
	});
});

describe('apply preparation and connection', () => {
	test('update filters on _id plus originals and $sets the edits', () => {
		const prepared = prepareChange({
			op: 'update',
			key: { _id: { $t: 'ejson', v: { $oid: '64b7f0000000000000000001' } } },
			values: { name: 'new', big: { $t: 'ejson', v: { $numberLong: '9007199254740993' } } },
			original: { name: 'old' },
		});
		expect(prepared.op).toBe('update');
		if (prepared.op !== 'update') return;
		expect(bsonType(prepared.filter._id)).toBe('objectId');
		expect(prepared.filter.name).toEqual({ $eq: 'old' });
		expect(prepared.set.name).toBe('new');
		expect(bsonType(prepared.set.big)).toBe('long');
	});

	test('refuses a missing _id, an _id change and operator field names', () => {
		expect(() => prepareChange({ op: 'delete', key: {} })).toThrow(StudioError);
		expect(() => prepareChange({ op: 'update', key: { _id: 1 }, values: { _id: 2 }, original: {} })).toThrow(StudioError);
		expect(() => prepareChange({ op: 'update', key: { _id: 1 }, values: { $set: 1 }, original: {} })).toThrow(StudioError);
		expect(() => prepareChange({ op: 'insert', values: { 'a.b': 1 } })).toThrow(StudioError);
		expect(prepareChange({ op: 'insert', values: { _id: 'x', a: 1 } })).toEqual({ op: 'insert', doc: { _id: 'x', a: 1 } });
	});

	test('URL encodes credentials and authenticates against admin', () => {
		expect(connectionUrl({ host: '127.0.0.1', port: 27017, database: 'app', user: 'u@x', password: 'p:/?#@' })).toBe(
			'mongodb://u%40x:p%3A%2F%3F%23%40@127.0.0.1:27017/app?authSource=admin',
		);
		expect(clientOptions({ tls: null })).toMatchObject({ maxPoolSize: 3, appName: 'skiff-studio', directConnection: true });
		expect(clientOptions({ tls: { caPem: null } })).toMatchObject({ tls: true, tlsAllowInvalidCertificates: true });
	});

	test('capabilities', () => {
		expect(mongodbPlugin.engines).toEqual(['mongodb']);
		expect(mongodbPlugin.capabilities('mongodb', '8.0')).toEqual({
			family: 'document',
			language: 'mongo',
			edit: 'document-id',
			cancel: 'kill-op',
			explain: true,
			schemas: false,
		});
	});
});
