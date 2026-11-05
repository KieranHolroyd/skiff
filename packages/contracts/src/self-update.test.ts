import { describe, expect, test } from 'bun:test';
import {
	SELF_UPDATE_METHODS,
	isSelfUpdateMethod,
	selfUpdateModeFile,
	updateSourceForMethod
} from './self-update.ts';

describe('self-update install method', () => {
	test('accepts only the allowlisted values', () => {
		for (const method of SELF_UPDATE_METHODS) expect(isSelfUpdateMethod(method)).toBe(true);
		for (const value of ['', 'source', 'artifact', 'DOWNLOAD', null, 1, {}])
			expect(isSelfUpdateMethod(value)).toBe(false);
	});

	test('maps the user-facing choice onto the updater source mode', () => {
		expect(updateSourceForMethod('auto')).toBe('auto');
		expect(updateSourceForMethod('download')).toBe('artifact');
		expect(updateSourceForMethod('build')).toBe('source');
	});

	test('derives the sidecar from the configured request path', () => {
		expect(selfUpdateModeFile('/var/lib/skiff/update/request')).toBe(
			'/var/lib/skiff/update/request.mode'
		);
	});
});
