/**
 * Splits one redis-cli style command line into arguments, following redis-cli's
 * `sdssplitargs`: whitespace separates arguments; double quotes understand `\n \r \t \b \a`,
 * `\\`, `\"` and `\xHH`; single quotes only understand `\'`; a closing quote must be followed by
 * whitespace or the end of the line. Unlike redis-cli we refuse a second command on another
 * line, because the studio runs exactly one command per request (no pipelines, no scripts).
 *
 * Arguments are built as bytes, so `"\xff"` is a real 0xff byte. An argument that is valid UTF-8
 * comes back as a string; one that is not comes back as a `Uint8Array` (Bun's `send` accepts
 * buffers and writes them verbatim).
 */

export class TokenizeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TokenizeError';
	}
}

export type CommandArg = string | Uint8Array;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

const WHITESPACE = new Set([' ', '\t', '\r', '\n', '\v', '\f']);
const HEX = /^[0-9a-fA-F]$/;

const DOUBLE_QUOTE_ESCAPES: Record<string, number> = {
	n: 0x0a,
	r: 0x0d,
	t: 0x09,
	b: 0x08,
	a: 0x07,
};

export function tokenize(input: string): CommandArg[] {
	// Iterate by code point so astral characters (emoji keys) stay whole.
	const chars = Array.from(input);
	const args: CommandArg[] = [];
	let i = 0;
	let newlineAfterArgs = false;
	while (true) {
		while (i < chars.length && WHITESPACE.has(chars[i] ?? '')) {
			if (chars[i] === '\n' && args.length > 0) newlineAfterArgs = true;
			i += 1;
		}
		if (i >= chars.length) break;
		if (newlineAfterArgs) throw new TokenizeError('Run one command at a time: the input has more than one line.');

		const bytes: number[] = [];
		const pushText = (text: string) => {
			for (const byte of encoder.encode(text)) bytes.push(byte);
		};
		let inDouble = false;
		let inSingle = false;
		let done = false;
		while (!done) {
			const c = chars[i];
			if (inDouble) {
				if (c === undefined) throw new TokenizeError('Unbalanced double quotes.');
				const next = chars[i + 1];
				const h1 = chars[i + 2];
				const h2 = chars[i + 3];
				if (c === '\\' && next === 'x' && h1 && h2 && HEX.test(h1) && HEX.test(h2)) {
					bytes.push(Number.parseInt(`${h1}${h2}`, 16));
					i += 3;
				} else if (c === '\\' && next !== undefined) {
					const mapped = DOUBLE_QUOTE_ESCAPES[next];
					if (mapped !== undefined) bytes.push(mapped);
					else pushText(next);
					i += 1;
				} else if (c === '"') {
					// redis-cli rejects `"foo"bar`: the closing quote must end the argument.
					const after = chars[i + 1];
					if (after !== undefined && !WHITESPACE.has(after))
						throw new TokenizeError('A closing double quote must be followed by a space.');
					done = true;
				} else {
					pushText(c);
				}
			} else if (inSingle) {
				if (c === undefined) throw new TokenizeError('Unbalanced single quotes.');
				if (c === '\\' && chars[i + 1] === "'") {
					bytes.push(0x27);
					i += 1;
				} else if (c === "'") {
					const after = chars[i + 1];
					if (after !== undefined && !WHITESPACE.has(after))
						throw new TokenizeError('A closing single quote must be followed by a space.');
					done = true;
				} else {
					pushText(c);
				}
			} else if (c === undefined || WHITESPACE.has(c)) {
				done = true;
				// Leave the whitespace for the outer loop, so a newline is still seen.
				i -= 1;
			} else if (c === '"') {
				inDouble = true;
			} else if (c === "'") {
				inSingle = true;
			} else {
				pushText(c);
			}
			i += 1;
		}
		args.push(toArg(Uint8Array.from(bytes)));
	}
	return args;
}

function toArg(bytes: Uint8Array): CommandArg {
	try {
		return strictDecoder.decode(bytes);
	} catch {
		return bytes;
	}
}

/** Display form of an argument, for command names and messages. */
export function argText(arg: CommandArg | undefined): string {
	if (arg === undefined) return '';
	return typeof arg === 'string' ? arg : new TextDecoder().decode(arg);
}
