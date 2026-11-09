import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** Blueprint tools (plan 11): plan_stack, apply_stack and get_task against a real core. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-blueprints-'));
const opened = createDb({ path: ':memory:' });
const features = { ...DEFAULT_FEATURES, BLUEPRINTS: true };
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
		features
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

const blueprint = `apiVersion: yoal/v1
name: docs
projects:
  docs-site:
    environments:
      staging: { access: platform }
`;

async function call(principal: typeof owner, name: string, args: Record<string, unknown>) {
	const tool = assistantTools(principal).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions on a JSON tool result
	return {
		ok: result.ok,
		text: result.text,
		body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null
	};
}

describe('blueprint tools', () => {
	test('annotations: plan is read-only, apply is destructive (confirmed), get_task reads', () => {
		const tools = new Map(
			yoalToolDefinitions(owner).map((entry) => [entry.name, entry.config.annotations])
		);
		expect(tools.get('plan_stack')).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(tools.get('apply_stack')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		expect(tools.get('get_task')).toMatchObject({ readOnlyHint: true });
		expect(assistantTools(owner).find((tool) => tool.name === 'apply_stack')?.destructive).toBe(
			true
		);
		// A viewer can plan but is never offered apply.
		const viewerTools = assistantTools(viewer).map((tool) => tool.name);
		expect(viewerTools).toContain('plan_stack');
		expect(viewerTools).not.toContain('apply_stack');
	});

	test('the blueprint tools are hidden while the feature is off', () => {
		features.BLUEPRINTS = false;
		try {
			const names = yoalToolDefinitions(owner).map((entry) => entry.name);
			expect(names).not.toContain('plan_stack');
			expect(names).not.toContain('apply_stack');
			expect(names).toContain('get_task');
		} finally {
			features.BLUEPRINTS = true;
		}
	});

	test('plan, apply and follow a stack; prune and extra arguments are refused', async () => {
		const plan = await call(owner, 'plan_stack', { blueprint });
		expect(plan.ok).toBe(true);
		expect(plan.body).toMatchObject({
			stack: 'docs',
			stackAction: 'create',
			summary: { create: 2, update: 0, delete: 0, noop: 0 }
		});
		expect(plan.body?.nextSteps[0]).toContain('apply_stack');
		expect(realCore.projects.list(owner)).toHaveLength(0);

		expect((await call(owner, 'plan_stack', { blueprint, prune: true })).ok).toBe(false);
		expect(
			(
				await call(owner, 'plan_stack', {
					blueprint: 'apiVersion: yoal/v1\nname: docs\nextra: 1\n'
				})
			).text
		).toContain('Unrecognized key');

		const applied = await call(owner, 'apply_stack', { planHash: plan.body?.planHash });
		expect(applied.ok).toBe(true);
		expect(applied.body).toMatchObject({ stack: 'docs', status: 'succeeded' });
		expect(applied.body?.resources.map((resource: { status: string }) => resource.status)).toEqual([
			'succeeded',
			'succeeded'
		]);
		expect(realCore.projects.requireRow(owner, 'docs-site').slug).toBe('docs-site');

		const task = await call(owner, 'get_task', { taskId: applied.body?.operationId });
		expect(task.body).toMatchObject({
			id: applied.body?.operationId,
			tool: 'apply_stack',
			status: 'succeeded',
			progress: 100,
			error: null,
			approval: { required: false }
		});
		expect(task.body?.result.resources).toHaveLength(2);

		// The same file again is a no-op.
		const again = await call(owner, 'plan_stack', { blueprint });
		expect(again.body).toMatchObject({
			stackAction: 'noop',
			summary: { create: 0, update: 0, noop: 2 }
		});
		expect(again.body?.nextSteps[0]).toContain('up to date');
	});
});
