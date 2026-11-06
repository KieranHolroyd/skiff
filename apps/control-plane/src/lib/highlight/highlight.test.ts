import { describe, expect, test } from 'bun:test';
import { highlight, resolveLang } from './highlight.js';

describe('resolveLang', () => {
	test('fence tags and aliases', () => {
		expect(resolveLang('ts')).toBe('typescript');
		expect(resolveLang('Bash')).toBe('shellscript');
		expect(resolveLang('postgres')).toBe('sql');
		expect(resolveLang('yml')).toBe('yaml');
	});

	test('file labels with context prefixes and suffixes', () => {
		expect(resolveLang('src/index.ts')).toBe('typescript');
		expect(resolveLang('wrangler.jsonc')).toBe('jsonc');
		expect(resolveLang('edge · /etc/wireguard/wg0.conf')).toBe('ini');
		expect(resolveLang('worker · /etc/systemd/system/skiff-agent.service')).toBe('systemd');
		expect(resolveLang('worker · /etc/skiff/skiff.env')).toBe('dotenv');
		expect(resolveLang('skiff-function.json → bindings')).toBe('json');
		expect(resolveLang('.github/workflows/ci.yml')).toBe('yaml');
		expect(resolveLang('schema.prisma')).toBe('prisma');
		expect(resolveLang('Dockerfile')).toBe('dockerfile');
		expect(resolveLang('.env.production')).toBe('dotenv');
	});

	test('unknown or empty hints render as plain text', () => {
		expect(resolveLang(undefined)).toBeNull();
		expect(resolveLang('')).toBeNull();
		expect(resolveLang('edge')).toBeNull();
		expect(resolveLang('notes.unknownext')).toBeNull();
	});
});

describe('highlight', () => {
	test('colours keywords, leaves default text uncoloured, keeps the source intact', async () => {
		const code = 'const answer = "42";\n// done';
		const lines = await highlight(code, 'ts');
		expect(lines).not.toBeNull();
		expect(lines!.map((line) => line.map((token) => token.text).join('')).join('\n')).toBe(code);
		const flat = lines!.flat();
		expect(flat.find((token) => token.text.includes('const'))?.style).toContain('--hl-light:');
		expect(flat.some((token) => token.style === undefined)).toBe(true);
	});

	test('returns null for unknown languages', async () => {
		expect(await highlight('hello', 'nope')).toBeNull();
	});
});
