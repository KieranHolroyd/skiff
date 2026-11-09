import type { Column, StudioInfo, TreeNode, TreePath } from '@yoal/studio/protocol';
import { studioCall } from './client.js';
import type { CompletionItem, CompletionSource } from './ui-types.js';

/**
 * Editor completion for the studio (plan 22). Items come from `tree` and `describe`, loaded
 * lazily on the first request that needs them and cached for the life of the source (one studio
 * session). Nothing loads the whole database: the root, one schema's tables or one table's
 * columns are fetched only when the cursor asks for them.
 */

/** Items returned per tree level, so a database with thousands of tables stays responsive. */
export const LEVEL_CAP = 200;

type TreeCall = (database: string, op: 'tree', body: { path: TreePath }) => Promise<{ nodes: TreeNode[] }>;
type DescribeCall = (
	database: string,
	op: 'describe',
	body: { object: { path: TreePath; kind: TreeNode['kind'] } }
) => Promise<{ columns: Column[] }>;

/** The subset of `studioCall` completion uses; tests pass a fake. */
export type CompletionCall = TreeCall & DescribeCall;

export function createCompletionSource(
	database: string,
	info: StudioInfo,
	call: CompletionCall = studioCall as unknown as CompletionCall
): CompletionSource {
	switch (info.capabilities.language) {
		case 'sql':
			return sqlSource(database, info, call);
		case 'mongo':
			return mongoSource(database, call);
		case 'redis':
			return { items: async ({ prefix }) => capped(REDIS_COMMANDS, prefix) };
	}
}

// ---------------------------------------------------------------- shared

const OBJECT_KINDS: ReadonlySet<TreeNode['kind']> = new Set([
	'table',
	'view',
	'materialized-view',
	'foreign-table',
	'collection'
]);

function lazyTree(database: string, call: CompletionCall) {
	const levels = new Map<string, Promise<TreeNode[]>>();
	return (path: TreePath): Promise<TreeNode[]> => {
		const key = JSON.stringify(path);
		let level = levels.get(key);
		if (!level) {
			level = call(database, 'tree', { path }).then((result) => result.nodes);
			// A failed load is retried on the next request instead of caching the failure.
			level.catch(() => levels.delete(key));
			levels.set(key, level);
		}
		return level;
	};
}

/** Prefer names starting with `prefix` (case-insensitive), then cap the list. */
function capped(items: CompletionItem[], prefix: string, cap = LEVEL_CAP): CompletionItem[] {
	if (!prefix) return items.slice(0, cap);
	const lower = prefix.toLowerCase();
	const starting = items.filter((item) => item.label.toLowerCase().startsWith(lower));
	if (starting.length >= cap) return starting.slice(0, cap);
	const rest = items.filter(
		(item) => !item.label.toLowerCase().startsWith(lower) && item.label.toLowerCase().includes(lower)
	);
	return starting.concat(rest).slice(0, cap);
}

function objectItem(node: TreeNode): CompletionItem {
	const kind: CompletionItem['kind'] =
		node.kind === 'collection' ? 'collection' : node.kind === 'table' ? 'table' : 'view';
	const detail = node.kind === 'table' || node.kind === 'collection' ? node.detail?.type : node.kind;
	return { label: node.name, kind, ...(detail ? { detail } : {}) };
}

async function safely<T>(load: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await load();
	} catch {
		// Completion is best effort: a failed tree call must never break typing.
		return fallback;
	}
}

// ---------------------------------------------------------------- SQL

function sqlSource(database: string, info: StudioInfo, call: CompletionCall): CompletionSource {
	const tree = lazyTree(database, call);
	const hasSchemas = info.capabilities.schemas;
	const keywords = sqlKeywords(info.capabilities.dialect).map(
		(word): CompletionItem => ({ label: word, kind: 'keyword' })
	);
	const columns = new Map<string, Promise<Column[]>>();

	function describe(node: TreeNode): Promise<Column[]> {
		const key = JSON.stringify(node.path);
		let loaded = columns.get(key);
		if (!loaded) {
			loaded = call(database, 'describe', { object: { path: node.path, kind: node.kind } }).then(
				(result) => result.columns
			);
			loaded.catch(() => columns.delete(key));
			columns.set(key, loaded);
		}
		return loaded;
	}

	async function schemaNodes(): Promise<TreeNode[]> {
		return hasSchemas ? (await tree([])).filter((node) => node.kind === 'schema') : [];
	}

	/** Objects at the default level: the root without schemas, else `public` when it exists. */
	async function defaultObjects(): Promise<TreeNode[]> {
		if (!hasSchemas) return (await tree([])).filter((node) => OBJECT_KINDS.has(node.kind));
		const schemas = await schemaNodes();
		const fallback = schemas.find((node) => node.name === 'public');
		if (!fallback) return [];
		return (await tree(fallback.path)).filter((node) => OBJECT_KINDS.has(node.kind));
	}

	const same = (a: string, b: string) => a === b || a.toLowerCase() === b.toLowerCase();

	async function qualified(qualifier: string, prefix: string): Promise<CompletionItem[]> {
		// `schema.` → that schema's tables and views.
		const schema = (await schemaNodes()).find((node) => same(node.name, qualifier));
		if (schema) {
			const objects = (await tree(schema.path)).filter((node) => OBJECT_KINDS.has(node.kind));
			return capped(objects.map(objectItem), prefix);
		}
		// `table.` → its columns (described on demand).
		const table = (await defaultObjects()).find((node) => same(node.name, qualifier));
		if (!table) return [];
		const cols = await describe(table);
		return capped(
			cols.map((column) => ({ label: column.name, kind: 'column' as const, detail: column.nativeType })),
			prefix
		);
	}

	return {
		async items({ prefix, qualifier }) {
			if (qualifier) return safely(() => qualified(qualifier, prefix), []);
			const [schemas, objects] = await Promise.all([
				safely(schemaNodes, []),
				safely(defaultObjects, [])
			]);
			return [
				...capped(
					schemas.map((node): CompletionItem => ({ label: node.name, kind: 'schema' })),
					prefix
				),
				...capped(objects.map(objectItem), prefix),
				...capped(keywords, prefix, keywords.length)
			];
		}
	};
}

const SQL_KEYWORDS = [
	'SELECT',
	'FROM',
	'WHERE',
	'AND',
	'OR',
	'NOT',
	'IN',
	'IS',
	'NULL',
	'LIKE',
	'BETWEEN',
	'EXISTS',
	'AS',
	'DISTINCT',
	'JOIN',
	'INNER JOIN',
	'LEFT JOIN',
	'RIGHT JOIN',
	'CROSS JOIN',
	'ON',
	'USING',
	'GROUP BY',
	'HAVING',
	'ORDER BY',
	'ASC',
	'DESC',
	'LIMIT',
	'OFFSET',
	'UNION',
	'UNION ALL',
	'INTERSECT',
	'EXCEPT',
	'CASE',
	'WHEN',
	'THEN',
	'ELSE',
	'END',
	'WITH',
	'INSERT INTO',
	'VALUES',
	'UPDATE',
	'SET',
	'DELETE FROM',
	'CREATE TABLE',
	'CREATE INDEX',
	'CREATE VIEW',
	'ALTER TABLE',
	'DROP TABLE',
	'TRUNCATE',
	'PRIMARY KEY',
	'FOREIGN KEY',
	'REFERENCES',
	'DEFAULT',
	'COUNT',
	'SUM',
	'AVG',
	'MIN',
	'MAX',
	'COALESCE',
	'CAST',
	'EXPLAIN',
	'BEGIN',
	'COMMIT',
	'ROLLBACK'
];

const POSTGRES_KEYWORDS = [
	'ILIKE',
	'RETURNING',
	'ON CONFLICT',
	'DO NOTHING',
	'DO UPDATE',
	'DISTINCT ON',
	'LATERAL',
	'FILTER',
	'OVER',
	'PARTITION BY',
	'WINDOW',
	'FETCH FIRST',
	'NULLS FIRST',
	'NULLS LAST',
	'MATERIALIZED',
	'JSONB',
	'ARRAY',
	'NOW()',
	'CURRENT_TIMESTAMP',
	'GENERATE_SERIES',
	'STRING_AGG',
	'ARRAY_AGG',
	'JSONB_AGG',
	'EXPLAIN ANALYZE',
	'VACUUM',
	'ANALYZE'
];

const MYSQL_KEYWORDS = [
	'SHOW TABLES',
	'SHOW COLUMNS',
	'SHOW INDEX',
	'SHOW CREATE TABLE',
	'SHOW PROCESSLIST',
	'SHOW VARIABLES',
	'SHOW STATUS',
	'DESCRIBE',
	'ON DUPLICATE KEY UPDATE',
	'REPLACE INTO',
	'INSERT IGNORE',
	'STRAIGHT_JOIN',
	'AUTO_INCREMENT',
	'ENGINE',
	'IFNULL',
	'GROUP_CONCAT',
	'JSON_EXTRACT',
	'NOW()',
	'CURDATE()',
	'UNIX_TIMESTAMP',
	'REGEXP'
];

export function sqlKeywords(dialect: StudioInfo['capabilities']['dialect']): string[] {
	if (dialect === 'postgres') return [...SQL_KEYWORDS, ...POSTGRES_KEYWORDS];
	if (dialect === 'mysql' || dialect === 'mariadb') {
		const extra = dialect === 'mariadb' ? ['RETURNING', 'SEQUENCE'] : [];
		return [...SQL_KEYWORDS, ...MYSQL_KEYWORDS, ...extra];
	}
	return [...SQL_KEYWORDS];
}

// ---------------------------------------------------------------- MongoDB

/** Command documents as snippets. `\\$` is a literal `$` inside a snippet. */
export const MONGO_COMMANDS: CompletionItem[] = [
	{
		label: 'find',
		kind: 'snippet',
		detail: 'Query documents',
		insertText: '{"find": "${1:collection}", "filter": {$2}, "limit": ${3:50}}'
	},
	{
		label: 'aggregate',
		kind: 'snippet',
		detail: 'Run an aggregation pipeline',
		insertText: '{"aggregate": "${1:collection}", "pipeline": [{"\\$match": {$2}}], "cursor": {}}'
	},
	{
		label: 'count',
		kind: 'snippet',
		detail: 'Count matching documents',
		insertText: '{"count": "${1:collection}", "query": {$2}}'
	},
	{
		label: 'distinct',
		kind: 'snippet',
		detail: 'Distinct values of a field',
		insertText: '{"distinct": "${1:collection}", "key": "${2:field}", "query": {$3}}'
	},
	{
		label: 'insert',
		kind: 'snippet',
		detail: 'Insert documents (write session)',
		insertText: '{"insert": "${1:collection}", "documents": [{$2}]}'
	},
	{
		label: 'update',
		kind: 'snippet',
		detail: 'Update documents (write session)',
		insertText:
			'{"update": "${1:collection}", "updates": [{"q": {$2}, "u": {"\\$set": {$3}}, "multi": ${4:false}}]}'
	},
	{
		label: 'delete',
		kind: 'snippet',
		detail: 'Delete documents (write session)',
		insertText: '{"delete": "${1:collection}", "deletes": [{"q": {$2}, "limit": ${3:1}}]}'
	},
	{
		label: 'listCollections',
		kind: 'snippet',
		detail: 'List collections',
		insertText: '{"listCollections": 1, "nameOnly": true}'
	},
	{
		label: 'listIndexes',
		kind: 'snippet',
		detail: "A collection's indexes",
		insertText: '{"listIndexes": "${1:collection}"}'
	},
	{
		label: 'collStats',
		kind: 'snippet',
		detail: 'Collection statistics',
		insertText: '{"collStats": "${1:collection}"}'
	},
	{ label: 'dbStats', kind: 'snippet', detail: 'Database statistics', insertText: '{"dbStats": 1}' },
	{ label: 'ping', kind: 'snippet', detail: 'Ping the server', insertText: '{"ping": 1}' },
	{ label: 'buildInfo', kind: 'snippet', detail: 'Server build', insertText: '{"buildInfo": 1}' },
	{
		label: 'serverStatus',
		kind: 'snippet',
		detail: 'Server status',
		insertText: '{"serverStatus": 1}'
	}
];

function mongoSource(database: string, call: CompletionCall): CompletionSource {
	const tree = lazyTree(database, call);
	return {
		async items({ prefix }) {
			const nodes = await safely(() => tree([]), []);
			const collections = nodes.filter((node) => OBJECT_KINDS.has(node.kind)).map(objectItem);
			return [...capped(collections, prefix), ...MONGO_COMMANDS];
		}
	};
}

// ---------------------------------------------------------------- Redis / Valkey

/**
 * A curated list: read-only sessions cannot run `COMMAND DOCS`, so the console does not depend
 * on it. `detail` carries the argument hint.
 */
const REDIS_COMMAND_HINTS: Array<[string, string]> = [
	['GET', 'key'],
	['SET', 'key value [EX seconds] [NX|XX]'],
	['MGET', 'key [key ...]'],
	['GETRANGE', 'key start end'],
	['STRLEN', 'key'],
	['INCR', 'key'],
	['INCRBY', 'key increment'],
	['DECR', 'key'],
	['APPEND', 'key value'],
	['DEL', 'key [key ...]'],
	['UNLINK', 'key [key ...]'],
	['EXISTS', 'key [key ...]'],
	['TYPE', 'key'],
	['TTL', 'key'],
	['PTTL', 'key'],
	['EXPIRE', 'key seconds'],
	['PERSIST', 'key'],
	['RENAME', 'key newkey'],
	['SCAN', 'cursor [MATCH pattern] [COUNT count] [TYPE type]'],
	['RANDOMKEY', ''],
	['DBSIZE', ''],
	['HGET', 'key field'],
	['HMGET', 'key field [field ...]'],
	['HGETALL', 'key'],
	['HSET', 'key field value [field value ...]'],
	['HDEL', 'key field [field ...]'],
	['HEXISTS', 'key field'],
	['HKEYS', 'key'],
	['HVALS', 'key'],
	['HLEN', 'key'],
	['HSCAN', 'key cursor [MATCH pattern] [COUNT count]'],
	['LRANGE', 'key start stop'],
	['LINDEX', 'key index'],
	['LLEN', 'key'],
	['LPUSH', 'key element [element ...]'],
	['RPUSH', 'key element [element ...]'],
	['LPOP', 'key [count]'],
	['RPOP', 'key [count]'],
	['LSET', 'key index element'],
	['SMEMBERS', 'key'],
	['SISMEMBER', 'key member'],
	['SCARD', 'key'],
	['SADD', 'key member [member ...]'],
	['SREM', 'key member [member ...]'],
	['SSCAN', 'key cursor [MATCH pattern] [COUNT count]'],
	['ZRANGE', 'key start stop [BYSCORE|BYLEX] [REV] [WITHSCORES]'],
	['ZRANGEBYSCORE', 'key min max [WITHSCORES] [LIMIT offset count]'],
	['ZSCORE', 'key member'],
	['ZRANK', 'key member'],
	['ZCARD', 'key'],
	['ZCOUNT', 'key min max'],
	['ZADD', 'key score member [score member ...]'],
	['ZREM', 'key member [member ...]'],
	['ZSCAN', 'key cursor [MATCH pattern] [COUNT count]'],
	['XRANGE', 'key start end [COUNT count]'],
	['XREVRANGE', 'key end start [COUNT count]'],
	['XLEN', 'key'],
	['XADD', 'key * field value [field value ...]'],
	['XINFO STREAM', 'key'],
	['PFCOUNT', 'key [key ...]'],
	['GEOPOS', 'key member [member ...]'],
	['OBJECT ENCODING', 'key'],
	['MEMORY USAGE', 'key'],
	['INFO', '[section]'],
	['PING', '[message]'],
	['ECHO', 'message'],
	['TIME', ''],
	['CLIENT LIST', ''],
	['CONFIG GET', 'parameter'],
	['SLOWLOG GET', '[count]']
];

export const REDIS_COMMANDS: CompletionItem[] = REDIS_COMMAND_HINTS.map(([label, args]) => ({
	label,
	kind: 'command',
	...(args ? { detail: args } : {}),
	insertText: `${label} `
}));

// ---------------------------------------------------------------- cursor context

/** An identifier, optionally quoted with "…" or `…`. */
const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|[A-Za-z_][\w$]*)`;
const QUALIFIED = new RegExp(String.raw`(${IDENT})\.([\w$]*)$`);
const WORD = /[\w$]*$/;

function unquote(name: string): string {
	return /^["`].*["`]$/.test(name) ? name.slice(1, -1) : name;
}

/**
 * What the cursor is completing, from the text before it on its line: the partial word and the
 * identifier before a `.` (`public.us` → `{ prefix: 'us', qualifier: 'public' }`).
 */
export function completionContext(lineBefore: string): { prefix: string; qualifier?: string } {
	const qualified = QUALIFIED.exec(lineBefore);
	if (qualified) return { prefix: qualified[2] ?? '', qualifier: unquote(qualified[1] ?? '') };
	return { prefix: WORD.exec(lineBefore)?.[0] ?? '' };
}

const SQL_RESERVED = new Set([
	'on',
	'where',
	'join',
	'inner',
	'left',
	'right',
	'full',
	'cross',
	'natural',
	'group',
	'order',
	'limit',
	'using',
	'set',
	'values',
	'union',
	'having',
	'window',
	'returning',
	'lateral'
]);

/**
 * Resolve a table alias in `text` (`FROM users u`, `JOIN orders AS o`) to its table name, so
 * `u.` completes the columns of `users`. Unknown qualifiers come back unchanged.
 */
export function resolveAlias(text: string, qualifier: string): string {
	const pattern = new RegExp(
		String.raw`\b(?:from|join|update|into)\s+((?:${IDENT}\.)?${IDENT})(?:\s+as)?\s+(${IDENT})`,
		'gi'
	);
	const wanted = qualifier.toLowerCase();
	for (const match of text.matchAll(pattern)) {
		const alias = unquote(match[2] ?? '');
		if (SQL_RESERVED.has(alias.toLowerCase())) continue;
		if (alias.toLowerCase() !== wanted) continue;
		const target = match[1] ?? '';
		const lastDot = target.match(new RegExp(String.raw`(${IDENT})$`));
		return unquote(lastDot?.[1] ?? target);
	}
	return qualifier;
}
