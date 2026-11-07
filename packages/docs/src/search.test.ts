import { expect, test } from 'bun:test';
import type { SearchEntry } from './library.ts';
import { searchDocs } from './search.ts';

const entry = (heading: string, text: string, anchor = 'x'): SearchEntry => ({
	slug: 'a/b',
	anchor,
	page: 'Static sites',
	section: 'Deploying',
	heading,
	text
});

test('every term must match; headings outrank body text', () => {
	const entries = [
		entry('Limits', 'You can roll back any deployment.'),
		entry('Promote and roll back', 'Move production.'),
		entry('Other', 'Nothing here.')
	];
	const hits = searchDocs(entries, 'roll back');
	expect(hits.map((h) => h.entry.heading)).toEqual(['Promote and roll back', 'Limits']);
	expect(searchDocs(entries, '')).toEqual([]);
	expect(hits[1]!.snippet).toContain('roll back');
});
