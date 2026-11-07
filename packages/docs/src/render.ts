import { Marked, Renderer, type Token, type Tokens } from 'marked';
import { parseFrontmatter } from './frontmatter.ts';
import { escapeHtml, getHighlighter, highlightCode } from './highlight.ts';

/**
 * Markdown → HTML for docs pages. Content is authored in this repository (trusted), but raw HTML
 * in Markdown is still escaped so the only markup a page can produce is what this renderer emits.
 *
 * Doc links are written as absolute slug paths (`/deploying/static-sites#promote`); the host
 * decides what URL a slug lives at through `href`, so the same source renders under `/docs/…`
 * in the dashboard and at the root of the standalone site.
 */

export interface DocHeading {
	depth: 2 | 3;
	id: string;
	text: string;
}

export interface DocSearchSection {
	/** Heading anchor, or `''` for the page's introduction. */
	anchor: string;
	heading: string;
	/** Heading depth (2 or 3); 0 for the introduction. */
	depth: number;
	/** Plain text for search, capped. */
	text: string;
	/** The section's Markdown source (heading included), uncapped, for agents to read. */
	markdown: string;
}

export interface RenderedDoc {
	title: string;
	description: string;
	html: string;
	headings: DocHeading[];
	sections: DocSearchSection[];
	/** Doc links whose slug is not a known page (the build and tests fail on these). */
	brokenLinks: string[];
	/** Sources of the page's ```mermaid diagrams, for validation. */
	diagrams: string[];
}

export interface RenderOptions {
	/** Whether a slug is a published page. */
	isPage: (slug: string) => boolean;
	/** The URL a page is served at, e.g. `/docs/deploying/static-sites`. */
	href: (slug: string) => string;
}

const CALLOUTS = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const;
const CALLOUT_LABEL: Record<(typeof CALLOUTS)[number], string> = {
	NOTE: 'Note',
	TIP: 'Tip',
	IMPORTANT: 'Important',
	WARNING: 'Warning',
	CAUTION: 'Caution'
};

const COPY_BUTTON =
	'<button type="button" class="docs-copy" data-docs-copy aria-label="Copy code">Copy</button>';

/** GitHub-style heading anchors: lower-case, punctuation dropped, spaces to hyphens. */
export function slugifyHeading(text: string): string {
	return text
		.toLowerCase()
		.replace(/<[^>]*>/g, '')
		.replace(/&[a-z]+;|&#\d+;/g, '')
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.trim()
		.replace(/\s/g, '-');
}

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

/** `/section/page/#anchor` → `{ slug: 'section/page', hash: '#anchor' }`. */
export function parseDocHref(href: string): { slug: string; hash: string } | null {
	if (!href.startsWith('/') || href.startsWith('//')) return null;
	const hashAt = href.indexOf('#');
	const path = hashAt === -1 ? href : href.slice(0, hashAt);
	const hash = hashAt === -1 ? '' : href.slice(hashAt);
	const slug = path
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
		.replace(/\.md$/, '');
	return { slug, hash };
}

/** Rough plain text of a block token, for search. */
function plainText(token: Token): string {
	if (token.type === 'code')
		return (token as Tokens.Code).lang?.trim().toLowerCase() === 'mermaid' ? '' : (token as Tokens.Code).text;
	if (token.type === 'space' || token.type === 'hr') return '';
	return token.raw
		.replace(/^>\s?\[![A-Z]+\]\s*$/gm, '')
		.replace(/^\s*[>#|*+-]+\s?/gm, '')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*_|]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export async function renderDoc(source: string, options: RenderOptions): Promise<RenderedDoc> {
	const highlighter = await getHighlighter();
	const { frontmatter, body } = parseFrontmatter(source);

	const headings: DocHeading[] = [];
	const brokenLinks: string[] = [];
	const diagrams: string[] = [];
	const usedIds = new Map<string, number>();

	const uniqueId = (text: string) => {
		const base = slugifyHeading(text) || 'section';
		const seen = usedIds.get(base) ?? 0;
		usedIds.set(base, seen + 1);
		return seen === 0 ? base : `${base}-${seen}`;
	};

	const marked = new Marked({ gfm: true, async: false });
	marked.use({
		renderer: {
			heading({ tokens, depth }) {
				const inner = this.parser.parseInline(tokens);
				const text = stripTags(inner);
				const id = uniqueId(text);
				const level = Math.min(Math.max(depth, 2), 4);
				if (level === 2 || level === 3) headings.push({ depth: level, id, text });
				return `<h${level} id="${id}"><a class="docs-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${level}>\n`;
			},
			code({ text, lang }) {
				if ((lang ?? '').trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid') {
					// Rendered to SVG in the browser (see diagrams.ts); until then, and without
					// JavaScript, the source shows as a code block.
					diagrams.push(text);
					return `<figure class="docs-diagram" data-mermaid data-source="${escapeHtml(text)}"><pre class="docs-mermaid-source"><code>${escapeHtml(text)}</code></pre></figure>\n`;
				}
				const label = (lang ?? '').trim().split(/\s+/)[0] ?? '';
				return `<div class="docs-code"${label ? ` data-lang="${escapeHtml(label)}"` : ''}>${COPY_BUTTON}${highlightCode(highlighter, text, lang)}</div>\n`;
			},
			blockquote({ tokens }) {
				let inner = this.parser.parse(tokens);
				const match = /^<p>\[!([A-Z]+)\][ \t]*(?:\n|<br\s*\/?>)?\s*/.exec(inner);
				const kind = match?.[1] as (typeof CALLOUTS)[number] | undefined;
				if (match && kind && CALLOUTS.includes(kind)) {
					inner = '<p>' + inner.slice(match[0].length);
					inner = inner.replace(/^<p>\s*<\/p>\s*/, '');
					return `<div class="docs-callout docs-callout-${kind.toLowerCase()}" role="note"><p class="docs-callout-title">${CALLOUT_LABEL[kind]}</p>${inner}</div>\n`;
				}
				return `<blockquote>${inner}</blockquote>\n`;
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
				const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
				if (href.startsWith('#')) return `<a href="${escapeHtml(href)}"${titleAttr}>${inner}</a>`;
				const doc = parseDocHref(href);
				if (doc) {
					if (!options.isPage(doc.slug)) {
						brokenLinks.push(href);
						return `<a href="${escapeHtml(href)}"${titleAttr} class="docs-broken">${inner}</a>`;
					}
					return `<a href="${escapeHtml(options.href(doc.slug) + doc.hash)}"${titleAttr}>${inner}</a>`;
				}
				if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) {
					return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${inner}</a>`;
				}
				brokenLinks.push(href);
				return inner;
			},
			table(token) {
				return `<div class="docs-table">${Renderer.prototype.table.call(this, token)}</div>\n`;
			},
			image({ text }) {
				return escapeHtml(text);
			},
			html({ text }) {
				return escapeHtml(text);
			}
		}
	});

	const tokens = marked.lexer(body);

	// Search sections: the introduction, then one entry per h2/h3.
	const sections: DocSearchSection[] = [];
	let current: DocSearchSection = {
		anchor: '',
		heading: frontmatter.title,
		depth: 0,
		text: '',
		markdown: ''
	};
	const searchIds = new Map<string, number>();
	for (const token of tokens) {
		if (token.type === 'heading' && (token.depth === 2 || token.depth === 3)) {
			if (current.markdown.trim() || current.anchor === '') sections.push(current);
			const text = stripTags(marked.parseInline(token.text) as string);
			const base = slugifyHeading(text) || 'section';
			const seen = searchIds.get(base) ?? 0;
			searchIds.set(base, seen + 1);
			current = {
				anchor: seen === 0 ? base : `${base}-${seen}`,
				heading: text,
				depth: token.depth,
				text: '',
				markdown: token.raw
			};
			continue;
		}
		current.markdown += token.raw;
		const text = plainText(token);
		if (text && current.text.length < 1200) current.text = `${current.text} ${text}`.trim();
	}
	sections.push(current);
	for (const section of sections) {
		section.text = section.text.slice(0, 1200);
		section.markdown = section.markdown.trim();
	}

	const html = marked.parser(tokens);
	return {
		title: frontmatter.title,
		description: frontmatter.description,
		html,
		headings,
		sections,
		brokenLinks: [...new Set(brokenLinks)],
		diagrams
	};
}
