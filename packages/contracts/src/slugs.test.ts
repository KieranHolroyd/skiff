import { describe, expect, test } from 'bun:test';
import { checkSlug, RESERVED_SLUGS, suggestSlugs } from './slugs.ts';

describe('slugs', () => {
	test('accepts a normal slug', () => {
		expect(checkSlug('my-site')).toEqual({ ok: true });
		expect(checkSlug('a1b').ok).toBe(true);
	});

	test('rejects length, characters, double hyphens and reserved names', () => {
		expect(checkSlug('ab').problem).toBe('length');
		expect(checkSlug('a'.repeat(41)).problem).toBe('length');
		expect(checkSlug('My-Site').problem).toBe('characters');
		expect(checkSlug('-my-site').problem).toBe('characters');
		expect(checkSlug('my--site').problem).toBe('double-hyphen');
		expect(checkSlug('api').problem).toBe('reserved');
		expect(RESERVED_SLUGS.has('mcp')).toBe(true);
	});

	test('detects taken slugs case-sensitively (slugs are lowercase)', () => {
		expect(checkSlug('blog', ['blog']).problem).toBe('taken');
		expect(checkSlug('blog', ['Blog']).ok).toBe(true);
	});

	test('suggests free alternatives instead of silently suffixing', () => {
		const taken = ['blog', 'blog-app', 'blog-site', 'blog-web'];
		const suggestions = suggestSlugs('blog', taken, 3);
		expect(suggestions).toHaveLength(3);
		expect(suggestions.every((slug) => !taken.includes(slug) && checkSlug(slug).ok)).toBe(true);
		expect(new Set(suggestions).size).toBe(3);
	});

	test('trims and normalizes invalid input before suggesting', () => {
		const [suggestion] = suggestSlugs('My Weird -- Name!', [], 1);
		expect(suggestion).toBeDefined();
		expect(checkSlug(suggestion!).ok).toBe(true);
	});
});
