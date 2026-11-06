import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesiredState } from '@skiff/contracts';
import { NodeUpdateRunner } from './node-update.ts';

let dir: string;
let clock: number;
let calls: Array<{ version: string; repo: string }>;
let fail: string | null;

const state = (nodeUpdate: DesiredState['nodeUpdate']) => ({ nodeUpdate }) as DesiredState;
const task = (generation = 1, version = '0.8.0') => ({ generation, version, repo: 'owner/skiff' });

function runner(currentVersion = '0.7.15') {
	return new NodeUpdateRunner({
		currentVersion,
		statePath: join(dir, 'node-update.json'),
		now: () => clock,
		helper: {
			updateNode: async (input) => {
				calls.push(input);
				if (fail) throw new Error(fail);
				return { version: input.version };
			},
		},
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'skiff-agent-node-update-'));
	clock = 1_000_000;
	calls = [];
	fail = null;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('node update runner (D99)', () => {
	test('hands the version to the helper once per generation and reports nothing on success', async () => {
		const agent = runner();
		await agent.runOnce(state(task()));
		await agent.runOnce(state(task()));
		expect(calls).toEqual([{ version: '0.8.0', repo: 'owner/skiff' }]);
		expect(agent.pendingResult()).toBeNull();
	});

	test('does nothing without a task or when already on the target', async () => {
		await runner().runOnce(state(null));
		await runner('0.8.0').runOnce(state(task()));
		await runner('0.9.0').runOnce(state(task()));
		expect(calls).toEqual([]);
	});

	test('reports a helper refusal once, then waits for a new generation', async () => {
		fail = 'helper POST /v1/node/update -> 409: v0.8.0 is not trusted';
		const agent = runner();
		await agent.runOnce(state(task()));
		const result = agent.pendingResult();
		expect(result).toEqual({ generation: 1, error: fail });
		await agent.acknowledge(result);
		expect(agent.pendingResult()).toBeNull();

		// A restarted agent remembers the reported attempt and neither retries nor re-reports it.
		const restarted = runner();
		await restarted.runOnce(state(task()));
		expect(restarted.pendingResult()).toBeNull();
		expect(calls).toHaveLength(1);

		// The operator's retry is a new generation.
		fail = null;
		await restarted.runOnce(state(task(2)));
		expect(calls).toHaveLength(2);
	});

	test('an install that came back on the old version is reported after the restart grace period', async () => {
		await runner().runOnce(state(task()));
		const sameOldBinary = runner();
		await sameOldBinary.runOnce(state(task()));
		expect(sameOldBinary.pendingResult()).toBeNull();
		clock += 121_000;
		await sameOldBinary.runOnce(state(task()));
		expect(sameOldBinary.pendingResult()?.error).toMatch(/still runs 0\.7\.15/);
		expect(calls).toHaveLength(1);
	});
});
