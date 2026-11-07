/**
 * Check one docs page: `bun packages/docs/scripts/check-page.ts deploying/static-sites`.
 * Reports missing frontmatter, a body H1, links to slugs that aren't in the manifest, and code
 * fences without a language. Exit code 1 on any problem.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_SLUGS } from '../src/manifest.ts';
import { parseFrontmatter } from '../src/frontmatter.ts';
import { renderDoc } from '../src/render.ts';
import { mermaidError } from './mermaid-check.ts';

const slug = process.argv[2]?.replace(/\.md$/, '').replace(/^.*content\//, '');
if (!slug) {
	console.error('usage: bun packages/docs/scripts/check-page.ts <section/page>');
	process.exit(2);
}
if (!ALL_SLUGS.includes(slug)) {
	console.error(`${slug} is not in src/manifest.ts`);
	process.exit(1);
}
const source = readFileSync(join(import.meta.dir, '..', 'content', `${slug}.md`), 'utf8');
const { frontmatter, body } = parseFrontmatter(source);
const problems: string[] = [];
if (!frontmatter.title) problems.push('missing frontmatter title');
if (!frontmatter.description) problems.push('missing frontmatter description');
const prose = body.replace(/```[\s\S]*?```/g, '');
if (/^#\s/m.test(prose)) problems.push('body contains an H1 (#); start sections at ##');
let open = false;
for (const line of body.split('\n')) {
	const m = /^(\s*)```(.*)$/.exec(line);
	if (!m) continue;
	if (!open && !m[2]!.trim()) problems.push('code fence without a language (use text if none fits)');
	open = !open;
}
const doc = await renderDoc(source, { isPage: (s) => ALL_SLUGS.includes(s), href: (s) => `/${s}` });
for (const link of doc.brokenLinks) problems.push(`broken link: ${link}`);
for (const [index, diagram] of doc.diagrams.entries()) {
	const error = await mermaidError(diagram);
	if (error) problems.push(`mermaid diagram ${index + 1} does not parse: ${error}`);
}
const words = prose.split(/\s+/).filter(Boolean).length;
if (problems.length) {
	console.error(`${slug}: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log(`${slug}: ok (${words} words, ${doc.headings.length} headings)`);
