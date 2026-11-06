import { describe, expect, test } from 'bun:test';
import { StudioCallError } from '../client.ts';
import { countdown, describeStudioError } from './errors.ts';

describe('describeStudioError', () => {
	test('offers to reopen an expired or unknown session', () => {
		expect(describeStudioError(new StudioCallError('session_expired', 'gone', 410)).reopen).toBe(true);
		expect(describeStudioError(new StudioCallError('unknown_session', 'gone', 404)).reopen).toBe(true);
	});

	test('explains read-only and conflict refusals', () => {
		expect(describeStudioError(new StudioCallError('read_only', 'no', 403)).message).toContain('Enable writes');
		const conflict = describeStudioError(new StudioCallError('conflict', 'Row 3 changed.', 409));
		expect(conflict.message).toContain('Row 3 changed.');
		expect(conflict.reopen).toBe(false);
	});

	test('falls back to the error message', () => {
		expect(describeStudioError(new Error('boom'))).toMatchObject({ code: 'internal', message: 'boom' });
	});
});

test('countdown', () => {
	expect(countdown(65_000)).toBe('1:05');
	expect(countdown(3_723_000)).toBe('1:02:03');
	expect(countdown(-5)).toBe('0:00');
});
