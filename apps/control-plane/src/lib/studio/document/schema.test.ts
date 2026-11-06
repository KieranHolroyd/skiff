import { describe, expect, test } from 'bun:test';
import type { Cell, Column } from '@skiff/studio/protocol';
import { formatShare, schemaCommand, summarizeSchema } from './schema.ts';
import { firstPage, nextPage, pageLabel, pageNumber, pageRange, previousPage } from './pager.ts';
import { studioErrorMessage, summarizeApply } from './apply.ts';
import { StudioCallError } from '../client.ts';

const columns: Column[] = [
	{ name: '_id', nativeType: 'object', kind: 'document' },
	{ name: 'n', nativeType: 'int', kind: 'number' },
];
const group = (k: string, t: string, n: number): Cell[] => [{ $t: 'ejson', v: { k, t } }, n];

describe('schema sampling', () => {
	test('the command is one aggregate with a $sample', () => {
		const command = JSON.parse(schemaCommand('users"x', 50));
		expect(command.aggregate).toBe('users"x');
		expect(command.pipeline[0]).toEqual({ $sample: { size: 50 } });
		expect(command.pipeline.at(-1).$group).toBeDefined();
	});

	test('summarizes types and shares against the sample size', () => {
		const summary = summarizeSchema(columns, [
			group('\u0000', 'null', 4),
			group('_id', 'objectId', 4),
			group('age', 'int', 2),
			group('age', 'string', 1),
			[{ $t: 'ejson', v: { k: 'name', t: 'string' } }, { $t: 'ejson', v: { $numberLong: '4' } }],
		]);
		expect(summary.sampleSize).toBe(4);
		expect(summary.fields.map((f) => f.name)).toEqual(['_id', 'name', 'age']);
		const age = summary.fields.find((f) => f.name === 'age')!;
		expect(age.count).toBe(3);
		expect(age.share).toBe(0.75);
		expect(age.types).toEqual([
			{ type: 'int', count: 2, share: 0.5 },
			{ type: 'string', count: 1, share: 0.25 },
		]);
	});

	test('an empty result is an empty summary', () => {
		expect(summarizeSchema(columns, [])).toEqual({ sampleSize: 0, fields: [] });
		expect(summarizeSchema([], [[1]])).toEqual({ sampleSize: 0, fields: [] });
	});

	test('formatShare', () => {
		expect(formatShare(0)).toBe('0%');
		expect(formatShare(0.0001)).toBe('<0.1%');
		expect(formatShare(0.05)).toBe('5%');
		expect(formatShare(0.0525)).toBe('5.3%');
		expect(formatShare(0.756)).toBe('76%');
	});
});

describe('cursor stack', () => {
	test('forward and back restore the cursors that led to a page', () => {
		let state = firstPage();
		expect(pageNumber(state)).toBe(1);
		expect(previousPage(state)).toBe(state);
		state = nextPage(state, 'c2');
		state = nextPage(state, 'c3');
		expect(state).toEqual({ stack: [undefined, 'c2'], cursor: 'c3' });
		expect(pageNumber(state)).toBe(3);
		state = previousPage(state);
		expect(state).toEqual({ stack: [undefined], cursor: 'c2' });
		state = previousPage(state);
		expect(state).toEqual({ stack: [], cursor: undefined });
	});

	test('page ranges and labels', () => {
		const third = nextPage(nextPage(firstPage(), 'a'), 'b');
		expect(pageRange(third, 100, 40)).toEqual({ from: 201, to: 240 });
		expect(pageRange(firstPage(), 100, 0)).toEqual({ from: 0, to: 0 });
		expect(pageLabel(firstPage(), 50, 50, 12345)).toBe('Rows 1–50 of about 12,345');
		expect(pageLabel(third, 100, 0)).toBe('No rows');
	});
});

describe('apply summaries', () => {
	test('all applied', () => {
		expect(summarizeApply({ applied: 2, conflicts: [] }, 2)).toEqual({ tone: 'success', title: 'Applied 2 changes.', details: [] });
	});

	test('a conflict with nothing applied', () => {
		const summary = summarizeApply({ applied: 0, conflicts: [{ index: 1, reason: 'Gone.' }] }, 3);
		expect(summary.tone).toBe('danger');
		expect(summary.details).toEqual(['Change 2: Gone.']);
	});

	test('MongoDB partial apply keeps the plugin reason visible', () => {
		const reason = 'Document 1 changed while saving. Partially applied: 1 of 3 change(s) were written before it.';
		const summary = summarizeApply({ applied: 1, conflicts: [{ index: 1, reason }] }, 3, (i) => `Document ${i + 1}`);
		expect(summary.tone).toBe('warning');
		expect(summary.title).toStartWith('Partially applied: 1 of 3 changes');
		expect(summary.details[0]).toBe(`Document 2: ${reason}`);
	});

	test('error codes read clearly', () => {
		expect(studioErrorMessage(new StudioCallError('read_only', 'The session is read-only.', 403))).toContain('read-only');
		expect(studioErrorMessage(new StudioCallError('session_expired', 'x', 410))).toContain('Reopen');
		expect(studioErrorMessage(new StudioCallError('conflict', 'x', 409))).toContain('reload');
		expect(studioErrorMessage(new StudioCallError('unsupported', 'Views cannot be edited.', 422))).toBe(
			'Not supported here: Views cannot be edited.',
		);
		expect(studioErrorMessage(new Error('boom'))).toBe('boom');
	});
});
