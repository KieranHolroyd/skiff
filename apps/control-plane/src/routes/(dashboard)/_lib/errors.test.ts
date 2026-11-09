import { describe, expect, test } from 'bun:test';
import { StepUpRequiredError } from '@yoal/contracts';
import { failStatus, toFormFailure } from './errors';

describe('step-up form failures', () => {
	test('maps StepUpRequiredError to the same payload the REST API sends', () => {
		expect(toFormFailure(new StepUpRequiredError('member:invite', 'window'))).toEqual({
			message: 'This action needs you to verify it’s you again.',
			code: 'step_up_required',
			permission: 'member:invite',
			level: 'window',
		});
	});

	test('keeps an always-level action distinguishable', () => {
		expect(toFormFailure(new StepUpRequiredError('org:transfer', 'always'))).toMatchObject({
			code: 'step_up_required',
			permission: 'org:transfer',
			level: 'always',
		});
	});

	test('a step-up failure is a 403, not a generic 400', () => {
		expect(failStatus(new StepUpRequiredError('database:delete', 'window'))).toBe(403);
	});
});
