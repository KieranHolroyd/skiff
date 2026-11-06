import { describe, expect, test } from 'bun:test';
import type { Column, StudioEvent, StudioInfo } from '@skiff/studio/protocol';
import { cellText, plainCell, toCsv, toJson, uniqueNames } from './export.ts';
import { applyEvent, emptyRun, errorTitle, resultTitle, rowCap, rowChoices } from './run-state.ts';

const col = (name: string): Column => ({ name, nativeType: 'text', kind: 'text' });

function replay(events: StudioEvent[]) {
	return events.reduce(applyEvent, emptyRun());
}

describe('run events → result tabs', () => {
	test('each columns … result group is one tab, row-less results get their own', () => {
		const state = replay([
			{ t: 'columns', columns: [col('id')] },
			{ t: 'rows', rows: [[1], [2]] },
			{ t: 'rows', rows: [[3]] },
			{ t: 'result', command: 'SELECT', affected: 3 },
			{ t: 'notice', level: 'warn', message: 'careful' },
			{ t: 'result', command: 'UPDATE 2', affected: 2 },
			{ t: 'columns', columns: [col('n')] },
			{ t: 'result', command: 'SELECT' },
			{ t: 'done', ms: 42, truncated: true }
		]);
		expect(state.results.map(resultTitle)).toEqual([
			'Result 1 · 3 rows · SELECT',
			'Result 2 · 2 affected · UPDATE',
			'Result 3 · 0 rows · SELECT'
		]);
		expect(state.results[0]?.rows).toEqual([[1], [2], [3]]);
		expect(state.messages).toEqual([{ level: 'warn', text: 'careful' }]);
		expect(state.done).toEqual({ ms: 42, truncated: true });
		expect(state.open).toBeNull();
	});

	test('errors keep their code, position and a friendly title', () => {
		const state = replay([
			{ t: 'error', code: 'read_only', message: '"insert" is not allowed in a read-only session.' },
			{ t: 'error', code: 'engine_error', message: 'syntax error at or near "form"', position: 10 }
		]);
		expect(state.messages[0]).toMatchObject({
			level: 'error',
			code: 'read_only',
			title: 'This session is read-only; enable writes in the header.'
		});
		expect(state.messages[1]).toEqual({
			level: 'error',
			code: 'engine_error',
			text: 'syntax error at or near "form"',
			position: 10
		});
	});

	test('rows without an open set are ignored, a bare result reads OK', () => {
		const state = replay([{ t: 'rows', rows: [[1]] }, { t: 'result' }]);
		expect(state.results.map(resultTitle)).toEqual(['Result 1 · OK']);
		expect(resultTitle({ id: 0, columns: [col('a')], rows: [['x']] })).toBe('Result 1 · 1 row');
	});
});

describe('limits', () => {
	const info = (maxRows: number) => ({ limits: { maxRows } }) as StudioInfo;
	test('row choices are capped at the session limit', () => {
		expect(rowChoices(info(10_000))).toEqual([100, 1_000, 10_000]);
		expect(rowChoices(info(5_000))).toEqual([100, 1_000, 5_000]);
		expect(rowChoices(info(50))).toEqual([50]);
		expect(rowCap(10_000, info(5_000))).toBe(5_000);
		expect(rowCap(100, info(5_000))).toBe(100);
	});
	test('friendly titles for known codes only', () => {
		expect(errorTitle('studio_restarted')).toBe('The studio restarted; run again.');
		expect(errorTitle('timeout')).toBeDefined();
		expect(errorTitle('session_expired')).toBeDefined();
		expect(errorTitle('cancelled')).toBeDefined();
		expect(errorTitle('engine_error')).toBeUndefined();
	});
});

describe('export', () => {
	const columns = [col('id'), col('name'), col('id'), col('meta')];
	const rows = [
		[{ $t: 'bigint', v: '9007199254740993' }, 'a, "b"', 1, { $t: 'json', v: { k: [1, 2] } }],
		[2, null, true, [{ $t: 'decimal', v: '1.50' }, 'x']]
	] as const;

	test('plain cells unwrap tags recursively', () => {
		expect(plainCell({ $t: 'date', v: '2026-11-06' })).toBe('2026-11-06');
		expect(plainCell([{ $t: 'bigint', v: '1' }, 2])).toEqual(['1', 2]);
		expect(cellText(null)).toBe('');
		expect(cellText({ $t: 'truncated', v: 'abc', bytes: 9000 })).toBe('abc');
	});

	test('CSV quotes what needs it', () => {
		expect(toCsv(columns, rows as never)).toBe(
			'id,name,id,meta\r\n' +
				'9007199254740993,"a, ""b""",1,"{""k"":[1,2]}"\r\n' +
				'2,,true,"[""1.50"",""x""]"\r\n'
		);
	});

	test('JSON objects with unique keys', () => {
		expect(uniqueNames([col('id'), col('id'), col('id_2'), col('id')])).toEqual(['id', 'id_3', 'id_2', 'id_4']);
		expect(JSON.parse(toJson(columns, rows as never))).toEqual([
			{ id: '9007199254740993', name: 'a, "b"', id_2: 1, meta: { k: [1, 2] } },
			{ id: 2, name: null, id_2: true, meta: ['1.50', 'x'] }
		]);
	});
});
