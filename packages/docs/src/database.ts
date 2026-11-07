import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { DocsLibrary } from './library.ts';
import { searchDocs } from './search.ts';

/**
 * The docs as an embedded, searchable database for agents (the MCP server and the dashboard
 * assistant). One row per page section in an in-memory SQLite FTS5 table, ranked with BM25
 * (headings weigh most, then page titles, then body text) and Porter-stemmed so "deploying" finds
 * "deploy".
 *
 * It is built from the Markdown bundled into the running build, on first use. A platform update
 * ships a new build, so the index always describes the version that is running: there is nothing
 * to migrate or refresh by hand. `info().fingerprint` changes whenever any page does.
 */

export interface DocsSearchResult {
	slug: string;
	anchor: string;
	page: string;
	section: string;
	heading: string;
	url: string;
	/** Excerpt with matches wrapped in `**…**`. */
	snippet: string;
	score: number;
}

export interface DocsSectionSummary {
	anchor: string;
	heading: string;
	depth: number;
}

export interface DocsReadResult {
	slug: string;
	title: string;
	description: string;
	section: string;
	url: string;
	/** The requested section's Markdown, or the whole page. */
	markdown: string;
	/** Every section on the page, to read more selectively. */
	sections: DocsSectionSummary[];
	prev: string | null;
	next: string | null;
}

export interface DocsDatabaseInfo {
	pages: number;
	sections: number;
	/** sha256 over every page's Markdown (first 16 hex chars). */
	fingerprint: string;
	/** The platform version these docs shipped with. */
	version: string;
	engine: 'fts5' | 'fallback';
}

export interface DocsDatabase {
	info(): Promise<DocsDatabaseInfo>;
	search(query: string, options?: { limit?: number; section?: string }): Promise<DocsSearchResult[]>;
	read(slug: string, anchor?: string): Promise<DocsReadResult | null>;
	/** Sections and pages, for browsing. */
	outline(): { id: string; title: string; pages: { slug: string; title: string; description: string }[] }[];
}

export interface DocsDatabaseOptions {
	version: string;
	/** Absolute URL for a page, e.g. `https://control.example.com/docs/<slug>`. */
	url: (slug: string, anchor?: string) => string;
}

interface Row {
	slug: string;
	anchor: string;
	page: string;
	section: string;
	heading: string;
	depth: number;
	markdown: string;
}

/**
 * FTS5 MATCH expression from free text: every word must match (`mode: 'all'`) or any word
 * (`'any'`), the last as a prefix.
 */
export function ftsQuery(query: string, mode: 'all' | 'any' = 'all'): string | null {
	const words = query
		.toLowerCase()
		.split(/[^\p{L}\p{N}_]+/u)
		.filter((word) => word.length > 0)
		.slice(0, 12);
	if (words.length === 0) return null;
	return words
		.map((word, index) => `"${word.replace(/"/g, '')}"${index === words.length - 1 ? '*' : ''}`)
		.join(mode === 'all' ? ' ' : ' OR ');
}

export function createDocsDatabase(library: DocsLibrary, options: DocsDatabaseOptions): DocsDatabase {
	let built: Promise<{ db: Database | null; rows: Row[]; info: DocsDatabaseInfo }> | null = null;

	const build = () => {
		built ??= (async () => {
			const rows: Row[] = [];
			const hash = createHash('sha256');
			for (const section of library.nav()) {
				for (const { slug } of section.pages) {
					const page = (await library.page(slug))!;
					for (const part of page.sections) {
						rows.push({
							slug,
							anchor: part.anchor,
							page: page.title,
							section: page.section.title,
							heading: part.anchor ? part.heading : page.title,
							depth: part.depth,
							markdown: part.anchor ? part.markdown : `${page.description}\n\n${part.markdown}`.trim()
						});
						hash.update(`${slug}#${part.anchor}\n${part.markdown}\n`);
					}
				}
			}

			let db: Database | null = null;
			try {
				db = new Database(':memory:');
				db.run(
					`CREATE VIRTUAL TABLE docs USING fts5(
						heading, page, body,
						slug UNINDEXED, anchor UNINDEXED, section UNINDEXED, depth UNINDEXED,
						tokenize = 'porter unicode61'
					)`
				);
				const insert = db.prepare(
					'INSERT INTO docs (heading, page, body, slug, anchor, section, depth) VALUES (?, ?, ?, ?, ?, ?, ?)'
				);
				db.transaction(() => {
					for (const row of rows)
						insert.run(row.heading, row.page, row.markdown, row.slug, row.anchor, row.section, row.depth);
				})();
			} catch {
				// SQLite without FTS5: fall back to the in-process scorer the search boxes use.
				db?.close();
				db = null;
			}

			return {
				db,
				rows,
				info: {
					pages: library.nav().reduce((total, section) => total + section.pages.length, 0),
					sections: rows.length,
					fingerprint: hash.digest('hex').slice(0, 16),
					version: options.version,
					engine: db ? 'fts5' : 'fallback'
				} satisfies DocsDatabaseInfo
			};
		})();
		return built;
	};

	return {
		async info() {
			return (await build()).info;
		},

		async search(query, { limit = 8, section } = {}) {
			const { db, rows } = await build();
			const max = Math.min(Math.max(1, Math.floor(limit)), 25);
			const match = ftsQuery(query);
			if (!match) return [];
			const sectionFilter = section?.trim().toLowerCase() || null;

			if (db) {
				type Hit = { slug: string; anchor: string; page: string; section: string; heading: string; snippet: string; score: number };
				const statement = db.query<Hit, [string, string | null, string | null, number]>(
					`SELECT slug, anchor, page, section, heading,
						snippet(docs, 2, '**', '**', '…', 24) AS snippet,
						bm25(docs, 10.0, 4.0, 1.0) AS score
					FROM docs
					WHERE docs MATCH ?1
						AND (?2 IS NULL OR lower(section) = ?3)
					ORDER BY score
					LIMIT ?4`
				);
				// Sections matching every word first; then any-word matches fill the remaining slots.
				const found = statement.all(match, sectionFilter, sectionFilter, max);
				const anyMatch = ftsQuery(query, 'any');
				if (found.length < max && anyMatch && anyMatch !== match) {
					const seen = new Set(found.map((hit) => `${hit.slug}#${hit.anchor}`));
					for (const hit of statement.all(anyMatch, sectionFilter, sectionFilter, max)) {
						if (found.length >= max) break;
						if (!seen.has(`${hit.slug}#${hit.anchor}`)) found.push(hit);
					}
				}
				return found.map((row) => ({
					...row,
					url: options.url(row.slug, row.anchor || undefined),
					snippet: row.snippet.replace(/\s+/g, ' ').trim(),
					score: Math.round(-row.score * 1000) / 1000
				}));
			}

			const entries = rows
				.filter((row) => !sectionFilter || row.section.toLowerCase() === sectionFilter)
				.map((row) => ({ ...row, text: row.markdown }));
			return searchDocs(entries, query, max).map((hit) => ({
				slug: hit.entry.slug,
				anchor: hit.entry.anchor,
				page: hit.entry.page,
				section: hit.entry.section,
				heading: hit.entry.heading,
				url: options.url(hit.entry.slug, hit.entry.anchor || undefined),
				snippet: hit.snippet,
				score: hit.score
			}));
		},

		async read(rawSlug, anchor) {
			const slug = rawSlug.trim().replace(/^\/+|\/+$/g, '').replace(/^docs\//, '').replace(/\.md$/, '');
			const page = await library.page(slug);
			if (!page) return null;
			const wanted = anchor?.trim().replace(/^#/, '');
			const sections = page.sections.filter((part) => part.anchor);
			let markdown: string;
			if (wanted) {
				const index = page.sections.findIndex((part) => part.anchor === wanted);
				if (index === -1) return null;
				// A section includes its subsections.
				const start = page.sections[index]!;
				const parts = [start];
				for (const part of page.sections.slice(index + 1)) {
					if (start.depth === 2 && part.depth === 3) parts.push(part);
					else break;
				}
				markdown = parts.map((part) => part.markdown).join('\n\n');
			} else {
				markdown = page.sections.map((part) => part.markdown).join('\n\n');
			}
			return {
				slug,
				title: page.title,
				description: page.description,
				section: page.section.title,
				url: options.url(slug, wanted),
				markdown,
				sections: sections.map((part) => ({ anchor: part.anchor, heading: part.heading, depth: part.depth })),
				prev: page.prev?.slug ?? null,
				next: page.next?.slug ?? null
			};
		},

		outline() {
			return library.nav().map((section) => ({
				id: section.id,
				title: section.title,
				pages: section.pages.map(({ slug, title, description }) => ({ slug, title, description }))
			}));
		}
	};
}
