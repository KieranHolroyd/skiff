/**
 * Build the standalone docs site: plain static files that deploy anywhere, including to Yoal
 * itself (`yoal deploy dist`). Pages come from packages/docs/content, the same Markdown the
 * dashboard's /docs renders.
 *
 *   bun src/build.ts [--out dist] [--base /] [--site-url https://docs.example.com]
 *
 * `--base` (or DOCS_BASE) serves the site under a path prefix, e.g. `/yoal/` on GitHub Pages.
 * `--site-url` (or DOCS_SITE_URL) adds canonical links and a sitemap.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createLibrary } from '@yoal/docs';
import { readContent } from '@yoal/docs/disk';
import { pageUrl, renderDocPage, renderHome, renderNotFound, type SiteContext } from './template.ts';

const APP_DIR = resolve(import.meta.dir, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const REPO_URL = 'https://github.com/KieranHolroyd/yoal';

export interface BuildOptions {
	outDir: string;
	base: string;
	siteUrl: string | null;
	/** Skip minification (dev server). */
	dev?: boolean;
}

export interface BuildResult {
	pages: number;
	outDir: string;
	ms: number;
}

function normaliseBase(raw: string): string {
	const trimmed = raw.trim().replace(/^\/*/, '/').replace(/\/*$/, '/');
	return trimmed === '//' ? '/' : trimmed;
}

const hash = (data: string | Uint8Array) =>
	createHash('sha256').update(data).digest('hex').slice(0, 10);

function write(path: string, data: string | Uint8Array) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
}

function fontFile(pkg: string, file: string): string {
	return join(APP_DIR, 'node_modules', '@fontsource-variable', pkg, 'files', file);
}

export async function buildSite(options: BuildOptions): Promise<BuildResult> {
	const started = performance.now();
	const base = normaliseBase(options.base);
	const siteUrl = options.siteUrl ? options.siteUrl.replace(/\/*$/, '') + base : null;
	const out = resolve(options.outDir);

	const library = createLibrary(readContent(), { href: (slug) => `${base}${slug}/` });
	const problems = await library.problems();
	if (problems.length > 0) {
		throw new Error(`docs content has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
	}

	rmSync(out, { recursive: true, force: true });
	mkdirSync(join(out, 'assets'), { recursive: true });

	// Fonts, stylesheet and script get content-hashed names, which Yoal (and most CDNs) cache
	// as immutable.
	const fonts: Record<'sans' | 'mono', string> = { sans: '', mono: '' };
	for (const [key, pkg, file] of [
		['sans', 'geist', 'geist-latin-wght-normal.woff2'],
		['mono', 'geist-mono', 'geist-mono-latin-wght-normal.woff2']
	] as const) {
		const bytes = readFileSync(fontFile(pkg, file));
		const name = `assets/${pkg}.${hash(bytes)}.woff2`;
		write(join(out, name), bytes);
		fonts[key] = `${base}${name}`;
	}

	const css = [
		readFileSync(join(REPO_ROOT, 'packages/docs/src/prose.css'), 'utf8'),
		readFileSync(join(APP_DIR, 'src/site.css'), 'utf8')
	]
		.join('\n')
		.replace('__FONT_SANS__', fonts.sans)
		.replace('__FONT_MONO__', fonts.mono);
	const cssName = `assets/site.${hash(css)}.css`;
	write(join(out, cssName), css);

	// Code splitting keeps Mermaid (large) out of the entry script: it loads only on pages with a
	// diagram. Bun names every file by content hash, which Yoal caches as immutable.
	const bundle = await Bun.build({
		entrypoints: [join(APP_DIR, 'src/client.ts')],
		outdir: join(out, 'assets'),
		target: 'browser',
		format: 'esm',
		splitting: true,
		minify: !options.dev,
		publicPath: `${base}assets/`,
		naming: { entry: 'site.[hash].[ext]', chunk: 'chunk.[hash].[ext]', asset: 'asset.[hash].[ext]' }
	});
	if (!bundle.success) {
		throw new Error(`client bundle failed:\n${bundle.logs.map(String).join('\n')}`);
	}
	const entry = bundle.outputs.find((output) => output.kind === 'entry-point')!;
	const jsName = `assets/${entry.path.split('/').pop()}`;

	copyFileSync(join(REPO_ROOT, 'apps/control-plane/src/lib/assets/favicon.svg'), join(out, 'favicon.svg'));

	let version = '0.0.0';
	try {
		version = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim();
	} catch {
		// Not fatal: the badge just shows 0.0.0.
	}

	const ctx: SiteContext = {
		base,
		siteUrl,
		nav: library.nav(),
		assets: {
			css: `${base}${cssName}`,
			js: `${base}${jsName}`,
			favicon: `${base}favicon.svg`,
			fonts: [fonts.sans]
		},
		version,
		repoUrl: REPO_URL
	};

	const slugs = ctx.nav.flatMap((section) => section.pages.map((page) => page.slug));
	for (const slug of slugs) {
		const doc = (await library.page(slug))!;
		write(join(out, slug, 'index.html'), renderDocPage(ctx, doc));
	}
	write(join(out, 'index.html'), renderHome(ctx, library.home));
	write(join(out, '404.html'), renderNotFound(ctx));
	write(join(out, 'search.json'), JSON.stringify(await library.searchIndex()));

	// Yoal site config: pages are `<slug>/index.html`, so canonical URLs end in a slash.
	write(
		join(out, 'yoal.json'),
		JSON.stringify({ trailingSlash: 'always', notFound: `${base}404.html` }, null, 2) + '\n'
	);

	if (siteUrl) {
		const urls = ['', ...slugs.map((slug) => pageUrl({ ...ctx, base: '' }, slug))];
		write(
			join(out, 'sitemap.xml'),
			`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
				.map((path) => `  <url><loc>${siteUrl}${path}</loc></url>`)
				.join('\n')}\n</urlset>\n`
		);
		write(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${siteUrl}sitemap.xml\n`);
	} else {
		write(join(out, 'robots.txt'), 'User-agent: *\nAllow: /\n');
	}

	return { pages: slugs.length, outDir: out, ms: Math.round(performance.now() - started) };
}

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	if (index !== -1) return process.argv[index + 1];
	const inline = process.argv.find((value) => value.startsWith(`--${name}=`));
	return inline?.slice(name.length + 3);
}

if (import.meta.main) {
	try {
		const result = await buildSite({
			outDir: arg('out') ?? join(APP_DIR, 'dist'),
			base: arg('base') ?? process.env.DOCS_BASE ?? '/',
			siteUrl: arg('site-url') ?? process.env.DOCS_SITE_URL ?? null
		});
		console.log(`Built ${result.pages} docs pages into ${result.outDir} in ${result.ms} ms`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
