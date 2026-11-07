import { expect, test } from 'bun:test';
import { mermaidError } from '../scripts/mermaid-check.ts';
import { readContent } from './disk.ts';
import { createLibrary } from './library.ts';

const library = createLibrary(readContent(), { href: (slug) => `/${slug}` });

test('every manifest page exists, has frontmatter, and links only to real pages', async () => {
	expect(await library.problems()).toEqual([]);
});

test('every mermaid diagram parses', async () => {
	const failures: string[] = [];
	for (const section of library.nav())
		for (const { slug } of section.pages) {
			const page = (await library.page(slug))!;
			for (const [index, diagram] of page.diagrams.entries()) {
				const error = await mermaidError(diagram);
				if (error) failures.push(`${slug} diagram ${index + 1}: ${error}`);
			}
		}
	expect(failures).toEqual([]);
});
