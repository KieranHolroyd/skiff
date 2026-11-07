import type { SearchEntry } from './library.ts';

/**
 * Client-side docs search over the section index: every query word must appear somewhere in the
 * entry (as a substring, so results update while typing). Matches in a heading
 * outrank matches in the page title, which outrank matches in body text.
 */

export interface SearchHit {
	entry: SearchEntry;
	score: number;
	/** A short excerpt around the first body match, or the start of the text. */
	snippet: string;
}

function words(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}_.-]+/u)
		.filter(Boolean);
}

function snippetAround(text: string, term: string, radius = 70): string {
	const at = term ? text.toLowerCase().indexOf(term) : -1;
	if (at < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2).trimEnd()}…` : text;
	const start = Math.max(0, at - radius);
	const end = Math.min(text.length, at + term.length + radius);
	return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export function searchDocs(entries: SearchEntry[], query: string, limit = 8): SearchHit[] {
	const terms = words(query);
	if (terms.length === 0) return [];
	const hits: SearchHit[] = [];
	for (const entry of entries) {
		const heading = entry.heading.toLowerCase();
		const page = entry.page.toLowerCase();
		const text = entry.text.toLowerCase();
		let score = 0;
		let matched = true;
		for (const term of terms) {
			const has = (haystack: string) => haystack.includes(term);
			if (has(heading)) score += heading.startsWith(term) ? 12 : 8;
			else if (has(page)) score += 5;
			else if (has(text)) score += 1;
			else {
				matched = false;
				break;
			}
		}
		if (!matched) continue;
		if (heading === query.trim().toLowerCase()) score += 10;
		if (!entry.anchor) score += 1;
		const firstBodyTerm = terms.find((term) => text.includes(term)) ?? '';
		hits.push({ entry, score, snippet: snippetAround(entry.text, firstBodyTerm) });
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
