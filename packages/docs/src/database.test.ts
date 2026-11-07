import { expect, test } from 'bun:test';
import { createDocsDatabase, ftsQuery } from './database.ts';
import { readContent } from './disk.ts';
import { createLibrary } from './library.ts';

const library = createLibrary(readContent(), { href: (slug) => `/docs/${slug}` });
const db = createDocsDatabase(library, {
	version: '1.2.3',
	url: (slug, anchor) => `https://control.example.com/docs/${slug}${anchor ? `#${anchor}` : ''}`
});

test('ftsQuery quotes words and prefixes the last', () => {
	expect(ftsQuery('roll back "prod"')).toBe('"roll" "back" "prod"*');
	expect(ftsQuery('roll back', 'any')).toBe('"roll" OR "back"*');
	expect(ftsQuery('  ?? ')).toBeNull();
});

test('indexes every page with FTS5 and reports the build it came from', async () => {
	const info = await db.info();
	expect(info.engine).toBe('fts5');
	expect(info.version).toBe('1.2.3');
	expect(info.pages).toBe(library.nav().flatMap((s) => s.pages).length);
	expect(info.sections).toBeGreaterThan(info.pages);
	expect(info.fingerprint).toMatch(/^[0-9a-f]{16}$/);
});

test('search ranks the page that owns a topic first, with stemming', async () => {
	const hits = await db.search('rolling back a deployment');
	expect(hits.length).toBeGreaterThan(0);
	expect(hits.some((hit) => hit.slug === 'deploying/static-sites')).toBe(true);
	expect(hits[0]!.url).toStartWith('https://control.example.com/docs/');
	expect(await db.search('')).toEqual([]);
	const scoped = await db.search('backup', { section: 'Self-hosting' });
	expect(scoped.every((hit) => hit.section === 'Self-hosting')).toBe(true);
});

test('read returns Markdown for a page or one section', async () => {
	const page = (await db.read('/docs/getting-started/quickstart/'))!;
	expect(page.title).toBe('Quickstart');
	expect(page.markdown.length).toBeGreaterThan(200);
	const first = page.sections[0]!;
	const section = (await db.read('getting-started/quickstart', first.anchor))!;
	expect(section.markdown.startsWith('#')).toBe(true);
	expect(section.markdown.length).toBeLessThan(page.markdown.length);
	expect(await db.read('nope/missing')).toBeNull();
	expect(await db.read('getting-started/quickstart', 'no-such-anchor')).toBeNull();
});
