/**
 * The command gate for `run` (plan 22 "Safety and limits"). Redis cannot cancel a running
 * command and has no read-only transaction, so this is the second layer under the credential:
 *
 * - Some commands are refused in every session: they block the shared connection, change its
 *   state (SELECT, MULTI, SUBSCRIBE, CLIENT), administer the server, or run scripts that the
 *   gate cannot inspect.
 * - A read-only session also requires the `readonly` flag from `COMMAND INFO`. When the
 *   credential may not run `COMMAND INFO` (the Phase 3 `+@read` principal), a static allowlist
 *   of read commands stands in, failing closed for anything it does not know.
 * - `FLUSHALL`/`FLUSHDB` pass in write sessions with a warning.
 */

export type GateDecision =
	| { allow: true; warning?: string }
	| { allow: false; code: 'read_only' | 'forbidden' | 'bad_request'; message: string };

/** `COMMAND INFO` result for one command: its flags and those of its subcommands. */
export interface CommandSpec {
	flags: string[];
	subcommands: Map<string, string[]>;
}

const BLOCKING = [
	'BLPOP',
	'BRPOP',
	'BRPOPLPUSH',
	'BLMOVE',
	'BLMPOP',
	'BZPOPMIN',
	'BZPOPMAX',
	'BZMPOP',
	'WAIT',
	'WAITAOF',
	'MONITOR',
] as const;
const PUBSUB = ['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'UNSUBSCRIBE', 'PUNSUBSCRIBE', 'SUNSUBSCRIBE'] as const;
const SCRIPTING = ['EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO', 'FCALL', 'FCALL_RO', 'SCRIPT', 'FUNCTION'] as const;
const CONNECTION_STATE = [
	'MULTI',
	'EXEC',
	'DISCARD',
	'WATCH',
	'UNWATCH',
	'SELECT',
	'AUTH',
	'HELLO',
	'RESET',
	'QUIT',
	'READONLY',
	'READWRITE',
	'ASKING',
	'CLIENT',
] as const;
const ADMIN = [
	'DEBUG',
	'CONFIG',
	'ACL',
	'SHUTDOWN',
	'SYNC',
	'PSYNC',
	'SAVE',
	'BGSAVE',
	'BGREWRITEAOF',
	'REPLICAOF',
	'SLAVEOF',
	'FAILOVER',
	'CLUSTER',
	'MODULE',
	'SWAPDB',
	'MOVE',
	'MIGRATE',
] as const;

/** Why each always-refused command is refused, for the error message. */
const DENIED = new Map<string, string>([
	['KEYS', 'KEYS blocks the server on large keyspaces; use SCAN 0 MATCH <pattern> instead.'],
	...BLOCKING.map((c): [string, string] => [c, `${c} blocks the connection and is not available in the studio.`]),
	...PUBSUB.map((c): [string, string] => [c, `${c} switches the connection to pub/sub and is not available in the studio.`]),
	...SCRIPTING.map((c): [string, string] => [c, `${c} runs scripts the studio cannot check; it is not available here.`]),
	...CONNECTION_STATE.map((c): [string, string] => [
		c,
		`${c} changes the shared studio connection and is not available here.`,
	]),
	...ADMIN.map((c): [string, string] => [c, `${c} administers the server and is not available in the studio.`]),
]);

const FLUSH = new Set(['FLUSHALL', 'FLUSHDB']);

/**
 * Read commands accepted in a read-only session when `COMMAND INFO` is unavailable. It is
 * deliberately conservative: a module or new command is refused until the credential can
 * describe it, and the ACL is still the layer that really decides.
 */
export const STATIC_READ_COMMANDS: ReadonlySet<string> = new Set([
	'GET',
	'MGET',
	'GETRANGE',
	'SUBSTR',
	'STRLEN',
	'LCS',
	'EXISTS',
	'TYPE',
	'TTL',
	'PTTL',
	'EXPIRETIME',
	'PEXPIRETIME',
	'SCAN',
	'DBSIZE',
	'RANDOMKEY',
	'TOUCH',
	'DUMP',
	'OBJECT',
	'MEMORY',
	'HGET',
	'HMGET',
	'HGETALL',
	'HKEYS',
	'HVALS',
	'HLEN',
	'HEXISTS',
	'HSTRLEN',
	'HSCAN',
	'HRANDFIELD',
	'HTTL',
	'HPTTL',
	'LRANGE',
	'LINDEX',
	'LLEN',
	'LPOS',
	'SMEMBERS',
	'SISMEMBER',
	'SMISMEMBER',
	'SCARD',
	'SSCAN',
	'SRANDMEMBER',
	'SINTER',
	'SINTERCARD',
	'SUNION',
	'SDIFF',
	'ZRANGE',
	'ZRANGEBYSCORE',
	'ZRANGEBYLEX',
	'ZREVRANGE',
	'ZREVRANGEBYSCORE',
	'ZREVRANGEBYLEX',
	'ZSCORE',
	'ZMSCORE',
	'ZCARD',
	'ZCOUNT',
	'ZLEXCOUNT',
	'ZRANK',
	'ZREVRANK',
	'ZSCAN',
	'ZRANDMEMBER',
	'ZINTER',
	'ZINTERCARD',
	'ZUNION',
	'ZDIFF',
	'XRANGE',
	'XREVRANGE',
	'XLEN',
	'XINFO',
	'XPENDING',
	'XREAD',
	'GETBIT',
	'BITCOUNT',
	'BITPOS',
	'BITFIELD_RO',
	'PFCOUNT',
	'GEOPOS',
	'GEODIST',
	'GEOHASH',
	'GEOSEARCH',
	'GEORADIUS_RO',
	'GEORADIUSBYMEMBER_RO',
	'SORT_RO',
]);

/**
 * Commands that change nothing but carry no `readonly` flag in `COMMAND INFO` (PING is flagged
 * only `fast`/`stale`). A read-only session allows them unless the server flags them `write`.
 */
export const HARMLESS_COMMANDS: ReadonlySet<string> = new Set(['PING', 'ECHO', 'TIME', 'DBSIZE', 'LASTSAVE', 'INFO']);

/** Subcommands of the static containers above that only read. */
const STATIC_READ_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['OBJECT', new Set(['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT', 'HELP'])],
	['MEMORY', new Set(['USAGE', 'HELP'])],
	['XINFO', new Set(['STREAM', 'GROUPS', 'CONSUMERS', 'HELP'])],
]);

/**
 * Decide whether `argv` may run.
 *
 * `flags` is the command's (or subcommand's) `COMMAND INFO` flags; `null` when the server does
 * not know the command; `undefined` when `COMMAND INFO` itself is not available to the session.
 */
export function gateCommand(argv: readonly string[], flags: readonly string[] | null | undefined, readOnly: boolean): GateDecision {
	const name = (argv[0] ?? '').toUpperCase();
	if (!name) return { allow: false, code: 'bad_request', message: 'Enter a command.' };
	const sub = (argv[1] ?? '').toUpperCase();

	const denied = DENIED.get(name);
	if (denied) return { allow: false, code: 'forbidden', message: denied };
	if ((name === 'XREAD' || name === 'XREADGROUP') && argv.some((a) => a.toUpperCase() === 'BLOCK'))
		return { allow: false, code: 'forbidden', message: `${name} … BLOCK blocks the connection; drop BLOCK to read once.` };
	if (name === 'COPY' && argv.some((a) => a.toUpperCase() === 'DB'))
		return { allow: false, code: 'forbidden', message: 'COPY … DB reaches outside this database.' };

	if (flags) {
		// XREAD without BLOCK carries the `blocking` flag but returns at once.
		if (flags.includes('blocking') && name !== 'XREAD' && name !== 'XREADGROUP')
			return { allow: false, code: 'forbidden', message: `${name} can block the connection and is not available in the studio.` };
		if (flags.includes('admin'))
			return { allow: false, code: 'forbidden', message: `${commandLabel(name, sub)} administers the server and is not available in the studio.` };
	}

	if (readOnly) {
		const refuse: GateDecision = {
			allow: false,
			code: 'read_only',
			message: `${commandLabel(name, sub)} is not a read-only command; this studio session is read-only.`,
		};
		if (FLUSH.has(name)) return refuse;
		if (flags === null) return { ...refuse, message: `Unknown command ${name}; this studio session is read-only.` };
		if (flags === undefined) {
			if (HARMLESS_COMMANDS.has(name)) return { allow: true };
			if (!STATIC_READ_COMMANDS.has(name)) return refuse;
			const subs = STATIC_READ_SUBCOMMANDS.get(name);
			if (subs && !subs.has(sub)) return refuse;
			return { allow: true };
		}
		if (flags.includes('readonly')) return { allow: true };
		return HARMLESS_COMMANDS.has(name) && !flags.includes('write') ? { allow: true } : refuse;
	}

	if (FLUSH.has(name))
		return {
			allow: true,
			warning:
				name === 'FLUSHALL'
					? 'FLUSHALL removes every key in every database of this instance.'
					: 'FLUSHDB removes every key in this database.',
		};
	return { allow: true };
}

function commandLabel(name: string, sub: string): string {
	return sub && STATIC_READ_SUBCOMMANDS.has(name) ? `${name} ${sub}` : name;
}

/**
 * Parse a `COMMAND INFO a b c` reply into specs keyed by lower-case name. Entries are
 * `[name, arity, flags, first, last, step, categories, tips, keySpecs, subcommands]`, and an
 * unknown command is `null`.
 */
export function parseCommandInfo(names: readonly string[], reply: unknown): Map<string, CommandSpec | null> {
	const out = new Map<string, CommandSpec | null>();
	const entries = Array.isArray(reply) ? reply : [];
	names.forEach((name, index) => {
		const entry = entries[index];
		if (!Array.isArray(entry)) {
			out.set(name.toLowerCase(), null);
			return;
		}
		const subcommands = new Map<string, string[]>();
		const subs = Array.isArray(entry[9]) ? entry[9] : [];
		for (const sub of subs) {
			if (!Array.isArray(sub) || typeof sub[0] !== 'string') continue;
			// Subcommands are named `container|sub`.
			const subName = sub[0].split('|')[1] ?? sub[0];
			subcommands.set(subName.toLowerCase(), flagList(sub[2]));
		}
		out.set(String(entry[0] ?? name).toLowerCase(), { flags: flagList(entry[2]), subcommands });
	});
	return out;
}

/** Flags that apply to `argv`: the subcommand's when the command is a container. */
export function flagsFor(spec: CommandSpec | null, argv: readonly string[]): string[] | null {
	if (!spec) return null;
	if (spec.subcommands.size === 0) return spec.flags;
	const sub = (argv[1] ?? '').toLowerCase();
	// An unknown subcommand gets no flags, so a read-only session refuses it.
	return spec.subcommands.get(sub) ?? [];
}

function flagList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string').map((f) => f.toLowerCase()) : [];
}
