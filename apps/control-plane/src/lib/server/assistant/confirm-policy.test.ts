import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as z from 'zod';
import { CONFIRM_TOOLS, needsConfirmation, validateToolArgs } from './confirm-policy';

const mcpSource = readFileSync(new URL('../mcp.ts', import.meta.url), 'utf8');
// Pipelines tools are declared in ../mcp-pipelines.ts and registered by mcp.ts in a loop.
const pipelineSource = readFileSync(new URL('../mcp-pipelines.ts', import.meta.url), 'utf8');
const pipelineToolNames = [...pipelineSource.matchAll(/\n\t\t\tname: '([a-z_]+)',/g)].map((match) => match[1]);
const registered = new Set([...[...mcpSource.matchAll(/\n\ttool\(\n\t\t'([a-z_]+)',/g)].map((match) => match[1]), ...pipelineToolNames]);

describe('assistant confirmation policy', () => {
	test('production-changing tools need a click even when not annotated destructive', () => {
		for (const name of [
			'set_access',
			'create_share_link',
			'promote_deployment',
			'rollback',
			'rotate_database_credentials',
			'create_database_credential',
			'rotate_database_credential',
			'deploy_site'
		])
			expect(needsConfirmation(name, { destructiveHint: false })).toBe(true);
		expect(needsConfirmation('whoami', { destructiveHint: false })).toBe(false);
		expect(needsConfirmation('delete_project', { destructiveHint: true })).toBe(true);
	});

	test('every confirm-list entry is a tool the MCP catalog registers', () => {
		expect(registered.size).toBeGreaterThan(20);
		for (const name of CONFIRM_TOOLS) expect(registered.has(name)).toBe(true);
	});

	test('arguments are parsed with the tool schema', () => {
		const schema = z.object({ project: z.string(), mode: z.enum(['public', 'private']).default('private') });
		expect(validateToolArgs('t', schema, { project: 'p' })).toEqual({
			ok: true,
			args: { project: 'p', mode: 'private' }
		});
		const bad = validateToolArgs('set_access', schema, { project: 1, mode: 'wide-open' });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toStartWith('Invalid arguments for set_access');
		expect(validateToolArgs('t', undefined, { a: 1 })).toEqual({ ok: true, args: { a: 1 } });
	});
});
