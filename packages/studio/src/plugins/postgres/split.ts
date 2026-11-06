/**
 * Postgres statement splitter for `run`. It follows the server's lexer (scan.l) for the
 * constructs that can hide a semicolon, and psql's rules for where a statement ends: a `;`
 * outside parentheses and outside a `BEGIN … END` SQL-standard function body.
 *
 * This is a usability layer, not a safety one: each statement is sent with the extended query
 * protocol, which refuses more than one command, so a split this lexer gets wrong fails loudly
 * instead of smuggling a second statement past the read-only wrapper.
 */

export interface SqlStatement {
	/** The statement text, without the terminating `;` and surrounding whitespace. */
	text: string;
	/** UTF-16 offset of `text` in the input. */
	start: number;
	/** Bare (unquoted) words, lower-cased, in order. Used to classify the statement. */
	words: string[];
}

const identStart = /[A-Za-z_\u0080-￿]/;
const identPart = /[A-Za-z0-9_$\u0080-￿]/;
const dollarTag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

export function splitStatements(input: string): SqlStatement[] {
	const statements: SqlStatement[] = [];
	let start = -1;
	let hasCode = false;
	let words: string[] = [];
	let parenDepth = 0;
	let beginDepth = 0;
	let i = 0;
	const n = input.length;

	const finish = (end: number) => {
		if (start >= 0) {
			const text = input.slice(start, end).trimEnd();
			if (hasCode) statements.push({ text, start, words });
		}
		start = -1;
		hasCode = false;
		words = [];
		parenDepth = 0;
		beginDepth = 0;
	};
	const mark = (at: number) => {
		if (start < 0) start = at;
	};

	while (i < n) {
		const ch = input[i] as string;
		const next = input[i + 1];

		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
			i += 1;
			continue;
		}
		if (ch === '-' && next === '-') {
			mark(i);
			const newline = input.indexOf('\n', i);
			i = newline < 0 ? n : newline + 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			mark(i);
			i = skipBlockComment(input, i);
			continue;
		}
		if (ch === ';') {
			if (parenDepth === 0 && beginDepth === 0) {
				finish(i);
				i += 1;
				continue;
			}
			i += 1;
			continue;
		}

		mark(i);
		hasCode = true;
		if (ch === "'") {
			i = skipQuoted(input, i, "'", false);
			continue;
		}
		if (ch === '"') {
			i = skipQuoted(input, i, '"', false);
			continue;
		}
		// Prefixed literals are matched before identifiers (longest match in scan.l).
		if ((ch === 'e' || ch === 'E') && next === "'") {
			i = skipQuoted(input, i + 1, "'", true);
			continue;
		}
		if ('bBxXnN'.includes(ch) && next === "'") {
			i = skipQuoted(input, i + 1, "'", false);
			continue;
		}
		if ((ch === 'u' || ch === 'U') && next === '&' && (input[i + 2] === "'" || input[i + 2] === '"')) {
			i = skipQuoted(input, i + 2, input[i + 2] as string, false);
			continue;
		}
		if (ch === '$') {
			if (next !== undefined && next >= '0' && next <= '9') {
				i += 1;
				while (i < n && /[0-9]/.test(input[i] as string)) i += 1;
				continue;
			}
			const tag = dollarTag.exec(input.slice(i, i + 256))?.[0];
			if (tag) {
				const close = input.indexOf(tag, i + tag.length);
				i = close < 0 ? n : close + tag.length;
				continue;
			}
			i += 1;
			continue;
		}
		if (identStart.test(ch)) {
			let j = i + 1;
			while (j < n && identPart.test(input[j] as string)) j += 1;
			const word = input.slice(i, j).toLowerCase();
			words.push(word);
			beginDepth = trackBegin(words, word, parenDepth, beginDepth);
			i = j;
			continue;
		}
		if (ch >= '0' && ch <= '9') {
			let j = i + 1;
			while (j < n && /[0-9A-Za-z_.]/.test(input[j] as string)) j += 1;
			i = j;
			continue;
		}
		if (ch === '(') parenDepth += 1;
		else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
		i += 1;
	}
	finish(n);
	return statements;
}

/**
 * psql's heuristic for `CREATE [OR REPLACE] {FUNCTION|PROCEDURE} … BEGIN ATOMIC … END`: inside
 * such a statement, BEGIN (and CASE once inside a BEGIN) opens a block and END closes one.
 */
function trackBegin(words: string[], word: string, parenDepth: number, depth: number): number {
	if (parenDepth !== 0 || words[0] !== 'create') return depth;
	const routine =
		words[1] === 'function' ||
		words[1] === 'procedure' ||
		(words[1] === 'or' && words[2] === 'replace' && (words[3] === 'function' || words[3] === 'procedure'));
	if (!routine) return depth;
	if (word === 'begin') return depth + 1;
	if (word === 'case') return depth >= 1 ? depth + 1 : depth;
	if (word === 'end') return depth > 0 ? depth - 1 : depth;
	return depth;
}

function skipBlockComment(input: string, from: number): number {
	// Postgres block comments nest.
	let depth = 0;
	let i = from;
	while (i < input.length) {
		if (input[i] === '/' && input[i + 1] === '*') {
			depth += 1;
			i += 2;
		} else if (input[i] === '*' && input[i + 1] === '/') {
			depth -= 1;
			i += 2;
			if (depth === 0) return i;
		} else i += 1;
	}
	return input.length;
}

/**
 * Skip a quoted run that opens at `from`. A doubled quote is an escaped quote. `backslash`
 * is true for E'' strings, where `\` escapes the next character. Ordinary strings follow
 * `standard_conforming_strings = on`, which the session pins at connect.
 */
function skipQuoted(input: string, from: number, quote: string, backslash: boolean): number {
	let i = from + 1;
	while (i < input.length) {
		const ch = input[i];
		if (backslash && ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === quote) {
			if (input[i + 1] === quote) {
				i += 2;
				continue;
			}
			return i + 1;
		}
		i += 1;
	}
	return input.length;
}

// ---------------------------------------------------------------- classification

const selectStarts = new Set(['select', 'with', 'values', 'table']);
const dataModifying = new Set(['insert', 'update', 'delete', 'merge']);

/** SELECT / WITH … SELECT / VALUES / TABLE: statements that return rows and only read. */
export function isSelectLike(statement: SqlStatement): boolean {
	return selectStarts.has(statement.words[0] ?? '');
}

/**
 * Whether the statement can run as `DECLARE … CURSOR FOR`, so it streams. The server refuses
 * data-modifying CTEs and `SELECT … INTO` in a cursor; this check is conservative (a column
 * named `update` falls back to a direct, buffered run, which is still correct).
 */
export function isStreamable(statement: SqlStatement): boolean {
	if (!isSelectLike(statement)) return false;
	for (const word of statement.words) {
		if (word === 'into') return false;
		if (dataModifying.has(word)) return false;
	}
	return true;
}

export type TransactionEffect = 'begin' | 'end' | null;

/** How a statement changes the transaction state of a write session (tracked, not queried). */
export function transactionEffect(statement: SqlStatement): TransactionEffect {
	const [first, second, third] = statement.words;
	switch (first) {
		case 'begin':
		case 'start':
			return 'begin';
		case 'commit':
		case 'end':
		case 'abort':
			// COMMIT AND CHAIN starts a new transaction straight away.
			return statement.words.includes('chain') && !statement.words.includes('no') ? 'begin' : 'end';
		case 'rollback':
			if (second === 'to' || (second === 'work' && third === 'to') || (second === 'transaction' && third === 'to'))
				return null;
			if (second === 'prepared') return null;
			return statement.words.includes('chain') && !statement.words.includes('no') ? 'begin' : 'end';
		case 'prepare':
			return second === 'transaction' ? 'end' : null;
		default:
			return null;
	}
}
