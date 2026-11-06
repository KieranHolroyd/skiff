/**
 * Structure edits for Valkey/Redis (`alter`): rename (`RENAMENX`) and delete (`UNLINK`) one key.
 * Keys are created and changed through `apply`; groups and keyspaces are views over a SCAN, so
 * they have no structure of their own.
 */
import type { SchemaChangeOp } from '../../protocol.ts';

export const KEYVALUE_STRUCTURE = ['rename', 'drop'] as const satisfies readonly SchemaChangeOp[];

/**
 * One argument as redis-cli would accept it back: always double-quoted, with `"`, `\` and
 * control characters escaped, so the dashboard can show (and the command editor can re-run)
 * exactly what was sent.
 */
export function quoteArg(text: string): string {
	let out = '"';
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (char === '"' || char === '\\') out += `\\${char}`;
		else if (char === '\n') out += '\\n';
		else if (char === '\r') out += '\\r';
		else if (char === '\t') out += '\\t';
		else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
		else out += char;
	}
	return `${out}"`;
}

/** A command as one display line: `RENAMENX "a" "b"`. */
export function commandLine(command: string, args: readonly string[]): string {
	return [command, ...args.map(quoteArg)].join(' ');
}
