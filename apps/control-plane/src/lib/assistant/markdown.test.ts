import { describe, expect, test } from 'bun:test';
import { inlineText, parseInline, parseMarkdown, safeHref } from './markdown';

describe('assistant markdown', () => {
	test('only relative dashboard paths and http(s) URLs become links', () => {
		expect(safeHref('/projects/foo')).toEqual({ href: '/projects/foo', internal: true });
		expect(safeHref('https://example.com/a')).toEqual({
			href: 'https://example.com/a',
			internal: false
		});
		expect(safeHref('javascript:alert(1)')).toBeNull();
		expect(safeHref('//evil.example/x')).toBeNull();
		expect(safeHref('data:text/html,<script>')).toBeNull();
		const inline = parseInline('[click](javascript:alert(1)) and [ok](/nodes)');
		expect(inline.filter((token) => token.type === 'link')).toHaveLength(1);
		expect(inlineText(inline)).toBe('click and ok');
	});

	test('raw HTML stays text', () => {
		const blocks = parseMarkdown('<img src=x onerror=alert(1)>');
		expect(blocks).toEqual([
			{ type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] }
		]);
	});

	test('inline emphasis, code and bare URLs', () => {
		const inline = parseInline('**Down**: `api` see https://status.example.com/x.');
		expect(inline[0]).toEqual({ type: 'strong', children: [{ type: 'text', text: 'Down' }] });
		expect(inline).toContainEqual({ type: 'code', text: 'api' });
		const link = inline.find((token) => token.type === 'link');
		expect(link && link.type === 'link' && link.href).toBe('https://status.example.com/x');
		// snake_case and unclosed markers are literal.
		expect(inlineText(parseInline('list_projects **open'))).toBe('list_projects **open');
	});

	test('blocks: headings, lists, fences, tables, quotes', () => {
		const blocks = parseMarkdown(
			[
				'# Title',
				'',
				'- one',
				'  - nested',
				'- [x] done',
				'',
				'1. first',
				'2. second',
				'',
				'```sh',
				'yoal deploy',
				'```',
				'',
				'| Project | Status |',
				'|---|:-:|',
				'| a | ok |',
				'',
				'> note'
			].join('\n')
		);
		expect(blocks.map((block) => block.type)).toEqual([
			'heading',
			'list',
			'list',
			'code',
			'table',
			'quote'
		]);
		const bullets = blocks[1];
		expect(
			bullets?.type === 'list' && bullets.items.map((item) => [item.depth, item.checked])
		).toEqual([
			[0, undefined],
			[1, undefined],
			[0, true]
		]);
		const code = blocks[3];
		expect(code).toEqual({ type: 'code', lang: 'sh', text: 'yoal deploy', open: false });
		const table = blocks[4];
		expect(table?.type === 'table' && table.align).toEqual([null, 'center']);
	});

	test('a fence still streaming is an open code block', () => {
		const blocks = parseMarkdown('Run:\n```sh\nyoal dep');
		expect(blocks[1]).toEqual({ type: 'code', lang: 'sh', text: 'yoal dep', open: true });
	});
});
