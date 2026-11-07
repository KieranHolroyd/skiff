import type { CaddyHandler, CaddyRoute } from './compile.ts';

/**
 * Edge-generated pages for requests no site answers: an unclaimed subdomain, an unconnected
 * domain, a missing page, an offline worker or an unexpected error. Each page is one
 * self-contained HTML document (no external assets, so it renders even when everything else is
 * down) sent from a Caddy `static_response`.
 *
 * Caddy expands `{...}` placeholders in the body. CSS rules are never known placeholder names, so
 * they pass through untouched; only `{http.error.*}`, which is numeric or a random id, is used
 * deliberately. The request host is never written into the page server-side. A reflected Host
 * header could inject markup or poison a cache, so the page reads `location.host` in the browser
 * and sets it with `textContent`.
 */
export type ErrorPageKind = 'no-site' | 'unknown-host' | 'not-found' | 'unavailable' | 'error' | 'awaiting-deploy';

interface ErrorPage {
	/** The large figure. A placeholder for the generic error page. */
	code: string;
	title: string;
	message: string;
	hint?: string;
	/** A shell command shown under the hint, for the site owner. */
	command?: string;
	/** `dashboard` links to the project in the dashboard when the caller passes its URL. */
	action: 'home' | 'retry' | 'dashboard' | null;
	icon: string;
	/** What the chip under the message shows: the requested host, or the requested path. */
	subject: 'host' | 'path';
	/** Reload on its own (seconds), for outages that should clear up without the visitor. */
	refresh?: number;
}

const ICONS = {
	compass:
		'<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"/>',
	link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m2 2 20 20"/>',
	file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9.5 12.5 5 5"/><path d="m14.5 12.5-5 5"/>',
	cloud:
		'<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><path d="M12 11v3"/><path d="M12 17h.01"/>',
	rocket:
		'<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
	alert:
		'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};

const PAGES: Record<ErrorPageKind, ErrorPage> = {
	'no-site': {
		code: '404',
		title: 'No site here',
		message: 'Nothing is deployed at this address.',
		hint: 'Check the address for typos. If this was your project, it may have been renamed or removed.',
		action: null,
		icon: ICONS.compass,
		subject: 'host',
	},
	'unknown-host': {
		code: '404',
		title: 'Domain not connected',
		message: 'This domain points at this server, but it is not connected to a site.',
		hint: 'If you own this domain, add it to a project and verify it. Changes can take a minute to apply.',
		action: null,
		icon: ICONS.link,
		subject: 'host',
	},
	'not-found': {
		code: '404',
		title: 'Page not found',
		message: 'The page you are looking for does not exist or has moved.',
		action: 'home',
		icon: ICONS.file,
		subject: 'path',
	},
	unavailable: {
		code: '503',
		title: 'Temporarily unavailable',
		message: 'This site cannot be reached right now. It should be back shortly.',
		hint: 'This page retries on its own every 30 seconds.',
		action: 'retry',
		icon: ICONS.cloud,
		subject: 'host',
		refresh: 30,
	},
	'awaiting-deploy': {
		code: 'READY',
		title: 'Nothing deployed yet',
		message: 'This project is set up, but it has no deployment yet.',
		hint: 'If this is your project, deploy a directory to put your site here:',
		command: 'skiff deploy',
		action: 'dashboard',
		icon: ICONS.rocket,
		subject: 'host',
	},
	error: {
		code: '{http.error.status_code}',
		title: 'Something went wrong',
		message: 'An unexpected error stopped this page from loading.',
		hint: 'Try again in a moment. If it keeps happening, quote the reference below to the site owner.',
		action: 'retry',
		icon: ICONS.alert,
		subject: 'host',
	},
};

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#0a0a0a;--muted:#737373;--border:#e5e5e5;--accent:#171717;--accent-fg:#fafafa;--code:#f5f5f5}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--card:#141414;--fg:#fafafa;--muted:#a3a3a3;--border:#262626;--accent:#fafafa;--accent-fg:#0a0a0a;--code:#1f1f1f}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:440px;text-align:center}
.icon{width:48px;height:48px;margin:0 auto 20px;display:grid;place-items:center;border:1px solid var(--border);border-radius:12px;background:var(--card);color:var(--muted)}
.icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.code{margin:0 0 4px;font:500 13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;color:var(--muted)}
h1{margin:0 0 8px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.02em}
p{margin:0 auto 12px;color:var(--muted);max-width:380px}
.host{display:inline-block;max-width:100%;overflow-wrap:anywhere;padding:2px 8px;border:1px solid var(--border);border-radius:6px;background:var(--code);color:var(--fg);font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.actions{margin-top:24px}
.btn{display:inline-flex;align-items:center;height:36px;padding:0 16px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:500;line-height:1;font-family:inherit;text-decoration:none;cursor:pointer}
.btn:hover{opacity:.88}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cmd{display:inline-block;margin:0 0 12px;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--code);color:var(--fg);font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ref{margin-top:28px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);opacity:.8}
`
	.trim()
	.replace(/\n/g, '');

/** Braces are escaped too, so Caddy never expands a `{...}` placeholder from caller data. */
function escapeHtml(value: string): string {
	return value.replace(/[&<>"'{}]/g, (char) => `&#${char.charCodeAt(0)};`);
}

export interface ErrorPageOptions {
	/** Absolute dashboard URL for the `dashboard` action; without it the button is left out. */
	dashboardUrl?: string;
}

/** The full HTML document for one page. */
export function renderErrorPage(kind: ErrorPageKind, options: ErrorPageOptions = {}): string {
	const page = PAGES[kind];
	const dashboardUrl = options.dashboardUrl && /^https?:\/\//.test(options.dashboardUrl) ? options.dashboardUrl : null;
	const action =
		page.action === 'home'
			? '<div class="actions"><a class="btn" href="/">Go to homepage</a></div>'
			: page.action === 'retry'
				? '<div class="actions"><button class="btn" type="button" onclick="location.reload()">Try again</button></div>'
				: page.action === 'dashboard' && dashboardUrl
					? `<div class="actions"><a class="btn" href="${escapeHtml(dashboardUrl)}" rel="nofollow">Open in dashboard</a></div>`
					: '';
	const ref =
		kind === 'error'
			? '<div class="ref">Reference {http.error.id}</div>'
			: '';
	return [
		'<!doctype html><html lang="en"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		'<meta name="robots" content="noindex">',
		page.refresh ? `<meta http-equiv="refresh" content="${page.refresh}">` : '',
		`<title>${escapeHtml(page.title)}</title>`,
		`<style>${STYLE}</style></head><body><main>`,
		`<div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24">${page.icon}</svg></div>`,
		`<p class="code">${page.code}</p>`,
		`<h1>${escapeHtml(page.title)}</h1>`,
		`<p>${escapeHtml(page.message)}</p>`,
		`<p><span class="host" id="subject">${page.subject === 'path' ? 'this page' : 'this address'}</span></p>`,
		page.hint ? `<p>${escapeHtml(page.hint)}</p>` : '',
		page.command ? `<code class="cmd">${escapeHtml(page.command)}</code>` : '',
		action,
		ref,
		`</main><script>document.getElementById("subject").textContent=location.${page.subject === 'path' ? 'pathname' : 'host'}</script></body></html>`,
	].join('');
}

/** Plain text for curl, API clients and anything else that did not ask for HTML. */
export function renderErrorText(kind: ErrorPageKind): string {
	const page = PAGES[kind];
	const ref = kind === 'error' ? ` (reference {http.error.id})` : '';
	return `${page.code} ${page.title}. ${page.message}${ref}\n`;
}

/**
 * A handler that answers with the page: HTML when the client accepts it, plain text otherwise.
 * `status` may be a placeholder such as `{http.error.status_code}`.
 */
export function errorPageHandler(
	kind: ErrorPageKind,
	status: number | string,
	headers: Record<string, string[]> = {},
	options: ErrorPageOptions = {},
): CaddyHandler {
	const base = { 'Cache-Control': ['no-store'], 'X-Robots-Tag': ['noindex'], ...headers };
	const html: CaddyRoute = {
		match: [{ header: { Accept: ['*text/html*'] } }],
		handle: [
			{
				handler: 'static_response',
				status_code: status,
				headers: { ...base, 'Content-Type': ['text/html; charset=utf-8'] },
				body: renderErrorPage(kind, options),
			},
		],
		terminal: true,
	};
	const text: CaddyRoute = {
		handle: [
			{
				handler: 'static_response',
				status_code: status,
				headers: { ...base, 'Content-Type': ['text/plain; charset=utf-8'] },
				body: renderErrorText(kind),
			},
		],
	};
	return { handler: 'subroute', routes: [html, text] };
}
