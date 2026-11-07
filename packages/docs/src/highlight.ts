import {
	createHighlighterCore,
	type HighlighterCore,
	type LanguageRegistration
} from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Build-time / server-side syntax highlighting for docs code blocks. Shiki's core with the
 * JavaScript regex engine (no WASM, so it bundles cleanly into the control plane), two themes
 * emitted as CSS variables (`--shiki-light` / `--shiki-dark`) so each host picks by its own
 * colour scheme.
 */

const GRAMMARS: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
	shellscript: () => import('shiki/langs/shellscript.mjs'),
	typescript: () => import('shiki/langs/typescript.mjs'),
	javascript: () => import('shiki/langs/javascript.mjs'),
	json: () => import('shiki/langs/json.mjs'),
	jsonc: () => import('shiki/langs/jsonc.mjs'),
	yaml: () => import('shiki/langs/yaml.mjs'),
	toml: () => import('shiki/langs/toml.mjs'),
	sql: () => import('shiki/langs/sql.mjs'),
	ini: () => import('shiki/langs/ini.mjs'),
	dotenv: () => import('shiki/langs/dotenv.mjs'),
	python: () => import('shiki/langs/python.mjs'),
	html: () => import('shiki/langs/html.mjs'),
	css: () => import('shiki/langs/css.mjs'),
	dockerfile: () => import('shiki/langs/dockerfile.mjs'),
	diff: () => import('shiki/langs/diff.mjs'),
	http: () => import('shiki/langs/http.mjs'),
	systemd: () => import('shiki/langs/systemd.mjs'),
	php: () => import('shiki/langs/php.mjs')
};

const ALIASES: Record<string, string> = {
	sh: 'shellscript',
	bash: 'shellscript',
	zsh: 'shellscript',
	shell: 'shellscript',
	console: 'shellscript',
	ts: 'typescript',
	js: 'javascript',
	mjs: 'javascript',
	yml: 'yaml',
	env: 'dotenv',
	py: 'python',
	docker: 'dockerfile',
	postgres: 'sql',
	psql: 'sql'
};

/** The grammar a fence's info string asks for, or `null` for plain text. */
export function resolveLang(info: string | undefined): string | null {
	const lang = (info ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	if (!lang) return null;
	const resolved = ALIASES[lang] ?? lang;
	return resolved in GRAMMARS ? resolved : null;
}

let highlighter: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
	highlighter ??= createHighlighterCore({
		themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
		langs: Object.values(GRAMMARS).map((load) => load()),
		engine: createJavaScriptRegexEngine()
	});
	return highlighter;
}

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;'
};

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

export function highlightCode(hl: HighlighterCore, code: string, info: string | undefined): string {
	const lang = resolveLang(info);
	if (!lang) return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
	return hl.codeToHtml(code, {
		lang,
		themes: { light: 'github-light', dark: 'github-dark' },
		defaultColor: false
	});
}
