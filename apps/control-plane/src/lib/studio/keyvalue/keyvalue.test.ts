import { describe, expect, test } from 'bun:test';
import type { Column } from '@yoal/studio/protocol';
import { formatBytes, formatTtl, parseTtl, ttlFromCell, ttlInput } from './ttl.ts';
import {
	addHashField,
	addSetMember,
	addStringKey,
	addZsetMember,
	appendListItem,
	deleteHashField,
	deleteKey,
	deleteListItem,
	deleteStreamEntry,
	parseScore,
	removeSetMember,
	removeZsetMember,
	setHashField,
	setKeyTtl,
	setListItem,
	setStringValue,
	setZsetScore,
	withoutColumns,
} from './changes.ts';
import {
	defaultPattern,
	globEscape,
	groupPrefix,
	keyName,
	keyRef,
	keyspaceRef,
	looksLikeJson,
	patternQuery,
	reformatJson,
	stringValueView,
	withExpiresColumn,
} from './keys.ts';

describe('TTL', () => {
	test('formats milliseconds as human time', () => {
		expect(formatTtl(null)).toBe('No expiry');
		expect(formatTtl(-1)).toBe('No expiry');
		expect(formatTtl(-2)).toBe('Expired');
		expect(formatTtl(850)).toBe('850ms');
		expect(formatTtl(45_000)).toBe('45s');
		expect(formatTtl(725_400)).toBe('12m 5s');
		expect(formatTtl(3 * 3_600_000 + 20 * 60_000 + 12_000)).toBe('3h 20m');
		expect(formatTtl(86_400_000 + 5 * 60_000)).toBe('1d 5m');
	});

	test('parses typed TTLs; a bare number is seconds', () => {
		expect(parseTtl('')).toEqual({ ok: true, ms: null });
		expect(parseTtl('90')).toEqual({ ok: true, ms: 90_000 });
		expect(parseTtl('1h 30m')).toEqual({ ok: true, ms: 5_400_000 });
		expect(parseTtl('1h30m')).toEqual({ ok: true, ms: 5_400_000 });
		expect(parseTtl('1500ms')).toEqual({ ok: true, ms: 1_500 });
		expect(parseTtl('2D')).toEqual({ ok: true, ms: 172_800_000 });
		expect(parseTtl('1.5m')).toEqual({ ok: true, ms: 90_000 });
		expect(parseTtl('0').ok).toBe(false);
		expect(parseTtl('soon').ok).toBe(false);
		expect(parseTtl('5min').ok).toBe(false);
	});

	test('ttlInput reads back through parseTtl', () => {
		for (const ms of [1_500, 90_000, 5_400_000, 172_800_000 + 1_000]) expect(parseTtl(ttlInput(ms))).toEqual({ ok: true, ms });
		expect(ttlInput(null)).toBe('');
	});

	test('ttl cells and sizes', () => {
		expect(ttlFromCell(1000)).toBe(1000);
		expect(ttlFromCell(null)).toBe(null);
		expect(ttlFromCell(-1)).toBe(null);
		expect(ttlFromCell({ $t: 'bigint', v: '5' })).toBe(5);
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(4_300)).toBe('4.2 KB');
		expect(formatBytes(1_572_864)).toBe('1.5 MB');
		expect(formatBytes(null)).toBe('—');
	});
});

describe('row changes per type', () => {
	test('key table', () => {
		expect(addStringKey({ key: 'a', value: 'v', ttlMs: null })).toEqual({
			op: 'insert',
			values: { key: 'a', type: 'string', value: 'v' },
		});
		expect(addStringKey({ key: 'a', value: 'v', ttlMs: 500 }).op === 'insert' && addStringKey({ key: 'a', value: 'v', ttlMs: 500 })).toMatchObject({
			values: { ttl: 500 },
		});
		expect(setKeyTtl('a', null, 1000)).toEqual({ op: 'update', key: { key: 'a' }, values: { ttl: null }, original: { ttl: 1000 } });
		expect(deleteKey('a', 'hash')).toEqual({ op: 'delete', key: { key: 'a' }, original: { type: 'hash' } });
		expect(deleteKey('a')).toEqual({ op: 'delete', key: { key: 'a' } });
	});

	test('string, hash and list', () => {
		expect(setStringValue('new', 'old')).toEqual({ op: 'update', key: {}, values: { value: 'new' }, original: { value: 'old' } });
		// A truncated original can't be compared, so it is not sent as a guard.
		expect(setStringValue('new', { $t: 'truncated', v: 'o', bytes: 9 })).toEqual({
			op: 'update',
			key: {},
			values: { value: 'new' },
			original: {},
		});
		expect(addHashField('f', 'v')).toEqual({ op: 'insert', values: { field: 'f', value: 'v' } });
		expect(setHashField('f', 'v2', 'v')).toEqual({ op: 'update', key: { field: 'f' }, values: { value: 'v2' }, original: { value: 'v' } });
		expect(deleteHashField('f', 'v')).toEqual({ op: 'delete', key: { field: 'f' }, original: { value: 'v' } });
		expect(appendListItem('x')).toEqual({ op: 'insert', values: { value: 'x' } });
		expect(setListItem(3, 'y', 'x')).toEqual({ op: 'update', key: { index: 3 }, values: { value: 'y' }, original: { value: 'x' } });
		expect(deleteListItem(3)).toEqual({ op: 'delete', key: { index: 3 }, original: {} });
	});

	test('set, zset and stream', () => {
		expect(addSetMember('m')).toEqual({ op: 'insert', values: { member: 'm' } });
		expect(removeSetMember('m')).toEqual({ op: 'delete', key: { member: 'm' } });
		expect(addZsetMember('m', 1.5)).toEqual({ op: 'insert', values: { member: 'm', score: 1.5 } });
		expect(setZsetScore('m', 2, 1.5)).toEqual({ op: 'update', key: { member: 'm' }, values: { score: 2 }, original: { score: 1.5 } });
		expect(removeZsetMember('m', 2)).toEqual({ op: 'delete', key: { member: 'm' }, original: { score: 2 } });
		expect(deleteStreamEntry('1-0')).toEqual({ op: 'delete', key: { id: '1-0' } });
		expect(parseScore('1e3')).toEqual({ ok: true, score: 1000 });
		expect(parseScore('').ok).toBe(false);
		expect(parseScore('inf').ok).toBe(false);
	});

	test('withoutColumns strips UI-only columns from every part of a change', () => {
		expect(
			withoutColumns(
				[
					{ op: 'insert', values: { key: 'a', expires: 'x' } },
					{ op: 'update', key: { key: 'a' }, values: { ttl: 5 }, original: { ttl: 9, expires: 'x' } },
					{ op: 'delete', key: { key: 'a' }, original: { type: 'string', expires: 'x' } },
					{ op: 'delete', key: { key: 'b' } },
				],
				['expires'],
			),
		).toEqual([
			{ op: 'insert', values: { key: 'a' } },
			{ op: 'update', key: { key: 'a' }, values: { ttl: 5 }, original: { ttl: 9 } },
			{ op: 'delete', key: { key: 'a' }, original: { type: 'string' } },
			{ op: 'delete', key: { key: 'b' } },
		]);
	});
});

describe('keys and patterns', () => {
	const group = { kind: 'key-group' as const, path: ['0', 'user:', 'user:1:'] };
	const space = { kind: 'keyspace' as const, path: ['0'] };

	test('patterns come from the group prefix', () => {
		expect(groupPrefix(group)).toBe('user:1:');
		expect(groupPrefix(space)).toBe('');
		expect(defaultPattern(group)).toBe('user:1:*');
		expect(defaultPattern({ kind: 'key-group', path: ['0', 'a[1]*:'] })).toBe('a\\[1\\]\\*:*');
		expect(defaultPattern(space)).toBe('*');
		expect(globEscape('a?b\\')).toBe('a\\?b\\\\');
		expect(patternQuery(' * ')).toBeUndefined();
		expect(patternQuery('')).toBeUndefined();
		expect(patternQuery('user:*')).toBe('user:*');
	});

	test('object refs', () => {
		expect(keyspaceRef(group)).toEqual({ path: ['0'], kind: 'keyspace' });
		expect(keyRef('0', 'user:1:name')).toEqual({ path: ['0', 'user:1:name'], kind: 'key' });
		expect(keyName({ path: ['0', 'user:', 'user:1:name'] })).toBe('user:1:name');
	});

	test('the expires column follows ttl', () => {
		const columns: Column[] = ['key', 'type', 'ttl', 'size', 'value'].map((name) => ({ name, nativeType: name, kind: 'text' }));
		const shaped = withExpiresColumn(columns, [
			['a', 'string', 90_000, 50, 'x'],
			['b', 'hash', null, 70, null],
		]);
		expect(shaped.columns.map((c) => c.name)).toEqual(['key', 'type', 'ttl', 'expires', 'size', 'value']);
		expect(shaped.rows).toEqual([
			['a', 'string', 90_000, '1m 30s', 50, 'x'],
			['b', 'hash', null, 'No expiry', 70, null],
		]);
		expect(withExpiresColumn([], [])).toEqual({ columns: [], rows: [] });
	});

	test('string values', () => {
		expect(stringValueView('{"a":1}')).toEqual({ kind: 'text', text: '{"a":1}', json: true });
		expect(stringValueView('42')).toEqual({ kind: 'text', text: '42', json: false });
		expect(stringValueView({ $t: 'truncated', v: 'abc', bytes: 9_000 })).toEqual({ kind: 'truncated', preview: 'abc', bytes: 9_000 });
		expect(stringValueView({ $t: 'bytes', v: 'AAE=' })).toEqual({ kind: 'binary', base64: 'AAE=' });
		expect(stringValueView(null)).toEqual({ kind: 'missing' });
		expect(looksLikeJson('[1, 2')).toBe(false);
		expect(reformatJson('{"a":1}', true)).toBe('{\n  "a": 1\n}');
		expect(reformatJson('{\n  "a": 1\n}', false)).toBe('{"a":1}');
		expect(reformatJson('nope', true)).toBe('nope');
	});
});
