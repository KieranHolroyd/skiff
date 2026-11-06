import { describe, expect, test } from 'bun:test';
import type { Column, StudioInfo, TreeNode, TreePath } from '@skiff/studio/protocol';
import {
	LEVEL_CAP,
	MONGO_COMMANDS,
	REDIS_COMMANDS,
	completionContext,
	createCompletionSource,
	resolveAlias,
	sqlKeywords,
	type CompletionCall
} from './completion.ts';

function info(capabilities: Partial<StudioInfo['capabilities']>): StudioInfo {
	return {
		v: 1,
		engine: 'postgres',
		version: '17',
		readOnly: true,
		capabilities: {
			family: 'relational',
			language: 'sql',
			dialect: 'postgres',
			edit: 'primary-key',
			cancel: 'native',
			explain: true,
			schemas: true,
			...capabilities
		},
		limits: { maxRows: 10_000, maxBytes: 1, statementTimeoutMs: 30_000 },
		expiresAt: new Date(Date.now() + 60_000).toISOString()
	} as StudioInfo;
}

const node = (path: string[], kind: TreeNode['kind']): TreeNode => ({
	path,
	name: path.at(-1) ?? '',
	kind,
	hasChildren: kind === 'schema',
	browsable: kind !== 'schema'
});

interface Recorded {
	op: string;
	body: unknown;
}

/** A fake `studioCall` over a fixed tree, recording every call. */
function fakeCall(
	tree: Record<string, TreeNode[]>,
	columns: Record<string, Column[]> = {},
	fail: { tree?: number } = {}
): { call: CompletionCall; calls: Recorded[] } {
	const calls: Recorded[] = [];
	let treeFailures = fail.tree ?? 0;
	const call = (async (_database: string, op: string, body: { path?: TreePath; object?: { path: TreePath } }) => {
		calls.push({ op, body });
		if (op === 'tree') {
			if (treeFailures > 0) {
				treeFailures--;
				throw new Error('studio_unavailable');
			}
			return { nodes: tree[JSON.stringify(body.path)] ?? [] };
		}
		return { columns: columns[JSON.stringify(body.object?.path)] ?? [] };
	}) as unknown as CompletionCall;
	return { call, calls };
}

const pgTree = {
	'[]': [node(['public'], 'schema'), node(['audit'], 'schema')],
	'["public"]': [node(['public', 'users'], 'table'), node(['public', 'active_users'], 'view')],
	'["audit"]': [node(['audit', 'events'], 'table')]
};
const userColumns = {
	'["public","users"]': [
		{ name: 'id', nativeType: 'bigint', kind: 'bigint' },
		{ name: 'email', nativeType: 'text', kind: 'text' }
	] as Column[]
};

describe('SQL completion (postgres)', () => {
	test('root offers schemas, public tables and dialect keywords without loading other schemas', async () => {
		const { call, calls } = fakeCall(pgTree, userColumns);
		const source = createCompletionSource('app', info({}), call);
		const items = await source.items({ prefix: '' });
		const labels = items.map((item) => `${item.kind}:${item.label}`);
		expect(labels).toContain('schema:public');
		expect(labels).toContain('schema:audit');
		expect(labels).toContain('table:users');
		expect(labels).toContain('view:active_users');
		expect(labels).toContain('keyword:RETURNING');
		expect(labels).not.toContain('table:events');
		expect(calls.map((entry) => JSON.stringify(entry.body))).toEqual([
			'{"path":[]}',
			'{"path":["public"]}'
		]);
	});

	test('a schema qualifier lists that schema, a table qualifier lists its columns', async () => {
		const { call, calls } = fakeCall(pgTree, userColumns);
		const source = createCompletionSource('app', info({}), call);
		expect((await source.items({ prefix: '', qualifier: 'audit' })).map((item) => item.label)).toEqual([
			'events'
		]);
		const columns = await source.items({ prefix: '', qualifier: 'USERS' });
		expect(columns).toEqual([
			{ label: 'id', kind: 'column', detail: 'bigint' },
			{ label: 'email', kind: 'column', detail: 'text' }
		]);
		expect(await source.items({ prefix: '', qualifier: 'nope' })).toEqual([]);
		expect(calls.filter((entry) => entry.op === 'describe')).toHaveLength(1);
	});

	test('tree and describe results are cached for the session', async () => {
		const { call, calls } = fakeCall(pgTree, userColumns);
		const source = createCompletionSource('app', info({}), call);
		await source.items({ prefix: '' });
		await source.items({ prefix: 'us' });
		await source.items({ prefix: '', qualifier: 'users' });
		await source.items({ prefix: 'em', qualifier: 'users' });
		expect(calls).toHaveLength(3);
	});

	test('a failed tree call yields keywords only and is retried next time', async () => {
		const { call, calls } = fakeCall(pgTree, userColumns, { tree: 1 });
		const source = createCompletionSource('app', info({}), call);
		const first = await source.items({ prefix: '' });
		expect(first.every((item) => item.kind === 'keyword')).toBe(true);
		const second = await source.items({ prefix: '' });
		expect(second.some((item) => item.label === 'users')).toBe(true);
		expect(calls.length).toBeGreaterThan(2);
	});

	test('levels are capped, preferring names that start with the prefix', async () => {
		const many = Array.from({ length: 500 }, (_, index) =>
			node(['public', `t${String(index).padStart(3, '0')}`], 'table')
		);
		many.push(node(['public', 'zebra'], 'table'));
		const { call } = fakeCall({ '[]': [node(['public'], 'schema')], '["public"]': many });
		const source = createCompletionSource('app', info({}), call);
		const tables = (await source.items({ prefix: '' })).filter((item) => item.kind === 'table');
		expect(tables).toHaveLength(LEVEL_CAP);
		const zebra = (await source.items({ prefix: 'ze' })).filter((item) => item.kind === 'table');
		expect(zebra[0]?.label).toBe('zebra');
	});
});

describe('SQL completion (mysql)', () => {
	test('the root lists tables directly and keywords follow the dialect', async () => {
		const { call } = fakeCall(
			{ '[]': [node(['orders'], 'table')] },
			{ '["orders"]': [{ name: 'total', nativeType: 'decimal(10,2)', kind: 'decimal' }] }
		);
		const source = createCompletionSource(
			'shop',
			info({ dialect: 'mysql', schemas: false }),
			call
		);
		const items = await source.items({ prefix: '' });
		expect(items.some((item) => item.kind === 'schema')).toBe(false);
		expect(items.some((item) => item.label === 'orders' && item.kind === 'table')).toBe(true);
		expect(items.some((item) => item.label === 'SHOW TABLES')).toBe(true);
		expect(items.some((item) => item.label === 'ILIKE')).toBe(false);
		expect(await source.items({ prefix: '', qualifier: 'orders' })).toEqual([
			{ label: 'total', kind: 'column', detail: 'decimal(10,2)' }
		]);
	});

	test('mariadb adds RETURNING', () => {
		expect(sqlKeywords('mariadb')).toContain('RETURNING');
		expect(sqlKeywords('mysql')).not.toContain('RETURNING');
	});
});

describe('MongoDB completion', () => {
	test('collections plus command snippets', async () => {
		const { call } = fakeCall({ '[]': [node(['orders'], 'collection'), node(['recent'], 'view')] });
		const source = createCompletionSource(
			'docs',
			info({ family: 'document', language: 'mongo', dialect: undefined, schemas: false }),
			call
		);
		const items = await source.items({ prefix: '' });
		expect(items.slice(0, 2)).toEqual([
			{ label: 'orders', kind: 'collection' },
			{ label: 'recent', kind: 'view', detail: 'view' }
		]);
		const find = items.find((item) => item.label === 'find');
		expect(find?.kind).toBe('snippet');
		expect(find?.insertText).toContain('"find": "${1:collection}"');
		expect(MONGO_COMMANDS.map((item) => item.label)).toEqual(
			expect.arrayContaining(['aggregate', 'count', 'distinct', 'insert', 'update', 'delete', 'listCollections'])
		);
	});
});

describe('Redis completion', () => {
	test('a static command list with argument hints and no studio calls', async () => {
		const { call, calls } = fakeCall({});
		const source = createCompletionSource(
			'cache',
			info({ family: 'keyvalue', language: 'redis', dialect: undefined, schemas: false }),
			call
		);
		const items = await source.items({ prefix: 'hg' });
		expect(items[0]).toEqual({ label: 'HGET', kind: 'command', detail: 'key field', insertText: 'HGET ' });
		expect(calls).toHaveLength(0);
		expect(REDIS_COMMANDS.length).toBeGreaterThan(50);
	});
});

describe('completionContext', () => {
	test('splits qualifier and prefix', () => {
		expect(completionContext('SELECT * FROM public.us')).toEqual({ prefix: 'us', qualifier: 'public' });
		expect(completionContext('SELECT u.')).toEqual({ prefix: '', qualifier: 'u' });
		expect(completionContext('SELECT "My Table".na')).toEqual({ prefix: 'na', qualifier: 'My Table' });
		expect(completionContext('SELECT `t`.x')).toEqual({ prefix: 'x', qualifier: 't' });
		expect(completionContext('SELECT ema')).toEqual({ prefix: 'ema' });
		expect(completionContext('')).toEqual({ prefix: '' });
		expect(completionContext('SELECT 1.5')).toEqual({ prefix: '5' });
	});
});

describe('resolveAlias', () => {
	const sql = 'SELECT u.id FROM public.users u JOIN orders AS o ON o.user_id = u.id WHERE u.';
	test('maps aliases to tables', () => {
		expect(resolveAlias(sql, 'u')).toBe('users');
		expect(resolveAlias(sql, 'O')).toBe('orders');
	});
	test('leaves table names and unknown names alone', () => {
		expect(resolveAlias('SELECT * FROM users WHERE users.', 'users')).toBe('users');
		expect(resolveAlias(sql, 'x')).toBe('x');
	});
	test('ignores keywords after a table name', () => {
		expect(resolveAlias('SELECT * FROM users where', 'where')).toBe('where');
	});
});
