import { describe, expect, test } from 'bun:test';
import { confirm, confirmStep, renderConfirm } from './confirm.ts';

describe('confirmStep', () => {
	test('arrows, tab and h/l toggle the highlighted answer', () => {
		for (const name of ['left', 'right', 'up', 'down', 'tab', 'h', 'l', 'space'])
			expect(confirmStep(false, { name })).toEqual({ kind: 'select', value: true });
		expect(confirmStep(true, { name: 'right' })).toEqual({ kind: 'select', value: false });
	});

	test('enter confirms the highlighted answer; y and n answer at once', () => {
		expect(confirmStep(true, { name: 'return' })).toEqual({ kind: 'done', value: true });
		expect(confirmStep(false, { name: 'enter' })).toEqual({ kind: 'done', value: false });
		expect(confirmStep(false, { name: 'y' })).toEqual({ kind: 'done', value: true });
		expect(confirmStep(true, { name: 'n' })).toEqual({ kind: 'done', value: false });
		expect(confirmStep(true, { name: 'escape' })).toEqual({ kind: 'done', value: false });
	});

	test('ctrl-c aborts; other keys are ignored', () => {
		expect(confirmStep(true, { name: 'c', ctrl: true })).toEqual({ kind: 'abort' });
		expect(confirmStep(true, { name: 'x' })).toEqual({ kind: 'ignore' });
		expect(confirmStep(true, {})).toEqual({ kind: 'ignore' });
	});
});

test('renderConfirm shows both answers', () => {
	const line = renderConfirm('Install?', true);
	expect(line).toContain('Install?');
	expect(line).toContain('Yes');
	expect(line).toContain('No');
});

describe('confirm without a raw-mode terminal', () => {
	const io = (answer: string) => ({
		input: { isTTY: false } as NodeJS.ReadStream,
		output: process.stdout,
		ask: async (question: string) => {
			expect(question).toMatch(/\((Y\/n|y\/N)\)$/);
			return answer;
		},
	});

	test('falls back to a typed answer, defaulting to the initial value', async () => {
		expect(await confirm('Install?', false, io(''))).toBe(false);
		expect(await confirm('Install?', true, io(''))).toBe(true);
		expect(await confirm('Install?', false, io('yes'))).toBe(true);
		expect(await confirm('Install?', true, io('N'))).toBe(false);
	});
});
