/**
 * The tiny frontmatter dialect docs pages use: a leading `---` block of `key: value` lines.
 * Values may be wrapped in single or double quotes. Nothing else (no nesting, no lists) because
 * pages only carry a title and a description.
 */

export interface Frontmatter {
	title: string;
	description: string;
	[key: string]: string;
}

export interface ParsedSource {
	frontmatter: Frontmatter;
	body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(source: string): ParsedSource {
	const match = FENCE.exec(source);
	const data: Record<string, string> = {};
	if (match) {
		for (const line of match[1]!.split(/\r?\n/)) {
			const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
			if (!kv) continue;
			let value = kv[2]!.trim();
			if (
				value.length >= 2 &&
				((value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'")))
			) {
				value = value.slice(1, -1);
			}
			data[kv[1]!] = value;
		}
	}
	return {
		frontmatter: { ...data, title: data.title ?? '', description: data.description ?? '' },
		body: match ? source.slice(match[0]!.length) : source
	};
}
