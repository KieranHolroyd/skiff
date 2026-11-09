/**
 * Environment-variable suggestions for a workload (the Railway "suggested variables" idea).
 *
 * Three things feed the list:
 * - names the platform already injects for attached databases and object storage;
 * - names from organisation secrets;
 * - names found in the release's `.env*` files and source code.
 *
 * The helpers in this module are pure so the dashboard, API and agent can share the same
 * detection without shelling out or reimplementing the patterns.
 */

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Prefixes are injected as `<PREFIX>_URL` and must already be UPPER_SNAKE. */
const UPPER_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export type EnvSuggestionSource =
	| 'database'
	| 'storage'
	| 'user-pool'
	| 'secret'
	| 'env-file'
	| 'code'
	| 'common';

export interface EnvSuggestion {
	name: string;
	source: EnvSuggestionSource;
	/** Where it came from, shown as a tooltip: a database name, `.env.example`, `src/server.ts`, … */
	detail: string;
	/**
	 * True when the platform injects this name at activation (a database or storage attachment).
	 * Adding it to the plain spec would shadow the injected value, so the dashboard does not add it.
	 */
	injected: boolean;
}

/** One name found by scanning a release. */
export interface DetectedEnvName {
	name: string;
	source: 'env-file' | 'code';
	/** File the name was found in. */
	detail: string;
}

export interface EnvSuggestionInput {
	databases?: Array<{ name: string; envNames: string[] }>;
	storage?: Array<{ name: string; envNames: string[] }>;
	/** Attached user pools: `<P>_ISSUER`, `<P>_CLIENT_ID`, `<P>_CLIENT_SECRET` (IAM.md I28). */
	userPools?: Array<{ name: string; envNames: string[] }>;
	secretNames?: string[];
	detected?: DetectedEnvName[];
	/** Include the small curated list of common names (default true). */
	includeCommon?: boolean;
}

/** A few names worth offering next to the detected ones. Deliberately short: noise hides signal. */
export const COMMON_ENV_SUGGESTIONS: ReadonlyArray<{
	name: string;
	detail: string;
}> = [
	{ name: 'NODE_ENV', detail: 'Runtime mode, usually production' },
	{ name: 'LOG_LEVEL', detail: 'Logging verbosity' },
	{ name: 'TZ', detail: 'Container time zone' },
	{ name: 'APP_URL', detail: 'Public base URL of the app' },
	{ name: 'CORS_ORIGIN', detail: 'Allowed browser origins' }
];

/**
 * Merge every suggestion source, first occurrence wins. Injected names come first so a `.env`
 * file that mentions `DATABASE_URL` never produces a second, shadowing spec entry.
 */
export function buildEnvSuggestions(input: EnvSuggestionInput): EnvSuggestion[] {
	const out: EnvSuggestion[] = [];
	const seen = new Set<string>();
	const add = (
		name: string,
		source: EnvSuggestionSource,
		detail: string,
		injected: boolean
	): void => {
		if (!ENV_NAME.test(name) || seen.has(name)) return;
		seen.add(name);
		out.push({ name, source, detail, injected });
	};

	for (const database of input.databases ?? []) {
		for (const name of database.envNames) add(name, 'database', database.name, true);
	}
	for (const storage of input.storage ?? []) {
		for (const name of storage.envNames) add(name, 'storage', storage.name, true);
	}
	for (const pool of input.userPools ?? []) {
		for (const name of pool.envNames) add(name, 'user-pool', pool.name, true);
	}
	for (const name of input.secretNames ?? []) add(name, 'secret', 'Organisation secret', false);
	for (const item of input.detected ?? []) add(item.name, item.source, item.detail, false);
	if (input.includeCommon !== false) {
		for (const item of COMMON_ENV_SUGGESTIONS) add(item.name, 'common', item.detail, false);
	}
	return out;
}

/** `.env`, `.env.local`, `.env.production`, `.env.example`, `env.example`, … */
export function isEnvFileName(path: string): boolean {
	const name = path.split('/').pop() ?? '';
	return (
		name === '.env' || name.startsWith('.env.') || name === 'env.example' || name === 'env.sample'
	);
}

/** Parse `KEY=value`, `export KEY=value` and commented `.env` files. Values are never returned. */
export function parseEnvFileNames(text: string, limit = 100): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		const name = match?.[1];
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
		if (names.length >= limit) break;
	}
	return names;
}

export interface EnvFileEntry {
	key: string;
	value: string;
}

export interface EnvFileParseResult {
	/** In file order; a key that appears twice keeps its last value, as dotenv does. */
	entries: EnvFileEntry[];
	/** 1-based line numbers that are not `KEY=value`, comments or blank. */
	invalidLines: number[];
}

const ENV_ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/s;

function unescapeDoubleQuoted(value: string): string {
	return value.replace(/\\([nrt"\\])/g, (_, char: string) =>
		char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char
	);
}

/**
 * Parse `.env` text into keys and values, following the common dotenv rules: `export` prefixes,
 * `#` comments, single quotes kept literally, double quotes with `\n` escapes and multi-line
 * values, and an unquoted value ending at ` #`. No `${VAR}` expansion: values are stored as typed.
 */
export function parseEnvFile(text: string): EnvFileParseResult {
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
	const values = new Map<string, string>();
	const invalidLines: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!.trim();
		if (!line || line.startsWith('#')) continue;
		const match = ENV_ASSIGNMENT.exec(line);
		if (!match) {
			invalidLines.push(index + 1);
			continue;
		}
		const key = match[1]!;
		let raw = match[2]!;
		const quote = raw[0];
		let value: string;
		if (quote === '"' || quote === "'" || quote === '`') {
			// A quoted value may continue over the following lines until its closing quote.
			let body = raw.slice(1);
			let end = findClosingQuote(body, quote);
			const start = index;
			while (end === -1 && index + 1 < lines.length) {
				index++;
				body += '\n' + lines[index]!;
				end = findClosingQuote(body, quote);
			}
			if (end === -1) {
				invalidLines.push(start + 1);
				continue;
			}
			body = body.slice(0, end);
			value = quote === '"' ? unescapeDoubleQuoted(body) : body;
		} else {
			const comment = raw.search(/\s#/);
			if (comment !== -1) raw = raw.slice(0, comment);
			value = raw.trim();
		}
		values.delete(key);
		values.set(key, value);
	}
	return { entries: [...values].map(([key, value]) => ({ key, value })), invalidLines };
}

function findClosingQuote(body: string, quote: string): number {
	for (let index = 0; index < body.length; index++) {
		if (quote === '"' && body[index] === '\\') {
			index++;
			continue;
		}
		if (body[index] === quote) return index;
	}
	return -1;
}

/** Serialise entries as `.env` text that `parseEnvFile` reads back unchanged. */
export function formatEnvFile(entries: Iterable<EnvFileEntry>): string {
	const lines: string[] = [];
	for (const { key, value } of entries) {
		const plain = /^[A-Za-z0-9_./:@%+,-]*$/.test(value);
		const quoted = value
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\n/g, '\\n')
			.replace(/\r/g, '\\r')
			.replace(/\t/g, '\\t');
		lines.push(`${key}=${plain ? value : `"${quoted}"`}`);
	}
	return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Names the container/agent environment is expected to define already. They are noise in a
 * suggestion list: the user configures the app, not the OS.
 */
const SYSTEM_ENV_NAMES = new Set([
	'PATH',
	'HOME',
	'PWD',
	'OLDPWD',
	'USER',
	'USERNAME',
	'SHELL',
	'TERM',
	'HOSTNAME',
	'LANG',
	'LC_ALL',
	'TMPDIR',
	'TEMP',
	'TMP',
	'SHLVL',
	'_'
]);

/**
 * Recognised access patterns. Every pattern captures the variable name as group 1 and only
 * matches UPPER_SNAKE names, so dynamic access (`process.env[name]`) is deliberately ignored.
 */
const ACCESS_PATTERNS: ReadonlyArray<RegExp> = [
	/\b(?:process|Bun)\.env\.([A-Z][A-Z0-9_]*)\b/g,
	/\b(?:process|Bun)\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
	/\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g,
	/\bimport\.meta\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
	/\bDeno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
	/\bos\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
	/\bos\.environ\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
	/\bos\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
	/\bgetenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g,
	/\bEnvironment\.GetEnvironmentVariable\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/gi,
	/\bENV\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
	/\benv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g
];

const MAX_SCAN_CHARS = 256_000;

/** Find environment-variable names used by source code. Bounded so a minified bundle is cheap. */
export function detectEnvNames(text: string, limit = 100): string[] {
	const source = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
	const names: string[] = [];
	const seen = new Set<string>();
	for (const pattern of ACCESS_PATTERNS) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(source)) !== null) {
			const name = match[1];
			if (!name || SYSTEM_ENV_NAMES.has(name) || seen.has(name)) continue;
			seen.add(name);
			names.push(name);
			if (names.length >= limit) return names;
		}
	}
	return names;
}

// `URI`: MongoDB apps read `MONGODB_URI`, which MongoDB attachments also receive (D95).
const DATABASE_SUFFIXES = ['URL', 'URI', 'HOST', 'PORT', 'USER', 'PASSWORD', 'NAME'] as const;
const STORAGE_SUFFIXES = [
	'PUBLIC_ENDPOINT_URL',
	'ENDPOINT_URL',
	'ACCESS_KEY_ID',
	'SECRET_ACCESS_KEY',
	'FORCE_PATH_STYLE',
	'REGION',
	'BUCKET'
] as const;

/** `DATABASE_URL` → `DATABASE`; null when the name is not a database connection variable. */
export function databasePrefixFromEnvName(name: string): string | null {
	// `S3_ENDPOINT_URL` also ends in `_URL`; storage patterns win before database inference.
	if (storagePrefixFromEnvName(name) !== null) return null;
	const upper = name.toUpperCase();
	for (const suffix of DATABASE_SUFFIXES) {
		const marker = `_${suffix}`;
		if (!upper.endsWith(marker)) continue;
		const prefix = upper.slice(0, -marker.length);
		if (UPPER_ENV_NAME.test(prefix)) return prefix;
	}
	return null;
}

/** Prefixes that unambiguously mean "a database", even with only one matching variable. */
const KNOWN_DATABASE_PREFIXES = new Set([
	'DATABASE',
	'DB',
	'PG',
	'POSTGRES',
	'POSTGRESQL',
	'MYSQL',
	'MARIADB',
	'MONGO',
	'MONGODB',
	'REDIS',
	'VALKEY',
	'CLICKHOUSE'
]);

/** Prefixes that unambiguously mean "object storage", even with one matching variable. */
const KNOWN_STORAGE_PREFIXES = new Set([
	'S3',
	'AWS',
	'R2',
	'MINIO',
	'BUCKET',
	'STORAGE',
	'OBJECT_STORAGE'
]);

function prefixesFromEnvNames(
	names: Iterable<string>,
	prefixOf: (name: string) => string | null,
	known: Set<string>
): string[] {
	const groups = new Map<string, Set<string>>();
	for (const name of names) {
		const prefix = prefixOf(name);
		if (!prefix) continue;
		const suffix = name.toUpperCase().slice(prefix.length + 1);
		const suffixes = groups.get(prefix) ?? new Set<string>();
		suffixes.add(suffix);
		groups.set(prefix, suffixes);
	}
	return [...groups]
		.filter(([prefix, suffixes]) => known.has(prefix) || suffixes.size >= 2)
		.map(([prefix]) => prefix)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Prefixes a set of names genuinely points at. A lone `APP_URL` is not a database, but
 * `DATABASE_URL` is, and `SHOP_URL` + `SHOP_HOST` together are too.
 */
export function databasePrefixesFromEnvNames(names: Iterable<string>): string[] {
	return prefixesFromEnvNames(names, databasePrefixFromEnvName, KNOWN_DATABASE_PREFIXES);
}

/** The storage equivalent: `S3_BUCKET` alone is enough; a custom prefix needs two names. */
export function storagePrefixesFromEnvNames(names: Iterable<string>): string[] {
	return prefixesFromEnvNames(names, storagePrefixFromEnvName, KNOWN_STORAGE_PREFIXES);
}

/** `S3_ENDPOINT_URL` → `S3`, `AWS_ACCESS_KEY_ID` → `AWS`; null for other names. */
export function storagePrefixFromEnvName(name: string): string | null {
	const upper = name.toUpperCase();
	for (const suffix of STORAGE_SUFFIXES) {
		const marker = `_${suffix}`;
		if (!upper.endsWith(marker)) continue;
		const prefix = upper.slice(0, -marker.length);
		if (UPPER_ENV_NAME.test(prefix)) return prefix;
	}
	return null;
}

/** `DATABASE` if free, else `DATABASE_2`, `DATABASE_3`, … — matches the attach dialogs. */
export function nextEnvPrefix(base: string, used: Iterable<string>): string {
	const taken = new Set(used);
	if (!taken.has(base)) return base;
	for (let index = 2; ; index++) {
		const candidate = `${base}_${index}`;
		if (!taken.has(candidate)) return candidate;
	}
}
