import { resolve } from '$app/paths';
import { createLibrary, filesBySlug } from '@yoal/docs';
import { createDocsDatabase } from '@yoal/docs/database';
import { platformOrigin } from './config';
import { platformVersion } from './version';

/**
 * The user documentation, served inside the dashboard at `/docs` and searchable by agents (MCP
 * `search_docs` / `read_docs`, which the dashboard assistant shares). The Markdown lives in
 * `packages/docs/content` (shared with the standalone docs site in `apps/docs`); Vite inlines it
 * at build time, so a running control plane never reads docs from disk, and a platform update
 * always brings the docs (and the search index built from them) for the version it installs.
 */
const files = import.meta.glob('../../../../../packages/docs/content/**/*.md', {
	query: '?raw',
	import: 'default',
	eager: true
}) as Record<string, string>;

const pagePath = (slug: string) => resolve('/(dashboard)/docs/[...slug]', { slug });

export const docs = createLibrary(filesBySlug(files), { href: pagePath });

/** In-memory SQLite FTS5 index over every section, built on first use. */
export const docsDatabase = createDocsDatabase(docs, {
	version: platformVersion,
	url: (slug, anchor) => `${platformOrigin}${pagePath(slug)}${anchor ? `#${anchor}` : ''}`
});
