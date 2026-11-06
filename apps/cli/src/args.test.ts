import { describe, expect, test } from 'bun:test';
import { UsageError, parseArgs, type FlagSpec } from './args.ts';

const spec = {
	promote: { type: 'boolean', default: true },
	create: { type: 'boolean', default: true },
	json: { type: 'boolean', default: false },
	project: { type: 'string', short: 'p' },
	message: { type: 'string', short: 'm' },
	name: { type: 'string', short: 'n' },
} satisfies FlagSpec;

describe('parseArgs', () => {
	test('parses positionals, boolean negation, equals and short values', () => {
		const args = parseArgs(
			['public', '--no-promote', '--message=hello world', '-n', 'My Site', '--json'],
			spec,
		);
		expect(args.positionals).toEqual(['public']);
		expect(args.boolean('promote')).toBe(false);
		expect(args.string('message')).toBe('hello world');
		expect(args.string('name')).toBe('My Site');
		expect(args.boolean('json')).toBe(true);
	});

	test('supports attached short values', () => {
		const args = parseArgs(['-pmy-site'], spec);
		expect(args.string('project')).toBe('my-site');
	});

	test('supports explicit boolean values', () => {
		const args = parseArgs(['--promote=false', '--create=true'], spec);
		expect(args.boolean('promote')).toBe(false);
		expect(args.boolean('create')).toBe(true);
	});

	test('supports --no- for a default-true boolean', () => {
		const browserSpec = { browser: { type: 'boolean', default: true } } satisfies FlagSpec;
		expect(parseArgs([], browserSpec).boolean('browser')).toBe(true);
		expect(parseArgs(['--no-browser'], browserSpec).boolean('browser')).toBe(false);
	});

	test('keeps everything after -- as positionals', () => {
		const args = parseArgs(['--', '--not-a-flag', '-x'], spec);
		expect(args.positionals).toEqual(['--not-a-flag', '-x']);
	});

	test('rejects unknown flags', () => {
		expect(() => parseArgs(['--wat'], spec)).toThrow(UsageError);
		expect(() => parseArgs(['-z'], spec)).toThrow('Unknown option');
	});

	test('rejects missing values', () => {
		expect(() => parseArgs(['--project'], spec)).toThrow('needs a value');
		expect(() => parseArgs(['-m'], spec)).toThrow('needs a value');
	});

	test('rejects --no- on a string flag', () => {
		expect(() => parseArgs(['--no-project'], spec)).toThrow('only valid for boolean');
	});

	test('a literal no- flag wins over negating another flag', () => {
		const deploySpec = {
			wrangler: { type: 'string' },
			'no-wrangler': { type: 'boolean' },
		} satisfies FlagSpec;
		const args = parseArgs(['--no-wrangler', '--wrangler', 'wrangler.jsonc'], deploySpec);
		expect(args.boolean('no-wrangler')).toBe(true);
		expect(args.string('wrangler')).toBe('wrangler.jsonc');
	});

	test('collects every value of a multiple string flag', () => {
		const multi = { bucket: { type: 'string', short: 'b', multiple: true }, project: { type: 'string' } } as const;
		const args = parseArgs(['--bucket', 'a', '-b', 'b:read', '--bucket=c', '--project', 'x', '--project', 'y'], multi);
		expect(args.strings('bucket')).toEqual(['a', 'b:read', 'c']);
		expect(args.string('bucket')).toBe('c');
		expect(args.strings('project')).toEqual([]);
		expect(args.string('project')).toBe('y');
	});
});
