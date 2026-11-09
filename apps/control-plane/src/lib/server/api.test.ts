import { describe, expect, test } from 'bun:test';
import { StepUpRequiredError } from '@yoal/contracts';
import { errorResponse } from './api';

describe('errorResponse', () => {
	test('maps a step-up requirement to 403 step_up_required with the permission and level', async () => {
		const response = errorResponse(new StepUpRequiredError('database:credentials', 'window'));
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: 'step_up_required',
			permission: 'database:credentials',
			level: 'window'
		});
	});

	test('keeps an always-level action distinguishable for the dialog', async () => {
		const response = errorResponse(new StepUpRequiredError('org:delete', 'always'));
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: 'step_up_required',
			permission: 'org:delete',
			level: 'always'
		});
	});
});
