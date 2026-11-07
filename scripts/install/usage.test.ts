import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const usage = readFileSync(new URL('./USAGE.txt', import.meta.url), 'utf8');

/** Every flag main.ts reads through has(), value(), setting() or args.includes(). */
function parsedFlags(source: string): string[] {
	const flags = new Set<string>();
	for (const match of source.matchAll(/\b(?:has|value|setting|args\.includes)\(\s*'(-{1,2}[a-z0-9-]+)'/g))
		flags.add(match[1]!);
	return [...flags].sort();
}

/** Flags at the start of an option line (`  --flag`, `  -h, --help`). */
function documentedFlags(text: string): Set<string> {
	const flags = new Set<string>();
	for (const line of text.split('\n')) {
		const match = /^ {2}((?:-{1,2}[a-z0-9-]+)(?:, -{1,2}[a-z0-9-]+)*)/.exec(line);
		if (match) for (const flag of match[1]!.split(', ')) flags.add(flag);
	}
	return flags;
}

describe('installer usage text', () => {
	test('lists every flag main.ts parses', () => {
		const parsed = parsedFlags(main);
		expect(parsed.length).toBeGreaterThan(30);
		const documented = documentedFlags(usage);
		expect(parsed.filter((flag) => !documented.has(flag))).toEqual([]);
	});

	test('documents no flag main.ts ignores', () => {
		const parsed = new Set(parsedFlags(main));
		expect([...documentedFlags(usage)].filter((flag) => !parsed.has(flag))).toEqual([]);
	});
});
