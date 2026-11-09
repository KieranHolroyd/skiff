import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, flow, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** Flows (docs/FLOWS.md §5) through the shared async-task tools: get_task, get_operation, cancel_task. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-flows-'));
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

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const stranger = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_2', role: 'owner' });

realCore.flows.register<{ label: string }>({
	kind: 'test.approval',
	title: 'Approval',
	steps: {
		ask: {
			run: () => flow.wait('answer', { detail: 'Waiting for an answer.' }),
			onSignal: () => flow.succeed({ answered: true })
		}
	},
	cancel: () => flow.cancel()
});

const start = (key: string) =>
	realCore.flows.start({
		kind: 'test.approval',
		key,
		input: { label: key },
		orgId: 'org_1',
		readPermission: 'database:read',
		cancelPermission: 'database:update',
		createdBy: 'user_1'
	}).id;

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

describe('flows through the task tools', () => {
	test('get_task reports a running flow with its step log, then its result', async () => {
		const id = start('one');
		const running = await call(viewer, 'get_task', { taskId: id });
		expect(running.body).toMatchObject({
			id,
			tool: 'test.approval',
			status: 'running',
			error: null,
			approval: { required: false }
		});
		expect(running.body!.result).toMatchObject({
			step: 'ask',
			waitingFor: 'answer',
			detail: 'Waiting for an answer.'
		});
		expect(running.body!.result.nextSteps[0]).toContain(id);
		expect(running.body!.result.steps.map((entry: { event: string }) => entry.event)).toEqual([
			'started',
			'wait'
		]);

		realCore.flows.signal('test.approval', 'one', 'answer', {});
		const done = await call(owner, 'get_task', { taskId: id });
		expect(done.body).toMatchObject({
			status: 'succeeded',
			result: { result: { answered: true } }
		});
		expect(done.body!.result.nextSteps).toBeUndefined();
		expect((await call(owner, 'get_operation', { id })).body).toMatchObject({
			operationId: id,
			status: 'succeeded'
		});
	});

	test('cancel_task enforces the run permission, then cancels', async () => {
		const id = start('two');
		expect((await call(viewer, 'cancel_task', { taskId: id })).ok).toBe(false);
		expect((await call(owner, 'cancel_task', { taskId: id })).body).toMatchObject({
			operationId: id,
			status: 'cancelled'
		});
		expect((await call(owner, 'get_task', { taskId: id })).body).toMatchObject({
			status: 'cancelled'
		});
	});

	test("another org's run is not found", async () => {
		const id = start('three');
		const result = await call(stranger, 'get_task', { taskId: id });
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/not found/i);
	});
});
