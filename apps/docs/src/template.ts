import type { DocPage, NavSection } from '@skiff/docs';

/**
 * HTML for the standalone docs site. Plain template strings: every page is static, and the only
 * script is the small progressive-enhancement bundle (search, theme, mobile nav, copy buttons).
 */

export interface SiteContext {
	/** URL prefix the site is served under, always ending in `/` (e.g. `/` or `/docs/`). */
	base: string;
	/** Absolute origin + base for canonical links, if known (e.g. `https://docs.example.com/`). */
	siteUrl: string | null;
	nav: NavSection[];
	assets: { css: string; js: string; favicon: string; fonts: string[] };
	version: string;
	repoUrl: string;
}

export const LOGO_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1b2235"/><g fill="none" stroke="#f0743a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 6.5v10"/><path d="M16 7.5 9.5 16.5H16"/></g><path d="M5.5 20h21l-3.2 5.2H8.7Z" fill="#eef1f7"/></svg>';

const ICON = {
	search:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
	menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
	sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
	moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
	github:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>',
	arrowLeft: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
	arrowRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>'
};

export function esc(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export function pageUrl(ctx: SiteContext, slug: string): string {
	return `${ctx.base}${slug}/`;
}

/** Applied before first paint so the page never flashes the wrong theme. */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('skiff-docs-theme');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}})();`;

function sidebar(ctx: SiteContext, current: string | null): string {
	return ctx.nav
		.map(
			(section) => `<div class="nav-section">
	<p class="nav-heading">${esc(section.title)}</p>
	<ul>${section.pages
		.map(
			(page) =>
				`<li><a href="${pageUrl(ctx, page.slug)}"${page.slug === current ? ' aria-current="page"' : ''}>${esc(page.title)}</a></li>`
		)
		.join('')}</ul>
</div>`
		)
		.join('\n');
}

function shell(
	ctx: SiteContext,
	options: {
		title: string;
		description: string;
		path: string | null;
		current: string | null;
		main: string;
		toc?: string;
		noindex?: boolean;
	}
): string {
	const canonical = ctx.siteUrl && options.path !== null ? `${ctx.siteUrl}${options.path}` : null;
	const fullTitle = options.current ? `${options.title} · Skiff Docs` : options.title;
	return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(options.description)}">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(options.description)}">
<meta property="og:type" content="website">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">\n<meta property="og:url" content="${esc(canonical)}">\n` : ''}${options.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="icon" href="${ctx.assets.favicon}" type="image/svg+xml">
${ctx.assets.fonts.map((font) => `<link rel="preload" href="${font}" as="font" type="font/woff2" crossorigin>`).join('\n')}
<link rel="stylesheet" href="${ctx.assets.css}">
<script>${THEME_BOOT}</script>
<script type="module" src="${ctx.assets.js}"></script>
</head>
<body data-base="${esc(ctx.base)}">
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
	<button class="icon-button nav-toggle" type="button" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar" data-nav-toggle>${ICON.menu}</button>
	<a class="brand" href="${ctx.base}">${LOGO_SVG}<span>Skiff</span><span class="brand-sub">Docs</span></a>
	<div class="search" data-search>
		<label class="search-box">
			${ICON.search}
			<input type="search" placeholder="Search docs" aria-label="Search docs" autocomplete="off" spellcheck="false" data-search-input>
			<kbd>/</kbd>
		</label>
		<div class="search-results" role="listbox" aria-label="Search results" hidden data-search-results></div>
	</div>
	<div class="topbar-actions">
		<span class="version" title="Skiff version these docs describe">v${esc(ctx.version)}</span>
		<a class="icon-button" href="${esc(ctx.repoUrl)}" aria-label="Skiff on GitHub" target="_blank" rel="noopener noreferrer">${ICON.github}</a>
		<button class="icon-button" type="button" aria-label="Toggle dark mode" data-theme-toggle><span class="when-light">${ICON.moon}</span><span class="when-dark">${ICON.sun}</span></button>
	</div>
</header>
<div class="layout">
	<nav class="sidebar" id="sidebar" aria-label="Documentation">
${sidebar(ctx, options.current)}
	</nav>
	<div class="scrim" data-nav-scrim hidden></div>
	<main id="content" class="content">
${options.main}
	</main>
	${options.toc ?? '<div class="toc-spacer"></div>'}
</div>
</body>
</html>
`;
}

export function renderDocPage(ctx: SiteContext, doc: DocPage): string {
	const pager =
		doc.prev || doc.next
			? `<nav class="pager" aria-label="Previous and next pages">
	${doc.prev ? `<a class="pager-link" href="${pageUrl(ctx, doc.prev.slug)}"><span>${ICON.arrowLeft} Previous</span><strong>${esc(doc.prev.title)}</strong></a>` : '<span></span>'}
	${doc.next ? `<a class="pager-link next" href="${pageUrl(ctx, doc.next.slug)}"><span>Next ${ICON.arrowRight}</span><strong>${esc(doc.next.title)}</strong></a>` : ''}
</nav>`
			: '';
	const toc =
		doc.headings.length > 1
			? `<aside class="toc" aria-label="On this page">
	<p class="toc-title">On this page</p>
	<ul>${doc.headings
		.map(
			(heading) =>
				`<li class="depth-${heading.depth}"><a href="#${heading.id}" data-toc-link="${heading.id}">${esc(heading.text)}</a></li>`
		)
		.join('')}</ul>
</aside>`
			: undefined;
	const main = `<article class="doc">
	<header class="doc-header">
		<p class="eyebrow">${esc(doc.section.title)}</p>
		<h1>${esc(doc.title)}</h1>
		${doc.description ? `<p class="lead">${esc(doc.description)}</p>` : ''}
	</header>
	<div class="docs-prose" data-prose>
${doc.html}
	</div>
	<p class="edit"><a href="${esc(`${ctx.repoUrl}/edit/main/packages/docs/content/${doc.slug}.md`)}" target="_blank" rel="noopener noreferrer">Edit this page on GitHub</a></p>
	${pager}
</article>`;
	return shell(ctx, {
		title: doc.title,
		description: doc.description,
		path: `${doc.slug}/`,
		current: doc.slug,
		main,
		toc
	});
}

export function renderHome(ctx: SiteContext, homeSlug: string): string {
	const cards = ctx.nav
		.map(
			(section) => `<section class="home-card">
	<h2>${esc(section.title)}</h2>
	<ul>${section.pages
		.map(
			(page) =>
				`<li><a href="${pageUrl(ctx, page.slug)}"><strong>${esc(page.title)}</strong><span>${esc(page.description)}</span></a></li>`
		)
		.join('')}</ul>
</section>`
		)
		.join('\n');
	const main = `<div class="home">
	<header class="home-hero">
		<div class="home-mark">${LOGO_SVG}</div>
		<h1>Skiff documentation</h1>
		<p class="lead">Your own little cloud. Deploy sites, functions, apps and managed data services to your own servers, from a CLI, a dashboard, or your AI agent.</p>
		<div class="home-actions">
			<a class="button primary" href="${pageUrl(ctx, 'getting-started/quickstart')}">Quickstart</a>
			<a class="button" href="${pageUrl(ctx, homeSlug)}">What is Skiff?</a>
		</div>
	</header>
	<div class="home-grid">
${cards}
	</div>
</div>`;
	return shell(ctx, {
		title: 'Skiff Docs',
		description: 'Documentation for Skiff, the lightweight self-hosted deploy platform.',
		path: '',
		current: null,
		main
	});
}

export function renderNotFound(ctx: SiteContext): string {
	const main = `<div class="not-found">
	<p class="eyebrow">404</p>
	<h1>Page not found</h1>
	<p class="lead">That page doesn't exist, or it has moved. Try searching, or start from the <a href="${ctx.base}">docs home</a>.</p>
</div>`;
	return shell(ctx, {
		title: 'Page not found · Skiff Docs',
		description: 'This docs page does not exist.',
		path: null,
		current: null,
		main,
		noindex: true
	});
}
