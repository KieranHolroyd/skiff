import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@skiff/core';
import { createDb } from '@skiff/db';

/** Log drain tools and `get_audit_log` paging (DESIGN §8) against a real core. */

const dir = mkdtempSync(join(tmpdir(), 'skiff-mcp-log-drains-'));
const opened = createDb({ path: ':memory:' });
const realCore: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(
			join(dir, 'objects'),
			'https://control.test',
			'object-secret-123'
		),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: { ...DEFAULT_FEATURES }
	}
});
const sent: string[] = [];
realCore.logDrains.fetch = async (input) => {
	sent.push(String(input));
	return new Response('', { status: 202 });
};
realCore.logDrains.resolveHost = async () => ['203.0.113.10'];

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { skiffToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');
const { CONFIRM_TOOLS } = await import('./assistant/confirm-policy');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return {
		ok: result.ok,
		text: result.text,
		body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null
	};
}

describe('log drain tools', () => {
	test('annotations: reads are read-only, delete is destructive, create asks in the assistant', () => {
		const tools = new Map(
			skiffToolDefinitions(owner).map((entry) => [entry.name, entry.config.annotations])
		);
		expect(tools.get('list_log_drains')).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false
		});
		expect(tools.get('create_log_drain')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false
		});
		expect(tools.get('test_log_drain')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false
		});
		expect(tools.get('delete_log_drain')).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true
		});
		expect(CONFIRM_TOOLS.has('create_log_drain')).toBe(true);
		const assistant = new Map(assistantTools(owner).map((tool) => [tool.name, tool.destructive]));
		expect(assistant.get('create_log_drain')).toBe(true);
		expect(assistant.get('delete_log_drain')).toBe(true);
		expect(assistant.get('test_log_drain')).toBe(false);
	});

	test('create, list, test and delete go through core', async () => {
		const created = await call(owner, 'create_log_drain', {
			name: 'archive',
			kind: 'webhook',
			url: 'https://logs.example.com/in',
			headers: { Authorization: 'Bearer hunter2' }
		});
		expect(created.ok).toBe(true);
		expect(created.body!.signingSecret).toMatch(/^whsec_/);
		expect(created.text).not.toContain('hunter2');
		const id = created.body!.drain.id as string;

		const listed = await call(viewer, 'list_log_drains', {});
		expect(listed.body!.drains.map((drain: { id: string }) => drain.id)).toEqual([id]);
		expect(listed.body!.canEdit).toBe(false);
		expect(listed.text).not.toContain('hunter2');

		const tested = await call(owner, 'test_log_drain', { id });
		expect(tested.body!.result).toMatchObject({ ok: true, status: 202 });
		expect(sent).toEqual(['https://logs.example.com/in']);

		const refused = await call(viewer, 'delete_log_drain', { id });
		expect(refused.ok).toBe(false);
		expect(refused.text).toContain('owners and admins');

		const deleted = await call(owner, 'delete_log_drain', { id });
		expect(deleted.body).toEqual({ ok: true, id });
		expect(realCore.logDrains.list(owner)).toEqual([]);
	});
});

describe('get_audit_log', () => {
	test('pages with nextCursor and filters by date range', async () => {
		for (let index = 0; index < 3; index += 1)
			realCore.audit.record({
				principal: owner,
				action: 'test.entry',
				resource: 'test',
				resourceId: `e${index}`,
				result: 'ok'
			});
		const first = await call(owner, 'get_audit_log', { action: 'test.entry', limit: 2 });
		expect(first.body!.entries).toHaveLength(2);
		expect(typeof first.body!.nextCursor).toBe('string');
		const second = await call(owner, 'get_audit_log', {
			action: 'test.entry',
			limit: 2,
			cursor: first.body!.nextCursor
		});
		expect(second.body!.entries).toHaveLength(1);
		expect(second.body!.nextCursor).toBeNull();

		const none = await call(owner, 'get_audit_log', { action: 'test.entry', to: '2020-01-01' });
		expect(none.body!.entries).toEqual([]);
		const bad = await call(owner, 'get_audit_log', { from: 'yesterday' });
		expect(bad.ok).toBe(false);
		expect(bad.text).toContain('not a date');
	});
});
