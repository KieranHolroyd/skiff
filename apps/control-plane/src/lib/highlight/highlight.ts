import type { HighlighterCore, LanguageInput } from 'shiki/core';

/**
 * Read-only syntax highlighting for guides, snippets and assistant replies: Shiki's core with the
 * JavaScript regex engine (no WASM), two themes and grammars loaded only when a block needs them.
 * Monaco stays for editing; this is for displaying code.
 *
 * Output is tokens, not HTML, so components render plain text nodes (no `{@html}`). Each token
 * carries `--hl-light` / `--hl-dark` colours that `.hl` in layout.css picks between; text in the
 * theme's default foreground gets no colour and inherits the dashboard's.
 */

const GRAMMARS = {
	typescript: () => import('shiki/langs/typescript.mjs'),
	javascript: () => import('shiki/langs/javascript.mjs'),
	tsx: () => import('shiki/langs/tsx.mjs'),
	json: () => import('shiki/langs/json.mjs'),
	jsonc: () => import('shiki/langs/jsonc.mjs'),
	yaml: () => import('shiki/langs/yaml.mjs'),
	toml: () => import('shiki/langs/toml.mjs'),
	shellscript: () => import('shiki/langs/shellscript.mjs'),
	sql: () => import('shiki/langs/sql.mjs'),
	ini: () => import('shiki/langs/ini.mjs'),
	dotenv: () => import('shiki/langs/dotenv.mjs'),
	systemd: () => import('shiki/langs/systemd.mjs'),
	prisma: () => import('shiki/langs/prisma.mjs'),
	python: () => import('shiki/langs/python.mjs'),
	ruby: () => import('shiki/langs/ruby.mjs'),
	go: () => import('shiki/langs/go.mjs'),
	rust: () => import('shiki/langs/rust.mjs'),
	dockerfile: () => import('shiki/langs/dockerfile.mjs'),
	nginx: () => import('shiki/langs/nginx.mjs'),
	diff: () => import('shiki/langs/diff.mjs'),
	html: () => import('shiki/langs/html.mjs'),
	css: () => import('shiki/langs/css.mjs'),
	svelte: () => import('shiki/langs/svelte.mjs'),
	xml: () => import('shiki/langs/xml.mjs')
} satisfies Record<string, () => Promise<{ default: LanguageInput }>>;

export type HighlightLang = keyof typeof GRAMMARS;

const ALIASES: Record<string, HighlightLang> = {
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	jsx: 'tsx',
	yml: 'yaml',
	sh: 'shellscript',
	bash: 'shellscript',
	zsh: 'shellscript',
	shell: 'shellscript',
	console: 'shellscript',
	terminal: 'shellscript',
	postgres: 'sql',
	postgresql: 'sql',
	psql: 'sql',
	mysql: 'sql',
	mariadb: 'sql',
	sqlite: 'sql',
	clickhouse: 'sql',
	conf: 'ini',
	cfg: 'ini',
	env: 'dotenv',
	service: 'systemd',
	socket: 'systemd',
	timer: 'systemd',
	path: 'systemd',
	py: 'python',
	rb: 'ruby',
	golang: 'go',
	rs: 'rust',
	docker: 'dockerfile',
	patch: 'diff',
	htm: 'html',
	svg: 'xml'
};

function lookup(word: string): HighlightLang | null {
	const key = word.toLowerCase();
	if (key in GRAMMARS) return key as HighlightLang;
	return ALIASES[key] ?? null;
}

/**
 * The grammar for a language name, fence tag or file label such as `src/index.ts`,
 * `worker · /etc/systemd/system/skiff-agent.service` or `skiff-function.json → bindings`.
 * Returns null when nothing matches, which renders as plain text.
 */
export function resolveLang(hint: string | null | undefined): HighlightLang | null {
	if (!hint) return null;
	const direct = lookup(hint.trim());
	if (direct) return direct;
	// Look at each path-ish word, last first (the filename usually trails any context prefix).
	const words = hint
		.split(/[\s·→,()]+/)
		.filter(Boolean)
		.reverse();
	for (const word of words) {
		const base = word.split('/').pop() ?? word;
		if (/^dockerfile$/i.test(base)) return 'dockerfile';
		if (/^\.env(\..+)?$/i.test(base)) return 'dotenv';
		const dot = base.lastIndexOf('.');
		if (dot > 0 || (dot === 0 && base.length > 1)) {
			const fromExt = lookup(base.slice(dot + 1));
			if (fromExt) return fromExt;
		}
	}
	return null;
}

export interface HighlightToken {
	text: string;
	/** Inline style setting `--hl-light` / `--hl-dark`, or undefined for the default foreground. */
	style?: string;
}

const LIGHT = 'github-light';
const DARK = 'github-dark';

let highlighter: Promise<HighlighterCore> | null = null;
const loading = new Map<HighlightLang, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
	highlighter ??= Promise.all([
		import('shiki/core'),
		import('shiki/engine/javascript'),
		import('shiki/themes/github-light.mjs'),
		import('shiki/themes/github-dark.mjs')
	]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
		createHighlighterCore({
			engine: createJavaScriptRegexEngine({ forgiving: true }),
			themes: [light.default, dark.default],
			langs: []
		})
	);
	return highlighter;
}

async function ensureLang(core: HighlighterCore, lang: HighlightLang): Promise<void> {
	let pending = loading.get(lang);
	if (!pending) {
		pending = GRAMMARS[lang]().then((grammar) => core.loadLanguage(grammar.default));
		loading.set(lang, pending);
		pending.catch(() => loading.delete(lang));
	}
	await pending;
}

/** Highlighted lines for `code`, or null when the language is unknown or loading fails. */
export async function highlight(
	code: string,
	hint: string | null | undefined
): Promise<HighlightToken[][] | null> {
	const lang = resolveLang(hint);
	if (!lang) return null;
	try {
		const core = await getHighlighter();
		await ensureLang(core, lang);
		const result = core.codeToTokens(code, {
			lang,
			themes: { light: LIGHT, dark: DARK },
			defaultColor: false
		});
		const fg = result.fg ?? '';
		return result.tokens.map((line) => {
			const merged: HighlightToken[] = [];
			for (const token of line) {
				const light = token.htmlStyle?.['--shiki-light'];
				const dark = token.htmlStyle?.['--shiki-dark'];
				const isDefault =
					!light || fg.toLowerCase().includes(`--shiki-light:${light.toLowerCase()}`);
				const style = isDefault ? undefined : `--hl-light:${light};--hl-dark:${dark ?? light}`;
				const last = merged.at(-1);
				if (last && last.style === style) last.text += token.content;
				else merged.push({ text: token.content, style });
			}
			return merged;
		});
	} catch {
		return null;
	}
}
