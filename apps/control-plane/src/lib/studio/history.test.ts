import { describe, expect, test } from 'bun:test';
import { HISTORY_LIMIT, openHistory, type HistoryEntry } from './history.ts';

const entry = (input: string, ok = true): HistoryEntry => ({
	input,
	ranAt: new Date().toISOString(),
	ms: 12,
	rows: 3,
	ok
});

describe('query history (memory fallback)', () => {
	test('lists newest first, per database', async () => {
		const a = openHistory('history-a', null);
		const b = openHistory('history-b', null);
		await a.add(entry('select 1'));
		await a.add(entry('select 2', false));
		await b.add(entry('GET key'));
		expect((await a.list()).map((item) => [item.input, item.ok])).toEqual([
			['select 2', false],
			['select 1', true]
		]);
		expect((await b.list()).map((item) => item.input)).toEqual(['GET key']);
	});

	test('keeps the last 200 entries', async () => {
		const history = openHistory('history-cap', null);
		for (let index = 0; index < HISTORY_LIMIT + 25; index++) await history.add(entry(`q${index}`));
		const list = await history.list();
		expect(list).toHaveLength(HISTORY_LIMIT);
		expect(list[0]?.input).toBe(`q${HISTORY_LIMIT + 24}`);
		expect(list.at(-1)?.input).toBe('q25');
	});

	test('is shared across instances of the same database and clears', async () => {
		await openHistory('history-shared', null).add(entry('select now()'));
		const again = openHistory('history-shared', null);
		expect((await again.list()).map((item) => item.input)).toEqual(['select now()']);
		await again.clear();
		expect(await again.list()).toEqual([]);
	});

	test('the default factory falls back to memory when indexedDB is missing', async () => {
		expect(globalThis.indexedDB).toBeUndefined();
		const history = openHistory('history-default');
		await history.add(entry('ping'));
		expect((await history.list()).map((item) => item.input)).toEqual(['ping']);
	});

	test('a broken IndexedDB never throws and falls back to memory', async () => {
		const broken = {
			open() {
				throw new Error('SecurityError');
			}
		} as unknown as IDBFactory;
		const history = openHistory('history-broken', broken);
		await history.add(entry('select 1'));
		expect((await history.list()).map((item) => item.input)).toEqual(['select 1']);
		await history.clear();
		expect(await history.list()).toEqual([]);
	});

	test('the list is a copy', async () => {
		const history = openHistory('history-copy', null);
		await history.add(entry('a'));
		(await history.list()).pop();
		expect(await history.list()).toHaveLength(1);
	});
});
