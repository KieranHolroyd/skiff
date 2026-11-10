import * as z from 'zod';

/**
 * Static site configuration: Netlify-compatible `_redirects` and `_headers`, plus optional
 * `yoal.json` (DESIGN §4.1, D30). Parsing is strict: a deploy fails with a precise error
 * rather than silently serving the wrong thing.
 */

export const siteConfigSchema = z.object({
	spa: z.boolean().default(false),
	cleanUrls: z.boolean().default(false),
	trailingSlash: z.enum(['always', 'never', 'ignore']).default('ignore'),
	notFound: z.string().min(1).max(1024).nullable().default(null),
});
export type SiteConfig = z.infer<typeof siteConfigSchema>;

export interface Redirect {
	from: string;
	to: string;
	status: number;
}

export interface HeaderRule {
	path: string;
	headers: Record<string, string>;
}

export interface ConfigIssue {
	file: '_redirects' | '_headers' | 'yoal.json';
	line?: number;
	message: string;
}

export class SiteConfigError extends Error {
	readonly issues: ConfigIssue[];
	constructor(issues: ConfigIssue[]) {
		super(issues.map((i) => `${i.file}${i.line ? `:${i.line}` : ''}: ${i.message}`).join('\n'));
		this.name = 'SiteConfigError';
		this.issues = issues;
	}
}

export interface ParsedConfig {
	config: SiteConfig;
	redirects: Redirect[];
	headers: HeaderRule[];
}

export const DEFAULT_CONFIG: SiteConfig = {
	spa: false,
	cleanUrls: false,
	trailingSlash: 'ignore',
	notFound: null,
};

const REDIRECT_STATUSES = new Set([200, 301, 302, 303, 307, 308, 404, 410, 451]);
const MAX_REDIRECTS = 1000;
const MAX_HEADER_RULES = 500;

type FileMap = ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;

function readText(files: FileMap, name: string): string | undefined {
	const raw = files instanceof Map ? files.get(name) : (files as Record<string, Uint8Array>)[name];
	if (!raw) return undefined;
	return new TextDecoder().decode(raw).replace(/^\uFEFF/, '');
}

export function parseSiteConfig(files: FileMap): ParsedConfig {
	const issues: ConfigIssue[] = [];
	// `skiff.json` is the pre-rename name; projects deployed before the rebrand keep using it.
	const config = parseYoalJson(readText(files, 'yoal.json') ?? readText(files, 'skiff.json'), issues);
	const redirects = parseRedirects(readText(files, '_redirects'), issues);
	const headers = parseHeaders(readText(files, '_headers'), issues);
	if (issues.length) throw new SiteConfigError(issues);
	return { config, redirects, headers };
}

function parseYoalJson(text: string | undefined, issues: ConfigIssue[]): SiteConfig {
	if (text === undefined) return { ...DEFAULT_CONFIG };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		issues.push({ file: 'yoal.json', message: `Invalid JSON: ${(error as Error).message}` });
		return { ...DEFAULT_CONFIG };
	}
	const parsed = siteConfigSchema.safeParse(value);
	if (!parsed.success) {
		for (const issue of parsed.error.issues)
			issues.push({ file: 'yoal.json', message: `${issue.path.join('.') || 'root'}: ${issue.message}` });
		return { ...DEFAULT_CONFIG };
	}
	if (parsed.data.notFound && !parsed.data.notFound.startsWith('/')) {
		issues.push({ file: 'yoal.json', message: '`notFound` must start with "/".' });
	}
	if (parsed.data.notFound?.includes('..')) {
		issues.push({ file: 'yoal.json', message: '`notFound` may not contain "..".' });
	}
	return parsed.data;
}

function parseRedirects(text: string | undefined, issues: ConfigIssue[]): Redirect[] {
	if (text === undefined) return [];
	const redirects: Redirect[] = [];
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim();
		if (!line || line.startsWith('#')) return;
		const parts = line.split(/\s+/);
		if (parts.length < 2 || parts.length > 3) {
			issues.push({ file: '_redirects', line: index + 1, message: 'Expected "<from> <to> [status]".' });
			return;
		}
		const [from, to, statusText] = parts as [string, string, string | undefined];
		if (!from.startsWith('/')) {
			issues.push({ file: '_redirects', line: index + 1, message: '`from` must start with "/".' });
			return;
		}
		if (from.includes('..') || to.includes('..')) {
			issues.push({ file: '_redirects', line: index + 1, message: 'Paths may not contain "..".' });
			return;
		}
		const status = statusText === undefined ? 301 : Number(statusText);
		if (!Number.isInteger(status) || !REDIRECT_STATUSES.has(status)) {
			issues.push({
				file: '_redirects',
				line: index + 1,
				message: `Unsupported status ${statusText}; use one of ${[...REDIRECT_STATUSES].join(', ')}.`,
			});
			return;
		}
		const pattern = compilePattern(from);
		if (pattern.error) {
			issues.push({ file: '_redirects', line: index + 1, message: pattern.error });
			return;
		}
		redirects.push({ from, to, status });
		if (redirects.length > MAX_REDIRECTS)
			issues.push({ file: '_redirects', message: `At most ${MAX_REDIRECTS} redirects are supported.` });
	});
	return redirects;
}

function parseHeaders(text: string | undefined, issues: ConfigIssue[]): HeaderRule[] {
	if (text === undefined) return [];
	const rules: HeaderRule[] = [];
	let current: HeaderRule | undefined;
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trimEnd();
		if (!line.trim() || line.trim().startsWith('#')) return;
		if (!/^\s/.test(line)) {
			const path = line.trim();
			if (!path.startsWith('/')) {
				issues.push({ file: '_headers', line: index + 1, message: 'Path must start with "/".' });
				current = undefined;
				return;
			}
			current = { path, headers: {} };
			rules.push(current);
			if (rules.length > MAX_HEADER_RULES)
				issues.push({ file: '_headers', message: `At most ${MAX_HEADER_RULES} header rules are supported.` });
			return;
		}
		if (!current) {
			issues.push({ file: '_headers', line: index + 1, message: 'Header line before any path.' });
			return;
		}
		const match = /^\s+([!#$%&'*+\-.^_`|~0-9A-Za-z]+):\s*(.+)$/.exec(line);
		if (!match) {
			issues.push({ file: '_headers', line: index + 1, message: 'Expected "Name: value".' });
			return;
		}
		const [, name, value] = match as unknown as [string, string, string];
		if (/[^\t\x20-\x7e\x80-\xff]/.test(value)) {
			issues.push({ file: '_headers', line: index + 1, message: 'Header value contains control characters.' });
			return;
		}
		current.headers[name] = value;
	});
	return rules;
}

export interface CompiledPattern {
	regex: string;
	/** Ordered names of captured groups, e.g. ['id', 'splat']. */
	groups: Array<{ name: string; splat: boolean }>;
	error?: string;
}

/**
 * Netlify path patterns: literal paths, `:placeholder` (one segment) and a trailing `*` (splat).
 * Compiled to a Caddy `path_regexp` matcher with named groups.
 */
export function compilePattern(pattern: string): CompiledPattern {
	const groups: CompiledPattern['groups'] = [];
	let regex = '^';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === ':') {
			const rest = pattern.slice(i + 1);
			const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
			if (!match) return { regex: '', groups: [], error: 'Empty placeholder name.' };
			const name = match[0];
			groups.push({ name, splat: false });
			regex += `(?P<${name}>[^/]+)`;
			i += name.length;
			continue;
		}
		if (char === '*') {
			if (i !== pattern.length - 1) return { regex: '', groups: [], error: '`*` is only allowed at the end.' };
			groups.push({ name: 'splat', splat: true });
			regex += '(?P<splat>.*)';
			continue;
		}
		regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
	return { regex: `${regex}$`, groups };
}

/** Translate a Netlify target (`/posts/:id`, `/old/*`) to a Caddy placeholder template. */
export function compileTarget(target: string): string {
	return target
		.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{http.regexp.$1}')
		.replace(/\*/g, '{http.regexp.splat}');
}
