import { describe, expect, test } from 'bun:test';
import type { DesiredState } from '@skiff/contracts';
import { VolumeProfileRunner, type HelperVolumeProfileApi } from './volume-profiles.ts';

const state = (ids: string[]) =>
	({ volumeProfileTasks: ids.map((id) => ({ id, volumeId: `vol_${id}`, sizeMb: 512, runtimeSeconds: 10 })) }) as DesiredState;

const numbers = {
	method: 'fio' as const,
	seqReadMBps: 500,
	seqWriteMBps: 400,
	randReadIops: 90_000,
	randWriteIops: 70_000,
	syncWriteIops: 2_000,
	syncWriteLatencyUs: 500,
	direct: true,
	notes: [],
};

describe('VolumeProfileRunner', () => {
	test('runs one task at a time, reports running then the numbers, and never repeats a finished task', async () => {
		const calls: string[] = [];
		let release: () => void = () => undefined;
		const helper: HelperVolumeProfileApi = {
			profileVolume: async (input) => {
				calls.push(input.volumeId);
				await new Promise<void>((resolve) => (release = resolve));
				return numbers;
			},
		};
		const runner = new VolumeProfileRunner({ helper });
		const first = runner.runOnce(state(['a', 'b']));
		expect(runner.runOnce(state(['a', 'b']))).toBeNull();
		expect(runner.results()).toMatchObject([{ taskId: 'a', status: 'running' }]);
		runner.acknowledge(runner.results());
		release();
		await first;
		expect(runner.results()).toMatchObject([{ taskId: 'a', status: 'succeeded', randReadIops: 90_000 }]);

		const second = runner.runOnce(state(['a', 'b']));
		release();
		await second;
		expect(calls).toEqual(['vol_a', 'vol_b']);
		expect(runner.runOnce(state(['a', 'b']))).toBeNull();
	});

	test('reports a helper failure as a failed result', async () => {
		const runner = new VolumeProfileRunner({
			helper: { profileVolume: async () => Promise.reject(new Error('Not enough free space')) },
		});
		await runner.runOnce(state(['x']));
		expect(runner.results()).toMatchObject([{ taskId: 'x', status: 'failed', error: 'Not enough free space' }]);
		runner.acknowledge(runner.results());
		expect(runner.results()).toEqual([]);
	});
});
