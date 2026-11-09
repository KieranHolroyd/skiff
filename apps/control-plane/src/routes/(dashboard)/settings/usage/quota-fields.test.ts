import { describe, expect, test } from 'bun:test';
import { quotaFieldNames } from '@yoal/contracts';
import { readProjectTab } from '../../projects/[slug]/_components/project-nav.js';
import { inputValue, QUOTA_FIELD_SCALE, QUOTA_GROUPS } from './quota-fields.js';

describe('quota fields', () => {
	test('every quota field appears in exactly one group', () => {
		const grouped = QUOTA_GROUPS.flatMap((group) => group.fields);
		expect([...grouped].sort()).toEqual([...quotaFieldNames].sort());
	});

	test('byte limits round-trip through the form unit', () => {
		expect(QUOTA_FIELD_SCALE.databaseStorageBytes).toBe(1024 ** 3);
		expect(inputValue('databaseStorageBytes', 5 * 1024 ** 3)).toBe('5');
		expect(inputValue('maxUploadBytes', 512 * 1024 ** 2)).toBe('512');
		expect(inputValue('storageBytes', 1.5 * 1024 ** 3)).toBe('1.5');
	});

	test('unlimited shows as a blank field and counts are unscaled', () => {
		expect(inputValue('projects', -1)).toBe('');
		expect(inputValue('projects', 12)).toBe('12');
		expect(inputValue('workloadMemoryMb', 2048)).toBe('2048');
	});
});

describe('project tabs', () => {
	test('the old volumes tab opens the data tab', () => {
		expect(readProjectTab('volumes')).toBe('data');
		expect(readProjectTab('data')).toBe('data');
		expect(readProjectTab('nope')).toBe('deployments');
	});
});
