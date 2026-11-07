import { describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { GUIDE_TOOL, SEARCH_TOOL } from './constants';
import { CORE_TOOLS, DEFER_THRESHOLD, createToolbox, rankTools } from './tool-search';
import type { AssistantTool } from './tools';

function fake(name: string, description = ''): AssistantTool {
	return {
		name,
		title: name.replaceAll('_', ' '),
		description,
		destructive: false,
		schema: z.object({}),
		run: async () => ({ ok: true, text: name })
	};
}

const named = [
	fake('list_projects', 'List projects in the organization.'),
	fake('get_project', 'Get one project.'),
	fake('redrive_queue', 'Move dead-lettered messages back onto a queue.'),
	fake('peek_queue_messages', 'Read messages on a queue without consuming them.'),
	fake('create_queue', 'Create a queue on a broker.'),
	fake('backup_database', 'Take a backup of a managed database now.'),
	fake('list_database_backups', 'List backups of a database.'),
	fake(GUIDE_TOOL, 'Show a guided tour.')
];
const filler = Array.from({ length: DEFER_THRESHOLD }, (_, i) => fake(`filler_tool_${i}`, 'Noise.'));
const big = [...named, ...filler];

describe('rankTools', () => {
	test('ranks name matches first and handles plurals', () => {
		const names = rankTools(big, 'database backups').map((tool) => tool.name);
		expect(names.slice(0, 2).sort()).toEqual(['backup_database', 'list_database_backups']);
	});

	test('select: loads exact names in order and skips unknown ones', () => {
		const names = rankTools(big, 'select:create_queue, nope ,get_project').map((tool) => tool.name);
		expect(names).toEqual(['create_queue', 'get_project']);
	});

	test('+term requires the term in the tool name', () => {
		const names = rankTools(big, '+redrive queue').map((tool) => tool.name);
		expect(names).toEqual(['redrive_queue']);
	});

	test('no match returns nothing', () => {
		expect(rankTools(big, 'kubernetes')).toEqual([]);
	});
});

describe('createToolbox', () => {
	test('a small catalog is offered whole, with no search tool', () => {
		const box = createToolbox(named);
		expect(box.deferring).toBe(false);
		expect(box.offered().map((tool) => tool.name)).toEqual(named.map((tool) => tool.name));
		expect(box.prompt()).toBe('');
		expect(box.find(SEARCH_TOOL)).toBeUndefined();
	});

	test('a large catalog offers the core set plus search, and lists the rest by name', () => {
		const box = createToolbox(big);
		expect(box.deferring).toBe(true);
		const offered = box.offered().map((tool) => tool.name);
		expect(offered).toContain(SEARCH_TOOL);
		for (const name of offered) if (name !== SEARCH_TOOL) expect(CORE_TOOLS.has(name)).toBe(true);
		expect(box.prompt()).toContain('redrive_queue');
		expect(box.prompt()).not.toContain('list_projects,');
		expect(box.isLoaded('redrive_queue')).toBe(false);
		expect(box.find('redrive_queue')?.name).toBe('redrive_queue');
	});

	test('search loads matches for the next round', async () => {
		const box = createToolbox(big);
		const before = box.version;
		const search = box.find(SEARCH_TOOL)!;
		const result = await search.run({ query: 'queue', max_results: 3 });
		expect(result.ok).toBe(true);
		expect(result.text).toContain('redrive_queue');
		expect(box.version).toBe(before + 1);
		expect(box.isLoaded('redrive_queue')).toBe(true);
		expect(box.offered().map((tool) => tool.name)).toContain('redrive_queue');
	});

	test('search rejects bad arguments and reports misses', async () => {
		const box = createToolbox(big);
		const search = box.find(SEARCH_TOOL)!;
		expect((await search.run({})).ok).toBe(false);
		const miss = await search.run({ query: 'kubernetes' });
		expect(miss.ok).toBe(true);
		expect(miss.text).toContain('No tools matched');
		expect(box.version).toBe(0);
	});

	test('core tools exist in the MCP catalog', async () => {
		const { readFileSync } = await import('node:fs');
		const source = readFileSync(new URL('../mcp.ts', import.meta.url), 'utf8');
		for (const name of CORE_TOOLS) {
			if (name === GUIDE_TOOL) continue;
			expect({ name, registered: source.includes(`'${name}'`) }).toMatchObject({
				registered: true
			});
		}
	});
});
