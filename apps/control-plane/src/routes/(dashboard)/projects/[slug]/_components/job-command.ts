/** Command-line helpers for the job forms (plan 09); no imports, so they test on their own. */

/**
 * Split a command line the way a POSIX shell splits words, for the form only: whitespace
 * separates, single quotes are literal, double quotes allow `\"` and `\\`, a backslash escapes
 * the next character. No variables, globs or operators: the server runs the argv as is.
 */
export function splitArgs(line: string): { args: string[]; error: string | null } {
	const args: string[] = [];
	let current = '';
	let inWord = false;
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]!;
		if (quote === "'") {
			if (char === "'") quote = null;
			else current += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = null;
			else if (char === '\\' && (line[index + 1] === '"' || line[index + 1] === '\\')) current += line[++index];
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === '\\' && index + 1 < line.length) {
			current += line[++index];
			inWord = true;
		} else if (/\s/.test(char)) {
			if (inWord) args.push(current);
			current = '';
			inWord = false;
		} else {
			current += char;
			inWord = true;
		}
	}
	if (quote) return { args: [], error: `Close the ${quote === '"' ? 'double' : 'single'} quote.` };
	if (inWord) args.push(current);
	return { args, error: null };
}

/** The inverse, for showing a stored argv in the form. */
export function joinArgs(args: string[]): string {
	return args.map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(' ');
}
