import { describe, expect, test } from 'bun:test';
import { DEFAULT_STUDIO_LIMITS } from '@yoal/contracts';
import { StudioError } from '../../protocol.ts';
import type { StudioTarget } from '../../driver.ts';
import { decodeCursor, encodeCursor, type BrowseCursor } from './cursor.ts';
import { flagsFor, gateCommand, parseCommandInfo } from './gate.ts';
import { clientUrl, collapseGroup, globEscape, groupKeys, keyvaluePlugin, matchesFilters } from './index.ts';
import { shapeReply } from './shape.ts';
import { commandLine, quoteArg } from './structure.ts';
import { argText, tokenize, TokenizeError } from './tokenize.ts';

describe('tokenize', () => {
	test('splits on whitespace', () => {
		expect(tokenize('  SET  key\tvalue ')).toEqual(['SET', 'key', 'value']);
	});

	test('double quotes keep spaces and understand escapes', () => {
		expect(tokenize('SET k "a b\\n\\t\\"c\\\\"')).toEqual(['SET', 'k', 'a b\n\t"c\\']);
		expect(tokenize('SET k "\\x41\\x42c"')).toEqual(['SET', 'k', 'ABc']);
		// An unknown escape is the character itself, as in redis-cli.
		expect(tokenize('GET "\\q"')).toEqual(['GET', 'q']);
		// `\x` without two hex digits is a plain `x`.
		expect(tokenize('GET "\\xZ1"')).toEqual(['GET', 'xZ1']);
	});

	test('\\x escapes build bytes: valid UTF-8 is text, anything else stays bytes', () => {
		expect(tokenize('GET "\\xc3\\xa9"')).toEqual(['GET', 'é']);
		const [, raw] = tokenize('SET "\\xff\\x00a" v');
		expect(raw).toBeInstanceOf(Uint8Array);
		expect([...(raw as Uint8Array)]).toEqual([0xff, 0x00, 0x61]);
	});

	test('single quotes only understand \\\'', () => {
		expect(tokenize("SET k 'a \\n b'")).toEqual(['SET', 'k', 'a \\n b']);
		expect(tokenize("SET k 'it\\'s'")).toEqual(['SET', 'k', "it's"]);
	});

	test('empty quoted arguments are kept', () => {
		expect(tokenize('SET k ""')).toEqual(['SET', 'k', '']);
		expect(tokenize("SET k ''")).toEqual(['SET', 'k', '']);
	});

	test('quotes may start mid-argument but must end it', () => {
		expect(tokenize('GET foo"bar baz"')).toEqual(['GET', 'foobar baz']);
		expect(() => tokenize('GET "foo"bar')).toThrow(TokenizeError);
		expect(() => tokenize("GET 'foo'bar")).toThrow(TokenizeError);
	});

	test('unbalanced quotes are an error', () => {
		expect(() => tokenize('GET "foo')).toThrow(TokenizeError);
		expect(() => tokenize("GET 'foo")).toThrow(TokenizeError);
		expect(() => tokenize('GET "foo\\"')).toThrow(TokenizeError);
	});

	test('one command per run; blank lines around it are fine', () => {
		expect(tokenize('\n  GET a  \n\n')).toEqual(['GET', 'a']);
		expect(() => tokenize('GET a\nDEL a')).toThrow(/one command/);
		// A newline inside quotes is part of the value.
		expect(tokenize('SET k "a\nb"')).toEqual(['SET', 'k', 'a\nb']);
	});

	test('unicode and empty input', () => {
		expect(tokenize('SET 🔑 "ü"')).toEqual(['SET', '🔑', 'ü']);
		expect(tokenize('   ')).toEqual([]);
		expect(argText(new Uint8Array([0x61, 0x62]))).toBe('ab');
	});
});

describe('read-only gate', () => {
	const ro = (line: string, flags: string[] | null | undefined) => gateCommand(argvOf(line), flags, true);
	const rw = (line: string, flags: string[] | null | undefined) => gateCommand(argvOf(line), flags, false);

	test('a read-only session needs the readonly flag', () => {
		expect(ro('GET a', ['readonly', 'fast'])).toEqual({ allow: true });
		expect(ro('SET a b', ['write', 'denyoom'])).toMatchObject({ allow: false, code: 'read_only' });
		expect(ro('DEL a', ['write'])).toMatchObject({ allow: false, code: 'read_only' });
		expect(ro('NOPE', null)).toMatchObject({ allow: false, code: 'read_only' });
	});

	test('FLUSHALL/FLUSHDB: refused read-only, warned in write sessions', () => {
		expect(ro('FLUSHALL', ['write'])).toMatchObject({ allow: false, code: 'read_only' });
		expect(rw('FLUSHALL', ['write'])).toMatchObject({ allow: true, warning: expect.stringContaining('every database') });
		expect(rw('flushdb', ['write'])).toMatchObject({ allow: true, warning: expect.stringContaining('this database') });
	});

	test('the denylist applies to every session, even read-only flagged commands', () => {
		for (const line of [
			'KEYS *',
			'MONITOR',
			'SUBSCRIBE ch',
			'PSUBSCRIBE c*',
			'SSUBSCRIBE ch',
			'BLPOP q 0',
			'BZPOPMIN z 0',
			'WAIT 1 0',
			'DEBUG SLEEP 10',
			'CLIENT LIST',
			'CONFIG SET appendonly no',
			'ACL SETUSER x on',
			'SCRIPT FLUSH',
			'FUNCTION LIST',
			"EVAL \"redis.call('del','a')\" 0",
			'EVAL_RO "return 1" 0',
			'FCALL_RO f 0',
			'MULTI',
			'EXEC',
			'SHUTDOWN',
			'SYNC',
			'PSYNC ? -1',
			'SAVE',
			'BGSAVE',
			'SELECT 1',
			'SWAPDB 0 1',
		]) {
			// Even with flags that would otherwise pass.
			expect(ro(line, ['readonly']), line).toMatchObject({ allow: false, code: 'forbidden' });
			expect(rw(line, ['readonly']), line).toMatchObject({ allow: false, code: 'forbidden' });
		}
	});

	test('blocking and admin flags are refused; XREAD only without BLOCK', () => {
		expect(rw('BLMOVE a b LEFT RIGHT 0', ['write', 'blocking'])).toMatchObject({ allow: false });
		expect(rw('SOMEMODULE.WAIT', ['blocking'])).toMatchObject({ allow: false, code: 'forbidden' });
		expect(rw('LATENCY RESET', ['admin'])).toMatchObject({ allow: false, code: 'forbidden' });
		expect(ro('XREAD COUNT 5 STREAMS s 0', ['readonly', 'blocking'])).toEqual({ allow: true });
		expect(ro('XREAD BLOCK 0 STREAMS s $', ['readonly', 'blocking'])).toMatchObject({ allow: false });
		expect(rw('COPY a b DB 3', ['write'])).toMatchObject({ allow: false });
		expect(rw('COPY a b', ['write'])).toEqual({ allow: true });
	});

	test('without COMMAND INFO a static allowlist decides, failing closed', () => {
		expect(ro('GET a', undefined)).toEqual({ allow: true });
		expect(ro('SCAN 0 MATCH a:*', undefined)).toEqual({ allow: true });
		expect(ro('MEMORY USAGE a', undefined)).toEqual({ allow: true });
		expect(ro('MEMORY PURGE', undefined)).toMatchObject({ allow: false, code: 'read_only' });
		expect(ro('SET a b', undefined)).toMatchObject({ allow: false, code: 'read_only' });
		expect(ro('JSON.GET doc', undefined)).toMatchObject({ allow: false, code: 'read_only' });
		// Write sessions do not need COMMAND INFO: the owner ACL decides.
		expect(rw('SET a b', undefined)).toEqual({ allow: true });
	});

	test('COMMAND INFO parsing, including container subcommands', () => {
		const reply = [
			['get', 2, ['readonly', 'fast'], 1, 1, 1, ['@read'], [], [], []],
			[
				'memory',
				-2,
				[],
				0,
				0,
				0,
				['@slow'],
				[],
				[],
				[
					['memory|usage', -3, ['readonly'], 2, 2, 1, ['@read'], [], [], []],
					['memory|purge', 2, [], 0, 0, 0, ['@slow'], [], [], []],
				],
			],
			null,
		];
		const specs = parseCommandInfo(['GET', 'MEMORY', 'NOPE'], reply);
		expect(flagsFor(specs.get('get') ?? null, ['GET', 'a'])).toEqual(['readonly', 'fast']);
		expect(flagsFor(specs.get('memory') ?? null, ['MEMORY', 'USAGE', 'k'])).toEqual(['readonly']);
		expect(flagsFor(specs.get('memory') ?? null, ['MEMORY', 'PURGE'])).toEqual([]);
		// Unknown subcommand: no flags, so a read-only session refuses it.
		expect(flagsFor(specs.get('memory') ?? null, ['MEMORY', 'BOGUS'])).toEqual([]);
		expect(specs.get('nope')).toBeNull();
		expect(flagsFor(null, ['NOPE'])).toBeNull();
		const usage = flagsFor(specs.get('memory') ?? null, ['MEMORY', 'USAGE', 'k']);
		expect(gateCommand(['MEMORY', 'USAGE', 'k'], usage, true)).toEqual({ allow: true });
		// PING/ECHO/INFO carry no readonly flag but change nothing; a write flag still refuses.
		expect(gateCommand(['PING'], ['fast', 'stale'], true)).toEqual({ allow: true });
		expect(gateCommand(['PING'], undefined, true)).toEqual({ allow: true });
		expect(gateCommand(['PING'], ['write'], true)).toMatchObject({ allow: false, code: 'read_only' });
		const purge = flagsFor(specs.get('memory') ?? null, ['MEMORY', 'PURGE']);
		expect(gateCommand(['MEMORY', 'PURGE'], purge, true)).toMatchObject({ allow: false });
	});
});

describe('reply shaping', () => {
	test('scalars are one row in a value column', () => {
		expect(shapeReply(['GET', 'a'], 'hello')).toMatchObject({ columns: [{ name: 'value', kind: 'text' }], rows: [['hello']] });
		expect(shapeReply(['GET', 'a'], null).rows).toEqual([[null]]);
		expect(shapeReply(['INCR', 'a'], 3).rows).toEqual([[3]]);
		expect(shapeReply(['X'], 2n ** 70n).rows).toEqual([[{ $t: 'bigint', v: (2n ** 70n).toString() }]]);
		expect(shapeReply(['X'], true).rows).toEqual([[true]]);
	});

	test('arrays are index/value with nested replies as json', () => {
		const shaped = shapeReply(['LRANGE', 'l', '0', '-1'], ['a', 'b']);
		expect(shaped.columns.map((c) => c.name)).toEqual(['index', 'value']);
		expect(shaped.rows).toEqual([
			[0, 'a'],
			[1, 'b'],
		]);
		const nested = shapeReply(['ZRANGE', 'z', '0', '-1', 'WITHSCORES'], [['a', 1.5]]);
		expect(nested.rows).toEqual([[0, { $t: 'json', v: ['a', 1.5] }]]);
		expect(nested.columns[1]?.kind).toBe('json');
	});

	test('maps are field/value', () => {
		const map = Object.assign(Object.create(null), { f1: 'v1', f2: 'v2' });
		const shaped = shapeReply(['HGETALL', 'h'], map);
		expect(shaped.columns.map((c) => c.name)).toEqual(['field', 'value']);
		expect(shaped.rows).toEqual([
			['f1', 'v1'],
			['f2', 'v2'],
		]);
	});

	test('mixed kinds make an unknown column; json is JSON-safe', () => {
		const shaped = shapeReply(['X'], ['a', 1, { big: 2n ** 64n }]);
		expect(shaped.columns[1]?.kind).toBe('unknown');
		expect(shaped.rows[2]).toEqual([2, { $t: 'json', v: { big: (2n ** 64n).toString() } }]);
	});

	test('SCAN-family replies list items and report the cursor', () => {
		const scan = shapeReply(['SCAN', '0'], ['17', ['k1', 'k2']]);
		expect(scan.columns.map((c) => c.name)).toEqual(['index', 'key']);
		expect(scan.rows).toEqual([
			[0, 'k1'],
			[1, 'k2'],
		]);
		expect(scan.notice?.message).toContain('17');
		expect(shapeReply(['SCAN', '0'], ['0', []]).notice?.message).toContain('complete');
		const hscan = shapeReply(['HSCAN', 'h', '0'], ['0', ['f', 'v', 'g', 'w']]);
		expect(hscan.columns.map((c) => c.name)).toEqual(['field', 'value']);
		expect(hscan.rows).toEqual([
			['f', 'v'],
			['g', 'w'],
		]);
		const zscan = shapeReply(['zscan', 'z', '0'], ['0', ['m', 2]]);
		expect(zscan.columns.map((c) => c.name)).toEqual(['member', 'score']);
		const novalues = shapeReply(['HSCAN', 'h', '0', 'NOVALUES'], ['0', ['f', 'g']]);
		expect(novalues.rows).toEqual([
			[0, 'f'],
			[1, 'g'],
		]);
	});
});

describe('cursors', () => {
	test('round-trip every shape', () => {
		const scans: BrowseCursor[] = [
			{ k: 'scan', c: '1234', o: ['a', 'b:c', 'ü'] },
			{ k: 'scan', c: null, o: ['x'] },
		];
		for (const cursor of scans) expect(decodeCursor(encodeCursor(cursor), 'scan') as BrowseCursor).toEqual(cursor);
		expect(decodeCursor(encodeCursor({ k: 'list', i: 300 }), 'list')).toEqual({ k: 'list', i: 300 });
		expect(decodeCursor(encodeCursor({ k: 'stream', x: '1700000000000-3' }), 'stream')).toEqual({
			k: 'stream',
			x: '1700000000000-3',
		});
	});

	test('garbage and cursors of another shape are a bad request', () => {
		const bad = (fn: () => unknown) => {
			try {
				fn();
			} catch (error) {
				return error instanceof StudioError ? error.code : 'other';
			}
			return 'accepted';
		};
		expect(bad(() => decodeCursor('not base64 json', 'scan'))).toBe('bad_request');
		expect(bad(() => decodeCursor(encodeCursor({ k: 'list', i: 3 }), 'scan'))).toBe('bad_request');
		expect(bad(() => decodeCursor(Buffer.from('{"k":"scan","c":"abc","o":[]}').toString('base64url'), 'scan'))).toBe(
			'bad_request',
		);
		expect(bad(() => decodeCursor(Buffer.from('{"k":"list","i":-1}').toString('base64url'), 'list'))).toBe('bad_request');
		expect(bad(() => decodeCursor(Buffer.from('{"k":"stream","x":"$"}').toString('base64url'), 'stream'))).toBe(
			'bad_request',
		);
	});
});

describe('helpers', () => {
	test('keys group on the delimiter, one level at a time', () => {
		const keys = ['user:1:name', 'user:1:email', 'user:2:name', 'user:', 'plain', 'a::b'];
		const root = groupKeys('', keys);
		expect([...root.groups]).toEqual([
			['user:', 4],
			['a:', 1],
		]);
		expect(root.leaves).toEqual(['plain']);
		const user = groupKeys('user:', keys);
		expect([...user.groups]).toEqual([
			['user:1:', 2],
			['user:2:', 1],
		]);
		// `user:` itself is a key inside its own group.
		expect(user.leaves).toEqual(['user:']);
		expect([...groupKeys('a:', keys).groups]).toEqual([['a::', 1]]);
	});

	test('single-child groups collapse; groups with a choice do not', () => {
		const keys = ['studio:item:1', 'studio:item:2', 'user:1:name', 'user:2:name', 'deep:a:b:c:1', 'deep:a:b:c:2'];
		expect(collapseGroup('studio:', keys)).toBe('studio:item:');
		expect(collapseGroup('user:', keys)).toBe('user:');
		expect(collapseGroup('deep:', keys)).toBe('deep:a:b:c:');
		// A key directly in the group stops the collapse.
		expect(collapseGroup('studio:', [...keys, 'studio:readme'])).toBe('studio:');
	});

	test('glob escaping', () => {
		expect(globEscape('a*b?[c]\\')).toBe('a\\*b\\?\\[c\\]\\\\');
	});

	test('client-side filters', () => {
		const row = { key: 'studio:item:12', type: 'string', ttl: null, size: 56, value: 'item 12' };
		expect(matchesFilters(row, [{ column: 'key', op: 'like', value: 'studio:item:1%' }])).toBe(true);
		expect(matchesFilters(row, [{ column: 'key', op: 'like', value: 'studio:item:2%' }])).toBe(false);
		expect(matchesFilters(row, [{ column: 'type', op: 'eq', value: 'string' }])).toBe(true);
		expect(matchesFilters(row, [{ column: 'ttl', op: 'is-null' }])).toBe(true);
		expect(matchesFilters(row, [{ column: 'size', op: 'gt', value: 100 }])).toBe(false);
		expect(matchesFilters(row, [{ column: 'type', op: 'in', value: ['hash', 'string'] }])).toBe(true);
	});

	test('connection URL encodes credentials and picks the scheme', () => {
		const target: StudioTarget = {
			engine: 'valkey',
			version: '9.1',
			host: '127.0.0.1',
			port: 6390,
			database: '0',
			user: 'app',
			password: 'p@ss:w/rd',
			tls: null,
		};
		expect(clientUrl(target)).toBe('redis://app:p%40ss%3Aw%2Frd@127.0.0.1:6390/0');
		expect(clientUrl({ ...target, tls: { caPem: null }, database: 'x' })).toBe('rediss://app:p%40ss%3Aw%2Frd@127.0.0.1:6390/0');
	});

	test('capabilities', () => {
		expect(keyvaluePlugin.engines).toEqual(['valkey', 'redis']);
		expect(keyvaluePlugin.capabilities('valkey', '9.1')).toEqual({
			family: 'keyvalue',
			language: 'redis',
			edit: 'key',
			cancel: 'none',
			explain: false,
			schemas: true,
			structure: ['rename', 'drop'],
		});
	});

	test('connect failure is a clear engine error', async () => {
		const target: StudioTarget = {
			engine: 'redis',
			version: '8.10',
			host: '127.0.0.1',
			// Nothing listens on port 1.
			port: 1,
			database: '0',
			user: 'app',
			password: 'pw',
			tls: null,
		};
		const error = await keyvaluePlugin
			.connect(target, { readOnly: true, limits: DEFAULT_STUDIO_LIMITS })
			.then(() => null, (e: unknown) => e);
		expect(error).toBeInstanceOf(StudioError);
		expect((error as StudioError).code).toBe('engine_error');
	});
});

function argvOf(line: string): string[] {
	return tokenize(line).map(argText);
}

describe('structure edits', () => {
	test('command lines quote every argument and round-trip through the tokenizer', () => {
		expect(commandLine('RENAMENX', ['a', 'b'])).toBe('RENAMENX "a" "b"');
		expect(quoteArg('say "hi"\\')).toBe('"say \\"hi\\"\\\\"');
		expect(quoteArg('a\nb\tc\u0001')).toBe('"a\\nb\\tc\\x01"');
		for (const key of ['user:1', 'with space', 'quote"back\\slash', 'line\nbreak', 'ctl\u0007', 'é ü'])
			expect(tokenize(commandLine('UNLINK', [key]))).toEqual(['UNLINK', key]);
	});
});
