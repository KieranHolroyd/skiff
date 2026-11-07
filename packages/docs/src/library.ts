import { parseFrontmatter } from './frontmatter.ts';
import { ALL_SLUGS, HOME_SLUG, SECTIONS, type DocsSection } from './manifest.ts';
import { renderDoc, type DocHeading, type RenderedDoc } from './render.ts';

/**
 * The docs as a host sees them: the sidebar, a page by slug (rendered once, then cached), and a
 * search index. Hosts supply the raw files (the dashboard through Vite's `import.meta.glob`, the
 * standalone build from disk) and how a slug becomes a URL.
 */

export interface NavPage {
	slug: string;
	title: string;
	description: string;
}

export interface NavSection {
	id: string;
	title: string;
	icon: string;
	pages: NavPage[];
}

export interface DocPage extends RenderedDoc {
	slug: string;
	section: { id: string; title: string };
	prev: NavPage | null;
	next: NavPage | null;
}

export interface SearchEntry {
	slug: string;
	/** Heading anchor, `''` for the top of the page. */
	anchor: string;
	page: string;
	section: string;
	heading: string;
	text: string;
}

export interface DocsLibrary {
	readonly home: string;
	nav(): NavSection[];
	has(slug: string): boolean;
	page(slug: string): Promise<DocPage | null>;
	searchIndex(): Promise<SearchEntry[]>;
	/** Manifest/content mismatches and broken links, for tests and the standalone build. */
	problems(): Promise<string[]>;
}

export interface LibraryOptions {
	href: (slug: string) => string;
}

export type { DocHeading, DocsSection };

/** `…/content/deploying/static-sites.md` (any prefix) → `deploying/static-sites`. */
export function slugFromPath(path: string): string | null {
	const match = /(?:^|\/)content\/(.+)\.md$/.exec(path.replace(/\\/g, '/'));
	return match ? match[1]! : null;
}

/** Key a glob/fs result by slug. */
export function filesBySlug(files: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, raw] of Object.entries(files)) {
		const slug = slugFromPath(path);
		if (slug) out[slug] = raw;
	}
	return out;
}

export function createLibrary(sources: Record<string, string>, options: LibraryOptions): DocsLibrary {
	const sectionOf = new Map<string, DocsSection>();
	for (const section of SECTIONS) for (const slug of section.pages) sectionOf.set(slug, section);

	// Only pages that are both in the manifest and on disk are published.
	const published = ALL_SLUGS.filter((slug) => sources[slug] !== undefined);
	const publishedSet = new Set(published);

	const nav: NavSection[] = SECTIONS.map((section) => ({
		id: section.id,
		title: section.title,
		icon: section.icon,
		pages: section.pages
			.filter((slug) => publishedSet.has(slug))
			.map((slug) => {
				const { frontmatter } = parseFrontmatter(sources[slug]!);
				return { slug, title: frontmatter.title || slug, description: frontmatter.description };
			})
	})).filter((section) => section.pages.length > 0);

	const flat = nav.flatMap((section) => section.pages);
	const cache = new Map<string, Promise<DocPage>>();

	const render = (slug: string): Promise<DocPage> => {
		let pending = cache.get(slug);
		if (!pending) {
			pending = renderDoc(sources[slug]!, {
				isPage: (target) => publishedSet.has(target),
				href: options.href
			}).then((doc) => {
				const index = flat.findIndex((page) => page.slug === slug);
				const section = sectionOf.get(slug)!;
				return {
					...doc,
					title: doc.title || slug,
					slug,
					section: { id: section.id, title: section.title },
					prev: index > 0 ? flat[index - 1]! : null,
					next: index >= 0 && index < flat.length - 1 ? flat[index + 1]! : null
				};
			});
			cache.set(slug, pending);
		}
		return pending;
	};

	return {
		home: publishedSet.has(HOME_SLUG) ? HOME_SLUG : (published[0] ?? HOME_SLUG),
		nav: () => nav,
		has: (slug) => publishedSet.has(slug),
		page: async (slug) => (publishedSet.has(slug) ? render(slug) : null),
		async searchIndex() {
			const entries: SearchEntry[] = [];
			for (const slug of published) {
				const page = await render(slug);
				for (const section of page.sections) {
					entries.push({
						slug,
						anchor: section.anchor,
						page: page.title,
						section: page.section.title,
						heading: section.anchor ? section.heading : page.title,
						text: section.anchor ? section.text : `${page.description} ${section.text}`.trim()
					});
				}
			}
			return entries;
		},
		async problems() {
			const problems: string[] = [];
			const listed = new Set(ALL_SLUGS);
			for (const slug of ALL_SLUGS)
				if (sources[slug] === undefined) problems.push(`missing page: content/${slug}.md`);
			for (const slug of Object.keys(sources))
				if (!listed.has(slug)) problems.push(`not in manifest: content/${slug}.md`);
			for (const slug of published) {
				const { frontmatter } = parseFrontmatter(sources[slug]!);
				if (!frontmatter.title) problems.push(`${slug}: missing title`);
				if (!frontmatter.description) problems.push(`${slug}: missing description`);
				if (/^#\s/m.test(sources[slug]!.replace(/```[\s\S]*?```/g, '')))
					problems.push(`${slug}: body has an H1 (the title comes from frontmatter)`);
				const page = await render(slug);
				for (const link of page.brokenLinks) problems.push(`${slug}: broken link ${link}`);
			}
			return problems;
		}
	};
}
