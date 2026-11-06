/**
 * A small Markdown subset for assistant replies, parsed into tokens that Svelte renders as
 * elements. There is no `{@html}` anywhere on this path: model output can quote tool results and
 * logs (prompt-injection territory), so the renderer can only ever produce the elements below.
 *
 * Supported: paragraphs, ATX headings (shown at most as h3), fenced code blocks, bullet and
 * numbered lists (with indentation depth), block quotes, pipe tables, horizontal rules, and inline
 * **bold**, *italic*, `code`, [links](/path) and bare https URLs. It is tolerant of a stream that
 * stops mid-token: an unclosed fence is a code block, an unclosed `**` is literal text.
 */

export type Inline =
	| { type: 'text'; text: string }
	| { type: 'strong'; children: Inline[] }
	| { type: 'em'; children: Inline[] }
	| { type: 'code'; text: string }
	| { type: 'link'; href: string; internal: boolean; children: Inline[] }
	| { type: 'br' };

export interface ListItem {
	depth: number;
	children: Inline[];
	checked?: boolean;
}

export type Block =
	| { type: 'paragraph'; children: Inline[] }
	| { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
	| { type: 'code'; lang: string; text: string; open: boolean }
	| { type: 'list'; ordered: boolean; start: number; items: ListItem[] }
	| { type: 'quote'; children: Inline[] }
	| {
			type: 'table';
			header: Inline[][];
			align: Array<'left' | 'center' | 'right' | null>;
			rows: Inline[][][];
	  }
	| { type: 'hr' };

/** Relative dashboard paths and http(s) URLs only; everything else renders as plain text. */
export function safeHref(raw: string): { href: string; internal: boolean } | null {
	const href = raw.trim();
	if (/^\/(?!\/)/.test(href)) return { href, internal: true };
	try {
		const url = new URL(href);
		if (url.protocol === 'http:' || url.protocol === 'https:')
			return { href: url.href, internal: false };
	} catch {
		// not a URL
	}
	return null;
}

const URL_RE = /https?:\/\/[^\s<>()[\]`*]+[^\s<>()[\]`*.,;:!?'"]/y;

export function parseInline(source: string): Inline[] {
	const out: Inline[] = [];
	let text = '';
	const flush = () => {
		if (text) out.push({ type: 'text', text });
		text = '';
	};
	let i = 0;
	while (i < source.length) {
		const ch = source[i]!;
		const rest = source.slice(i);

		// Escapes.
		if (ch === '\\' && i + 1 < source.length && /[\\`*_[\]()#|>-]/.test(source[i + 1]!)) {
			text += source[i + 1];
			i += 2;
			continue;
		}

		// Inline code: match the same number of backticks.
		if (ch === '`') {
			const ticks = /^`+/.exec(rest)![0];
			const close = source.indexOf(ticks, i + ticks.length);
			if (close > -1) {
				flush();
				out.push({
					type: 'code',
					text: source.slice(i + ticks.length, close).replace(/^ (.+) $/, '$1')
				});
				i = close + ticks.length;
				continue;
			}
		}

		// Bold / italic.
		if (ch === '*' || ch === '_') {
			const double = source[i + 1] === ch;
			const marker = double ? ch + ch : ch;
			const intraword = ch === '_' && i > 0 && /\w/.test(source[i - 1]!);
			if (!intraword && source[i + marker.length] && !/\s/.test(source[i + marker.length]!)) {
				const close = findClose(source, marker, i + marker.length);
				if (close > -1) {
					flush();
					const children = parseInline(source.slice(i + marker.length, close));
					out.push(double ? { type: 'strong', children } : { type: 'em', children });
					i = close + marker.length;
					continue;
				}
			}
		}

		// [label](href)
		if (ch === '[') {
			const labelEnd = matchBracket(source, i);
			if (labelEnd > -1 && source[labelEnd + 1] === '(') {
				const hrefEnd = matchParen(source, labelEnd + 1);
				if (hrefEnd > -1) {
					const label = source.slice(i + 1, labelEnd);
					const rawHref = source.slice(labelEnd + 2, hrefEnd).split(/\s+"/)[0] ?? '';
					const safe = safeHref(rawHref);
					flush();
					if (safe) out.push({ type: 'link', ...safe, children: parseInline(label) });
					else out.push(...parseInline(label));
					i = hrefEnd + 1;
					continue;
				}
			}
		}

		// Bare URL.
		if (ch === 'h' && (rest.startsWith('http://') || rest.startsWith('https://'))) {
			URL_RE.lastIndex = i;
			const match = URL_RE.exec(source);
			if (match) {
				const safe = safeHref(match[0]);
				if (safe) {
					flush();
					out.push({ type: 'link', ...safe, children: [{ type: 'text', text: match[0] }] });
					i += match[0].length;
					continue;
				}
			}
		}

		// Hard line break inside a paragraph.
		if (ch === '\n') {
			flush();
			out.push({ type: 'br' });
			i += 1;
			continue;
		}

		text += ch;
		i += 1;
	}
	flush();
	return out;
}

function findClose(source: string, marker: string, from: number): number {
	let index = from;
	while (index < source.length) {
		const found = source.indexOf(marker, index);
		if (found < 0) return -1;
		// Closing marker must follow a non-space and not be part of a longer run (*** etc.).
		if (!/\s/.test(source[found - 1]!) && source[found + marker.length] !== marker[0]) return found;
		index = found + 1;
	}
	return -1;
}

function matchParen(source: string, open: number): number {
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === '(') depth += 1;
		else if (source[i] === ')') {
			depth -= 1;
			if (depth === 0) return i;
		} else if (source[i] === '\n' || (source[i] === ' ' && depth === 1 && source[i + 1] !== '"'))
			return -1;
	}
	return -1;
}

function matchBracket(source: string, open: number): number {
	let depth = 0;
	for (let i = open; i < source.length; i += 1) {
		if (source[i] === '\\') {
			i += 1;
			continue;
		}
		if (source[i] === '[') depth += 1;
		else if (source[i] === ']') {
			depth -= 1;
			if (depth === 0) return i;
		} else if (source[i] === '\n') return -1;
	}
	return -1;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_DIVIDER_CELLS = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** A GFM delimiter row; it must contain a pipe so a lone `---` stays a rule. */
const TABLE_DIVIDER = {
	test: (line: string) => line.includes('|') && TABLE_DIVIDER_CELLS.test(line)
};

function splitRow(line: string): string[] {
	let row = line.trim();
	if (row.startsWith('|')) row = row.slice(1);
	if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
	const cells: string[] = [];
	let cell = '';
	let inCode = false;
	for (let i = 0; i < row.length; i += 1) {
		const ch = row[i]!;
		if (ch === '\\' && row[i + 1] === '|') {
			cell += '|';
			i += 1;
		} else if (ch === '`') {
			inCode = !inCode;
			cell += ch;
		} else if (ch === '|' && !inCode) {
			cells.push(cell.trim());
			cell = '';
		} else cell += ch;
	}
	cells.push(cell.trim());
	return cells;
}

function isBlockStart(line: string): boolean {
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		BULLET.test(line) ||
		ORDERED.test(line) ||
		HR.test(line) ||
		QUOTE.test(line)
	);
}

export function parseMarkdown(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const blocks: Block[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			i += 1;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence) {
			const marker = fence[1]!;
			const body: string[] = [];
			i += 1;
			let open = true;
			while (i < lines.length) {
				const current = lines[i]!;
				if (
					current.trim().startsWith(marker[0]!.repeat(marker.length)) &&
					current.trim().replace(/[`~]/g, '') === ''
				) {
					open = false;
					i += 1;
					break;
				}
				body.push(current);
				i += 1;
			}
			blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n'), open });
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
			blocks.push({ type: 'heading', level, children: parseInline(heading[2] ?? '') });
			i += 1;
			continue;
		}

		if (HR.test(line)) {
			blocks.push({ type: 'hr' });
			i += 1;
			continue;
		}

		// Table: header row, then a divider row.
		if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
			const header = splitRow(line);
			const align = splitRow(lines[i + 1]!).map((cell) =>
				cell.startsWith(':') && cell.endsWith(':')
					? ('center' as const)
					: cell.endsWith(':')
						? ('right' as const)
						: cell.startsWith(':')
							? ('left' as const)
							: null
			);
			i += 2;
			const rows: Inline[][][] = [];
			while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
				const cells = splitRow(lines[i]!);
				rows.push(header.map((_, index) => parseInline(cells[index] ?? '')));
				i += 1;
			}
			blocks.push({ type: 'table', header: header.map((cell) => parseInline(cell)), align, rows });
			continue;
		}

		if (QUOTE.test(line)) {
			const body: string[] = [];
			while (i < lines.length && QUOTE.test(lines[i]!)) {
				body.push(QUOTE.exec(lines[i]!)![1] ?? '');
				i += 1;
			}
			blocks.push({ type: 'quote', children: parseInline(body.join('\n')) });
			continue;
		}

		const bullet = BULLET.exec(line);
		const ordered = ORDERED.exec(line);
		if (bullet || ordered) {
			const isOrdered = !bullet;
			const start = ordered ? Number(ordered[2]) : 1;
			const items: ListItem[] = [];
			const baseIndent = (bullet ?? ordered)![1]!.length;
			while (i < lines.length) {
				const current = lines[i]!;
				const b = BULLET.exec(current);
				const o = ORDERED.exec(current);
				const match = b ?? o;
				if (match) {
					// A different list type at the base indent starts a new list.
					if (match[1]!.length <= baseIndent && Boolean(o) !== isOrdered) break;
					const depth = Math.min(3, Math.floor(Math.max(0, match[1]!.length - baseIndent) / 2));
					const text = b ? (b[3] ?? '') : (o![3] ?? '');
					items.push({
						depth,
						children: parseInline(text),
						...(b && b[2] !== undefined ? { checked: b[2] !== ' ' } : {})
					});
					i += 1;
					continue;
				}
				// Lazy continuation of the previous item.
				if (current.trim() && /^\s+/.test(current) && items.length > 0) {
					const last = items[items.length - 1]!;
					last.children.push({ type: 'br' }, ...parseInline(current.trim()));
					i += 1;
					continue;
				}
				// One blank line between items keeps the list together.
				if (
					!current.trim() &&
					i + 1 < lines.length &&
					(BULLET.test(lines[i + 1]!) || ORDERED.test(lines[i + 1]!))
				) {
					i += 1;
					continue;
				}
				break;
			}
			blocks.push({ type: 'list', ordered: isOrdered, start, items });
			continue;
		}

		// Paragraph: until a blank line or another block starts.
		const body: string[] = [line];
		i += 1;
		while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) {
			if (lines[i]!.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!))
				break;
			body.push(lines[i]!);
			i += 1;
		}
		blocks.push({ type: 'paragraph', children: parseInline(body.join('\n').trim()) });
	}

	return blocks;
}

/** Plain text of inline tokens (used for copy-as-text and titles). */
export function inlineText(children: Inline[]): string {
	return children
		.map((child) => {
			switch (child.type) {
				case 'text':
				case 'code':
					return child.text;
				case 'br':
					return '\n';
				default:
					return inlineText(child.children);
			}
		})
		.join('');
}
