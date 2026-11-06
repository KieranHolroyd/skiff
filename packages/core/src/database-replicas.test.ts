import { describe, expect, test } from 'bun:test';
import { chooseReplicaForPromotion, compareLsn } from './database-replicas.ts';

const replica = (id: string, lsn: string, overrides: Record<string, unknown> = {}) => ({
	id,
	databaseId: 'db_1',
	nodeId: `nod_${id}`,
	status: 'streaming' as const,
	replayLsn: lsn,
	lagBytes: 0,
	lagSeconds: 0,
	slot: id,
	primaryGeneration: 0,
	...overrides,
});

describe('database promotion choice', () => {
	test('picks the highest replay LSN', () => {
		const choice = chooseReplicaForPromotion([replica('a', '0/100'), replica('b', '0/200')]);
		expect(choice.replica?.id).toBe('b');
	});

	test('refuses lost/failed replicas and excessive lag', () => {
		const choice = chooseReplicaForPromotion(
			[
				replica('a', '0/300', { status: 'lost' }),
				replica('b', '0/200', { lagBytes: 1_000_000 }),
				replica('c', '0/100'),
			],
			{ maxLagBytes: 512 * 1024 },
		);
		expect(choice.replica?.id).toBe('c');
		expect(choice.refusals.map((row) => row.id)).toEqual(['a', 'b']);
	});

	test('returns no candidate when every replica is ineligible', () => {
		expect(chooseReplicaForPromotion([replica('a', '0/1', { status: 'failed' })]).replica).toBeNull();
	});

	test('compares Postgres LSNs numerically', () => {
		expect(compareLsn('1/0', '0/FFFFFFFF')).toBe(1);
		expect(compareLsn(null, '0/1')).toBe(-1);
	});
});
