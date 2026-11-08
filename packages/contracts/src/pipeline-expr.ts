import type { PipelineExpressionContext, PipelineStatusState } from './pipeline.ts';

/**
 * The `${{ }}` expression language of Pipelines (docs/PIPELINES.md §5.3, W2).
 *
 * A tokenizer, a recursive-descent parser and a tree-walking evaluator that follow GitHub Actions'
 * semantics (https://docs.github.com/en/actions/reference/workflows-and-actions/expressions):
 * loose equality with number coercion, case-insensitive string comparison and property lookup,
 * `&&`/`||` returning operand values, object filters (`a.*.b`) and the documented function set.
 *
 * Pure TypeScript with no runtime dependencies: it runs in the control plane (job `if:`, matrix
 * and `runs-on` templates), the in-job step runner (step `if:`, `run:`, `with:`, `env:`) and the
 * dashboard (lint). There is deliberately no `eval`: every value an expression can produce comes
 * from a literal, the context, or one of the functions below. Every failure is a
 * `PipelineExpressionError`, so callers can turn it into a step/job failure with one catch.
 */

export class PipelineExpressionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PipelineExpressionError';
	}
}

export interface PipelineEvalOptions {
	/** Job/step status for `success()`, `failure()`, `cancelled()`; default: nothing failed. */
	status?: PipelineStatusState;
	/** File hasher behind `hashFiles()`; only the step runner (which has a workspace) provides one. */
	hashFiles?: (patterns: string[]) => string;
}

/** GitHub's limits: longer or deeper expressions are rejected rather than risk the stack. */
const MAX_EXPRESSION_LENGTH = 21_000;
const MAX_DEPTH = 50;

/** Named contexts (lowercase). `github` is accepted and evaluated as `skiff` (W1). */
const CONTEXT_NAMES = new Set([
	'skiff',
	'github',
	'env',
	'vars',
	'secrets',
	'inputs',
	'matrix',
	'strategy',
	'needs',
	'steps',
	'job',
	'runner',
	// Only in `on.workflow_call.outputs`: the called workflow's jobs.
	'jobs',
]);

/** Function names (lowercase; GitHub matches them case-insensitively) → [min, max] arity. */
const FUNCTIONS: Readonly<Record<string, readonly [number, number]>> = {
	contains: [2, 2],
	startswith: [2, 2],
	endswith: [2, 2],
	format: [1, Number.POSITIVE_INFINITY],
	join: [1, 2],
	tojson: [1, 1],
	fromjson: [1, 1],
	hashfiles: [1, Number.POSITIVE_INFINITY],
	success: [0, 0],
	failure: [0, 0],
	always: [0, 0],
	cancelled: [0, 0],
};

const STATUS_FUNCTIONS = new Set(['success', 'failure', 'always', 'cancelled']);

// --- tokenizer ---------------------------------------------------------------------------

type TokenKind =
	| 'lparen'
	| 'rparen'
	| 'lbracket'
	| 'rbracket'
	| 'comma'
	| 'dot'
	| 'star'
	| 'op'
	| 'string'
	| 'number'
	| 'word';

interface Token {
	kind: TokenKind;
	/** Operator text, word, or decoded string literal. */
	text: string;
	num: number;
	pos: number;
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isWordStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_-]/.test(c);

/** Tokens after which `.` is a dereference rather than the start of a number like `.5`. */
const VALUE_END: ReadonlySet<TokenKind> = new Set(['word', 'rparen', 'rbracket', 'star', 'string', 'number']);

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	const push = (kind: TokenKind, text: string, pos: number, num = 0): void => {
		tokens.push({ kind, text, num, pos });
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		const next = src[i + 1];
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			i++;
			continue;
		}
		const start = i;
		switch (c) {
			case '(':
				push('lparen', c, start);
				i++;
				continue;
			case ')':
				push('rparen', c, start);
				i++;
				continue;
			case '[':
				push('lbracket', c, start);
				i++;
				continue;
			case ']':
				push('rbracket', c, start);
				i++;
				continue;
			case ',':
				push('comma', c, start);
				i++;
				continue;
			case '*':
				push('star', c, start);
				i++;
				continue;
			case '!':
			case '<':
			case '>':
				if (next === '=') {
					push('op', c + '=', start);
					i += 2;
				} else {
					push('op', c, start);
					i++;
				}
				continue;
			case '=':
				if (next !== '=') throw unexpected(src, start);
				push('op', '==', start);
				i += 2;
				continue;
			case '&':
			case '|':
				if (next !== c) throw unexpected(src, start);
				push('op', c + c, start);
				i += 2;
				continue;
			case "'": {
				let value = '';
				let j = i + 1;
				for (;;) {
					if (j >= src.length) throw new PipelineExpressionError(`Unterminated string literal at position ${start + 1}: ${src}`);
					const d = src[j]!;
					if (d === "'") {
						if (src[j + 1] === "'") {
							value += "'";
							j += 2;
							continue;
						}
						break;
					}
					value += d;
					j++;
				}
				push('string', value, start);
				i = j + 1;
				continue;
			}
		}
		const prev = tokens[tokens.length - 1];
		if (c === '.' && prev && VALUE_END.has(prev.kind)) {
			push('dot', c, start);
			i++;
			continue;
		}
		const startsNumber =
			isDigit(c) ||
			(c === '.' && isDigit(next)) ||
			((c === '-' || c === '+') && (isDigit(next) || (next === '.' && isDigit(src[i + 2]))));
		if (startsNumber) {
			let j = i + 1;
			while (j < src.length) {
				const d = src[j]!;
				const isExponentSign = (d === '-' || d === '+') && /[eE]/.test(src[j - 1]!) && !/^[+-]?0x/i.test(src.slice(i, j));
				if (/[A-Za-z0-9_.]/.test(d) || isExponentSign) j++;
				else break;
			}
			const text = src.slice(i, j);
			const num = parseNumber(text);
			if (Number.isNaN(num)) throw new PipelineExpressionError(`Unexpected symbol '${text}' at position ${start + 1}: ${src}`);
			push('number', text, start, num);
			i = j;
			continue;
		}
		if (isWordStart(c)) {
			let j = i + 1;
			while (isWordChar(src[j])) j++;
			push('word', src.slice(i, j), start);
			i = j;
			continue;
		}
		throw unexpected(src, start);
	}
	return tokens;
}

function unexpected(src: string, pos: number): PipelineExpressionError {
	return new PipelineExpressionError(`Unexpected symbol '${src[pos] ?? ''}' at position ${pos + 1}: ${src}`);
}

/**
 * GitHub's string → number conversion (also used for number literals): JSON-style decimals with
 * an optional exponent, `0x` hex and `0o` octal, surrounding whitespace allowed, `''` → 0, and
 * anything else NaN.
 */
function parseNumber(text: string): number {
	const s = text.trim();
	if (s === '') return 0;
	const radix = /^([+-]?)0([xo])([0-9a-f]+)$/i.exec(s);
	if (radix) {
		const base = radix[2]!.toLowerCase() === 'x' ? 16 : 8;
		const digits = radix[3]!;
		if (base === 8 && /[89a-f]/i.test(digits)) return Number.NaN;
		const value = Number.parseInt(digits, base);
		return radix[1] === '-' ? -value : value;
	}
	if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
	if (s === 'Infinity' || s === '+Infinity') return Number.POSITIVE_INFINITY;
	if (s === '-Infinity') return Number.NEGATIVE_INFINITY;
	return Number.NaN;
}

// --- parser ------------------------------------------------------------------------------

type Literal = null | boolean | number | string;

type Node =
	| { k: 'lit'; v: Literal }
	| { k: 'ctx'; name: string }
	| { k: 'prop'; target: Node; name: string }
	| { k: 'index'; target: Node; index: Node }
	| { k: 'star'; target: Node }
	| { k: 'not'; arg: Node }
	| { k: 'bin'; op: string; left: Node; right: Node }
	| { k: 'call'; name: string; args: Node[] };

const KEYWORDS: Readonly<Record<string, Literal>> = {
	true: true,
	false: false,
	null: null,
	NaN: Number.NaN,
	Infinity: Number.POSITIVE_INFINITY,
};

/** Precedence climbing table, loosest first (GitHub: `||`, `&&`, `== !=`, `< <= > >=`). */
const BINARY_LEVELS: readonly (readonly string[])[] = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>=']];

class Parser {
	private pos = 0;
	private depth = 0;

	constructor(
		private readonly src: string,
		private readonly tokens: Token[],
	) {}

	parse(): Node {
		if (this.tokens.length === 0) throw new PipelineExpressionError('Expected an expression');
		const node = this.expression();
		const extra = this.tokens[this.pos];
		if (extra) throw this.error(`Unexpected '${extra.text}'`, extra);
		return node;
	}

	private expression(): Node {
		if (++this.depth > MAX_DEPTH) throw new PipelineExpressionError(`Expression nests deeper than ${MAX_DEPTH} levels: ${this.src}`);
		const node = this.binary(0);
		this.depth--;
		return node;
	}

	private binary(level: number): Node {
		if (level >= BINARY_LEVELS.length) return this.unary();
		const ops = BINARY_LEVELS[level]!;
		let left = this.binary(level + 1);
		for (;;) {
			const token = this.tokens[this.pos];
			if (!token || token.kind !== 'op' || !ops.includes(token.text)) return left;
			this.pos++;
			const right = this.binary(level + 1);
			left = { k: 'bin', op: token.text, left, right };
		}
	}

	private unary(): Node {
		const token = this.tokens[this.pos];
		if (token?.kind === 'op' && token.text === '!') {
			this.pos++;
			if (++this.depth > MAX_DEPTH) throw new PipelineExpressionError(`Expression nests deeper than ${MAX_DEPTH} levels: ${this.src}`);
			const arg = this.unary();
			this.depth--;
			return { k: 'not', arg };
		}
		return this.postfix(this.primary());
	}

	private postfix(node: Node): Node {
		for (;;) {
			const token = this.tokens[this.pos];
			if (token?.kind === 'dot') {
				this.pos++;
				const name = this.tokens[this.pos];
				if (name?.kind === 'word') {
					this.pos++;
					node = { k: 'prop', target: node, name: name.text };
				} else if (name?.kind === 'star') {
					this.pos++;
					node = { k: 'star', target: node };
				} else {
					throw this.error('Expected a property name after', token);
				}
			} else if (token?.kind === 'lbracket') {
				this.pos++;
				if (this.tokens[this.pos]?.kind === 'star' && this.tokens[this.pos + 1]?.kind === 'rbracket') {
					this.pos += 2;
					node = { k: 'star', target: node };
					continue;
				}
				const index = this.expression();
				this.expect('rbracket', ']');
				node = { k: 'index', target: node, index };
			} else {
				return node;
			}
		}
	}

	private primary(): Node {
		const token = this.tokens[this.pos];
		if (!token) throw new PipelineExpressionError(`Unexpected end of expression: ${this.src}`);
		this.pos++;
		switch (token.kind) {
			case 'number':
				return { k: 'lit', v: token.num };
			case 'string':
				return { k: 'lit', v: token.text };
			case 'lparen': {
				const node = this.expression();
				this.expect('rparen', ')');
				return node;
			}
			case 'word': {
				if (this.tokens[this.pos]?.kind === 'lparen') return this.call(token);
				if (Object.hasOwn(KEYWORDS, token.text)) return { k: 'lit', v: KEYWORDS[token.text]! };
				const name = token.text.toLowerCase();
				if (!CONTEXT_NAMES.has(name)) throw this.error(`Unrecognized named-value '${token.text}'`, token);
				return { k: 'ctx', name: name === 'github' ? 'skiff' : name };
			}
			default:
				throw this.error(`Unexpected '${token.text}'`, token);
		}
	}

	private call(token: Token): Node {
		const name = token.text.toLowerCase();
		const arity = FUNCTIONS[name];
		if (!arity) throw this.error(`Unrecognized function '${token.text}'`, token);
		this.pos++; // (
		const args: Node[] = [];
		if (this.tokens[this.pos]?.kind === 'rparen') {
			this.pos++;
		} else {
			for (;;) {
				args.push(this.expression());
				const sep = this.tokens[this.pos];
				if (sep?.kind === 'comma') {
					this.pos++;
					continue;
				}
				this.expect('rparen', ')');
				break;
			}
		}
		if (args.length < arity[0] || args.length > arity[1]) {
			const expected = arity[0] === arity[1] ? `${arity[0]}` : arity[1] === Number.POSITIVE_INFINITY ? `at least ${arity[0]}` : `${arity[0]}-${arity[1]}`;
			throw this.error(`Function '${token.text}' takes ${expected} argument(s), got ${args.length}`, token);
		}
		return { k: 'call', name, args };
	}

	private expect(kind: TokenKind, text: string): void {
		const token = this.tokens[this.pos];
		if (token?.kind !== kind) {
			throw token ? this.error(`Expected '${text}' but found '${token.text}'`, token) : new PipelineExpressionError(`Expected '${text}' at end of expression: ${this.src}`);
		}
		this.pos++;
	}

	private error(message: string, token: Token): PipelineExpressionError {
		return new PipelineExpressionError(`${message} at position ${token.pos + 1}: ${this.src}`);
	}
}

/** Parsed trees by source; workflows evaluate the same few expressions for every step and job. */
const astCache = new Map<string, Node>();

function parse(expr: string): Node {
	const cached = astCache.get(expr);
	if (cached) return cached;
	if (expr.length > MAX_EXPRESSION_LENGTH) {
		throw new PipelineExpressionError(`Expression is longer than ${MAX_EXPRESSION_LENGTH} characters`);
	}
	const node = new Parser(expr, tokenize(expr)).parse();
	if (astCache.size >= 1000) astCache.clear();
	astCache.set(expr, node);
	return node;
}

function walk(node: Node, visit: (node: Node) => void): void {
	visit(node);
	switch (node.k) {
		case 'prop':
		case 'star':
			walk(node.target, visit);
			break;
		case 'index':
			walk(node.target, visit);
			walk(node.index, visit);
			break;
		case 'not':
			walk(node.arg, visit);
			break;
		case 'bin':
			walk(node.left, visit);
			walk(node.right, visit);
			break;
		case 'call':
			for (const arg of node.args) walk(arg, visit);
			break;
	}
}

// --- values and coercion -------------------------------------------------------------------

/** The result of an object filter (`a.*`); later dereferences map over its items. */
class Filtered {
	constructor(readonly items: unknown[]) {}
}

type Kind = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

function kindOf(value: unknown): Kind {
	if (value === null || value === undefined) return 'null';
	switch (typeof value) {
		case 'boolean':
			return 'boolean';
		case 'number':
			return 'number';
		case 'string':
			return 'string';
		case 'object':
			return Array.isArray(value) ? 'array' : 'object';
		default:
			return 'null';
	}
}

/** GitHub truthiness: false, 0, -0, '', null and NaN are falsy; arrays and objects are truthy. */
function truthy(value: unknown): boolean {
	switch (kindOf(value)) {
		case 'null':
			return false;
		case 'boolean':
			return value as boolean;
		case 'number':
			return value !== 0 && !Number.isNaN(value);
		case 'string':
			return value !== '';
		default:
			return true;
	}
}

function toNumber(value: unknown): number {
	switch (kindOf(value)) {
		case 'null':
			return 0;
		case 'boolean':
			return value ? 1 : 0;
		case 'number':
			return value as number;
		case 'string':
			return parseNumber(value as string);
		default:
			return Number.NaN;
	}
}

/**
 * Numbers render like the runner's .NET `G15` format: up to 15 significant digits, plain notation
 * for exponents -4..14, `1E+15` / `1E-05` style beyond. Integers in the usual ranges print as themselves.
 */
function formatNumber(n: number): string {
	if (Number.isNaN(n)) return 'NaN';
	if (n === Number.POSITIVE_INFINITY) return 'Infinity';
	if (n === Number.NEGATIVE_INFINITY) return '-Infinity';
	if (n === 0) return '0';
	const exp = n.toExponential(14);
	const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exp)!;
	const exponent = Number(match[4]);
	if (exponent > -5 && exponent < 15) return String(Number(n.toPrecision(15)));
	const fraction = (match[3] ?? '').replace(/0+$/, '');
	const digits = String(Math.abs(exponent)).padStart(2, '0');
	return `${match[1]}${match[2]}${fraction ? '.' + fraction : ''}E${exponent < 0 ? '-' : '+'}${digits}`;
}

/** GitHub's ConvertToString, used by functions: arrays and objects become `Array`/`Object`. */
function toStr(value: unknown): string {
	switch (kindOf(value)) {
		case 'null':
			return '';
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			return formatNumber(value as number);
		case 'string':
			return value as string;
		case 'array':
			return 'Array';
		default:
			return 'Object';
	}
}

function toJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? null, (_key, v: unknown) => (v === undefined ? null : v), 2) ?? 'null';
	} catch (error) {
		throw new PipelineExpressionError(`toJSON failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * How a `${{ }}` result is spliced into a string: null → '', booleans → `true`/`false`, numbers
 * canonical, and (unlike GitHub, which prints `Object`/`Array`) objects and arrays as JSON, which is
 * what someone writing `${{ matrix }}` into a script actually wants.
 */
export function stringifyExpressionValue(value: unknown): string {
	const kind = kindOf(value);
	return kind === 'array' || kind === 'object' ? toJson(value) : toStr(value);
}

const upper = (s: string): string => s.toUpperCase();

/** GitHub `==`: same kinds compare directly (strings case-insensitively, objects by identity), else as numbers. */
function looseEqual(left: unknown, right: unknown): boolean {
	const kl = kindOf(left);
	const kr = kindOf(right);
	if (kl === kr) {
		switch (kl) {
			case 'null':
				return true;
			case 'string':
				return upper(left as string) === upper(right as string);
			default:
				return left === right;
		}
	}
	if (kl === 'array' || kl === 'object' || kr === 'array' || kr === 'object') return false;
	return toNumber(left) === toNumber(right);
}

/** Ordering for `< <= > >=`; null when the values cannot be ordered (any NaN). */
function compare(left: unknown, right: unknown): number | null {
	if (typeof left === 'string' && typeof right === 'string') {
		const a = upper(left);
		const b = upper(right);
		return a < b ? -1 : a > b ? 1 : 0;
	}
	const a = toNumber(left);
	const b = toNumber(right);
	if (Number.isNaN(a) || Number.isNaN(b)) return null;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Own-property lookup, exact first then case-insensitive; `undefined` means missing. */
function member(target: unknown, key: unknown): unknown {
	const kind = kindOf(target);
	if (kind === 'array') {
		const list = target as unknown[];
		if (typeof key === 'string' && key.trim() === '') return undefined;
		const n = typeof key === 'number' ? key : typeof key === 'string' ? parseNumber(key) : Number.NaN;
		if (Number.isNaN(n) || n < 0) return undefined;
		const index = Math.floor(n);
		return index < list.length ? list[index] : undefined;
	}
	if (kind !== 'object') return undefined;
	const object = target as Record<string, unknown>;
	const name = typeof key === 'string' ? key : kindOf(key) === 'number' || kindOf(key) === 'boolean' ? toStr(key) : null;
	if (name === null) return undefined;
	if (Object.hasOwn(object, name)) return object[name];
	const wanted = upper(name);
	for (const candidate of Object.keys(object)) {
		if (upper(candidate) === wanted) return object[candidate];
	}
	return undefined;
}

function children(value: unknown): unknown[] {
	const kind = kindOf(value);
	if (kind === 'array') return [...(value as unknown[])];
	if (kind === 'object') return Object.values(value as Record<string, unknown>);
	return [];
}

// --- evaluator ---------------------------------------------------------------------------

interface Scope {
	ctx: PipelineExpressionContext;
	options: PipelineEvalOptions;
}

function evaluate(node: Node, scope: Scope): unknown {
	const value = evaluateRaw(node, scope);
	return value instanceof Filtered ? value.items : value === undefined ? null : value;
}

function evaluateRaw(node: Node, scope: Scope): unknown {
	switch (node.k) {
		case 'lit':
			return node.v;
		case 'ctx':
			return member(scope.ctx, node.name) ?? null;
		case 'prop':
			return dereference(evaluateRaw(node.target, scope), node.name);
		case 'index':
			return dereference(evaluateRaw(node.target, scope), evaluate(node.index, scope));
		case 'star': {
			const target = evaluateRaw(node.target, scope);
			return new Filtered(target instanceof Filtered ? target.items.flatMap(children) : children(target));
		}
		case 'not':
			return !truthy(evaluate(node.arg, scope));
		case 'bin':
			return binary(node.op, node.left, node.right, scope);
		case 'call':
			return call(node.name, node.args, scope);
	}
}

/** `a.b` / `a[k]`; on a filter result it maps over the items and drops the missing ones. */
function dereference(target: unknown, key: unknown): unknown {
	if (target instanceof Filtered) {
		const items: unknown[] = [];
		for (const item of target.items) {
			const value = member(item, key);
			if (value !== undefined) items.push(value);
		}
		return new Filtered(items);
	}
	return member(target, key) ?? null;
}

function binary(op: string, leftNode: Node, rightNode: Node, scope: Scope): unknown {
	const left = evaluate(leftNode, scope);
	if (op === '&&') return truthy(left) ? evaluate(rightNode, scope) : left;
	if (op === '||') return truthy(left) ? left : evaluate(rightNode, scope);
	const right = evaluate(rightNode, scope);
	if (op === '==') return looseEqual(left, right);
	if (op === '!=') return !looseEqual(left, right);
	const order = compare(left, right);
	if (order === null) return false;
	switch (op) {
		case '<':
			return order < 0;
		case '<=':
			return order <= 0;
		case '>':
			return order > 0;
		default:
			return order >= 0;
	}
}

function isPrimitive(value: unknown): boolean {
	const kind = kindOf(value);
	return kind !== 'array' && kind !== 'object';
}

function call(name: string, argNodes: Node[], scope: Scope): unknown {
	const status = scope.options.status ?? { failed: false, cancelled: false };
	switch (name) {
		case 'success':
			return !status.failed && !status.cancelled;
		case 'failure':
			return status.failed && !status.cancelled;
		case 'cancelled':
			return status.cancelled;
		case 'always':
			return true;
	}
	const args = argNodes.map((arg) => evaluate(arg, scope));
	switch (name) {
		case 'contains': {
			const [search, item] = args;
			if (kindOf(search) === 'array') return (search as unknown[]).some((element) => looseEqual(element, item));
			if (!isPrimitive(search)) return false;
			return upper(toStr(search)).includes(upper(toStr(item)));
		}
		case 'startswith':
		case 'endswith': {
			const [value, affix] = args;
			if (!isPrimitive(value) || !isPrimitive(affix)) return false;
			const a = upper(toStr(value));
			const b = upper(toStr(affix));
			return name === 'startswith' ? a.startsWith(b) : a.endsWith(b);
		}
		case 'format':
			return format(toStr(args[0]), args.slice(1));
		case 'join': {
			const [value, separator] = args;
			const sep = args.length > 1 ? toStr(separator) : ',';
			if (kindOf(value) === 'array') return (value as unknown[]).map(toStr).join(sep);
			return isPrimitive(value) ? toStr(value) : '';
		}
		case 'tojson':
			return toJson(args[0]);
		case 'fromjson': {
			const text = toStr(args[0]);
			try {
				return JSON.parse(text) as unknown;
			} catch (error) {
				throw new PipelineExpressionError(`fromJSON could not parse ${JSON.stringify(text.slice(0, 100))}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		case 'hashfiles': {
			if (!scope.options.hashFiles) throw new PipelineExpressionError('hashFiles() is only available inside a running step');
			try {
				return scope.options.hashFiles(args.map(toStr));
			} catch (error) {
				if (error instanceof PipelineExpressionError) throw error;
				throw new PipelineExpressionError(`hashFiles failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	throw new PipelineExpressionError(`Unrecognized function '${name}'`);
}

/** `format('{0} {{literal}}', x)`: .NET-style placeholders, `{{`/`}}` escape braces. */
function format(template: string, args: unknown[]): string {
	let out = '';
	let i = 0;
	while (i < template.length) {
		const c = template[i]!;
		if (c === '{') {
			if (template[i + 1] === '{') {
				out += '{';
				i += 2;
				continue;
			}
			const close = template.indexOf('}', i);
			const index = close < 0 ? '' : template.slice(i + 1, close);
			if (!/^\d+$/.test(index)) throw new PipelineExpressionError(`The format string is invalid: ${template}`);
			const n = Number(index);
			if (n >= args.length) throw new PipelineExpressionError(`The format string references more arguments than were supplied: ${template}`);
			out += toStr(args[n]);
			i = close + 1;
			continue;
		}
		if (c === '}') {
			if (template[i + 1] !== '}') throw new PipelineExpressionError(`The format string is invalid: ${template}`);
			out += '}';
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Run `fn`, turning anything unexpected (e.g. a stack overflow) into a PipelineExpressionError. */
function guarded<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		if (error instanceof PipelineExpressionError) throw error;
		throw new PipelineExpressionError(`Expression failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// --- templates ---------------------------------------------------------------------------

interface TemplateSpan {
	/** Index of `${{`. */
	start: number;
	/** Index just after the closing `}}`. */
	end: number;
	/** The source between the braces. */
	expr: string;
}

/** Find every `${{ … }}`, skipping `}}` inside single-quoted strings. */
function scanTemplates(value: string): TemplateSpan[] {
	const spans: TemplateSpan[] = [];
	let from = 0;
	for (;;) {
		const start = value.indexOf('${{', from);
		if (start < 0) return spans;
		let j = start + 3;
		let inString = false;
		let close = -1;
		while (j < value.length) {
			const c = value[j]!;
			if (c === "'") inString = !inString;
			else if (!inString && c === '}' && value[j + 1] === '}') {
				close = j;
				break;
			}
			j++;
		}
		if (close < 0) throw new PipelineExpressionError(`Unterminated '\${{' at position ${start + 1}: ${value}`);
		spans.push({ start, end: close + 2, expr: value.slice(start + 3, close) });
		from = close + 2;
	}
}

/** Whether a string contains a `${{ }}` template. */
export function hasTemplate(value: string): boolean {
	return value.includes('${{');
}

/** The source of every `${{ }}` in a string (for linting); throws on an unterminated template. */
export function extractExpressions(value: string): string[] {
	return scanTemplates(value).map((span) => span.expr);
}

/** The inner expression when the whole (trimmed) value is one `${{ … }}`, else null. */
export function unwrapExpression(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed.startsWith('${{')) return null;
	const spans = scanTemplates(trimmed);
	return spans.length === 1 && spans[0]!.end === trimmed.length ? spans[0]!.expr : null;
}

// --- public API ----------------------------------------------------------------------------

/** Evaluate one expression (without the `${{ }}` wrapper). Missing properties are null. */
export function evaluateExpression(expr: string, ctx: PipelineExpressionContext, options: PipelineEvalOptions = {}): unknown {
	return guarded(() => evaluate(parse(expr), { ctx, options }));
}

/** Replace every `${{ }}` in a string with its stringified value; template-free strings pass through. */
export function interpolate(template: string, ctx: PipelineExpressionContext, options: PipelineEvalOptions = {}): string {
	if (!hasTemplate(template)) return template;
	const spans = scanTemplates(template);
	let out = '';
	let last = 0;
	for (const span of spans) {
		out += template.slice(last, span.start);
		out += stringifyExpressionValue(evaluateExpression(span.expr, ctx, options));
		last = span.end;
	}
	return out + template.slice(last);
}

/**
 * Like `interpolate`, except that a value which is exactly one `${{ expr }}` yields the raw result
 * (an object for `matrix: ${{ fromJSON(...) }}`, a boolean for `continue-on-error`).
 */
export function interpolateValue(template: string, ctx: PipelineExpressionContext, options: PipelineEvalOptions = {}): unknown {
	const inner = hasTemplate(template) ? unwrapExpression(template) : null;
	return inner === null ? interpolate(template, ctx, options) : evaluateExpression(inner, ctx, options);
}

/**
 * GitHub `if:` semantics. The `${{ }}` wrapper is optional; empty means `success()`; without a
 * status function the expression is implicitly `success() && (expr)`, so a failed job skips it.
 * A condition that mixes text and templates (`${{ a }} == b`) is, as on GitHub, a non-empty
 * string and therefore true once the implicit `success()` holds.
 */
export function evaluateCondition(condition: string | null, ctx: PipelineExpressionContext, options: PipelineEvalOptions = {}): boolean {
	const status = options.status ?? { failed: false, cancelled: false };
	const succeeded = !status.failed && !status.cancelled;
	const text = condition?.trim() ?? '';
	if (text === '') return succeeded;
	const expr = hasTemplate(text) ? unwrapExpression(text) : text;
	if (expr === null) {
		const hasStatus = extractExpressions(text).some(containsStatusFunction);
		if (!hasStatus && !succeeded) return false;
		return interpolate(text, ctx, options) !== '';
	}
	return guarded(() => {
		const node = parse(expr);
		const effective: Node = hasStatusCall(node) ? node : { k: 'bin', op: '&&', left: { k: 'call', name: 'success', args: [] }, right: node };
		return truthy(evaluate(effective, { ctx, options }));
	});
}

function hasStatusCall(node: Node): boolean {
	let found = false;
	walk(node, (n) => {
		if (n.k === 'call' && STATUS_FUNCTIONS.has(n.name)) found = true;
	});
	return found;
}

/** Whether an expression calls success/failure/always/cancelled. Throws on a syntax error. */
export function containsStatusFunction(expr: string): boolean {
	return hasStatusCall(parse(unwrapExpression(expr) ?? expr));
}

/** Top-level contexts an expression reads (lowercase, `github` reported as `skiff`), in order. */
export function expressionReferences(expr: string): string[] {
	const names = new Set<string>();
	walk(parse(expr), (n) => {
		if (n.k === 'ctx') names.add(n.name);
	});
	return [...names];
}

/** Functions an expression calls (lowercase), so the linter can enforce where each is allowed. */
export function expressionFunctions(expr: string): string[] {
	const names = new Set<string>();
	walk(parse(expr), (n) => {
		if (n.k === 'call') names.add(n.name);
	});
	return [...names];
}
