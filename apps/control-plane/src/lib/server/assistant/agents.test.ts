import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ASSISTANT_SYSTEM } from './agents';
import { GUIDE_TOOL } from './constants';

const mcpSource = readFileSync(new URL('../mcp.ts', import.meta.url), 'utf8');
const registered = new Set(
	[...mcpSource.matchAll(/\n\ttool\(\n\t\t'([a-z_]+)',/g)].map((match) => match[1])
);
const toolsSource = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8');
const gated = [...toolsSource.matchAll(/^\t([a-z_]+): '[a-zA-Z]+:[a-z-]+',?$/gm)].map(
	(match) => match[1]!
);

describe('assistant prompt', () => {
	test('every tool the prompt names is registered in the MCP catalog', () => {
		expect(registered.size).toBeGreaterThan(20);
		const named = new Set(
			[...ASSISTANT_SYSTEM.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0])
		);
		named.delete(GUIDE_TOOL);
		expect(named.size).toBeGreaterThan(10);
		for (const name of named)
			expect({ name, registered: registered.has(name) }).toMatchObject({ registered: true });
	});

	test('every permission-gated write tool exists', () => {
		expect(gated.length).toBeGreaterThan(20);
		for (const name of gated)
			expect({ name, registered: registered.has(name) }).toMatchObject({ registered: true });
	});
});
