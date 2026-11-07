import { describe, expect, test } from 'bun:test';
import { parseFrontmatter } from './frontmatter.ts';
import { parseDocHref, renderDoc, slugifyHeading } from './render.ts';

const opts = {
	isPage: (slug: string) => slug === 'deploying/static-sites',
	href: (slug: string) => `/docs/${slug}`
};

describe('frontmatter', () => {
	test('parses title and description, strips quotes', () => {
		const { frontmatter, body } = parseFrontmatter(
			'---\ntitle: "Static sites"\ndescription: Deploy: a folder.\n---\n\nHello'
		);
		expect(frontmatter.title).toBe('Static sites');
		expect(frontmatter.description).toBe('Deploy: a folder.');
		expect(body.trim()).toBe('Hello');
	});
});

describe('renderDoc', () => {
	test('headings get anchors and land in the TOC', async () => {
		const doc = await renderDoc('## Promote and roll back\n\n### `skif deploy` flags\n\n## Promote and roll back', opts);
		expect(doc.headings.map((h) => h.id)).toEqual([
			'promote-and-roll-back',
			'skif-deploy-flags',
			'promote-and-roll-back-1'
		]);
		expect(doc.html).toContain('id="promote-and-roll-back"');
	});

	test('doc links resolve through href; unknown slugs are reported', async () => {
		const doc = await renderDoc(
			'[a](/deploying/static-sites#promote) [b](/nope/missing) [c](https://example.com)',
			opts
		);
		expect(doc.html).toContain('href="/docs/deploying/static-sites#promote"');
		expect(doc.html).toContain('target="_blank"');
		expect(doc.brokenLinks).toEqual(['/nope/missing']);
	});

	test('callouts render as notes', async () => {
		const doc = await renderDoc('> [!WARNING]\n> This deletes data.', opts);
		expect(doc.html).toContain('docs-callout-warning');
		expect(doc.html).toContain('This deletes data.');
		expect(doc.html).not.toContain('[!WARNING]');
	});

	test('code is highlighted with dual themes; raw HTML is escaped', async () => {
		const doc = await renderDoc('```sh\nskif deploy ./dist\n```\n\n<script>alert(1)</script>', opts);
		expect(doc.html).toContain('--shiki-dark');
		expect(doc.html).toContain('data-lang="sh"');
		expect(doc.html).not.toContain('<script>');
	});

	test('mermaid fences become diagram figures, kept out of search text', async () => {
		const doc = await renderDoc('## Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```', opts);
		expect(doc.html).toContain('class="docs-diagram"');
		expect(doc.html).toContain('data-source="flowchart LR\n  A --&gt; B"');
		expect(doc.diagrams).toEqual(['flowchart LR\n  A --> B']);
		expect(doc.sections[1]!.text).toBe('');
		expect(doc.sections[1]!.markdown).toContain('```mermaid');
	});

	test('search sections split on h2/h3', async () => {
		const doc = await renderDoc('---\ntitle: T\ndescription: D\n---\nIntro text.\n\n## One\n\nBody one.', opts);
		expect(doc.sections).toEqual([
			{ anchor: '', heading: 'T', depth: 0, text: 'Intro text.', markdown: 'Intro text.' },
			{ anchor: 'one', heading: 'One', depth: 2, text: 'Body one.', markdown: '## One\n\nBody one.' }
		]);
	});
});

test('helpers', () => {
	expect(slugifyHeading('What’s new in v2?')).toBe('whats-new-in-v2');
	expect(parseDocHref('/a/b/#x')).toEqual({ slug: 'a/b', hash: '#x' });
	expect(parseDocHref('https://x')).toBeNull();
});
