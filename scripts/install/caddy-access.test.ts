import { describe, expect, test } from 'bun:test';
import { parseGetentGroupId, parseProcStatusGroups, processHasGroup } from './caddy-access.ts';

const status = (groups: string, gid = '983') => `Name:\tcaddy\nUid:\t999\t999\t999\t999\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\nGroups:\t${groups}\n`;

describe('Caddy supplementary group check', () => {
	test('parses the group ids a running process actually has', () => {
		expect(parseProcStatusGroups(status('33 982 983'))).toEqual([33, 982, 983]);
		expect(parseProcStatusGroups(status(''))).toEqual([]);
		expect(parseProcStatusGroups('Name:\tcaddy\n')).toEqual([]);
	});

	test('parses the numeric id from a getent line', () => {
		expect(parseGetentGroupId('skiff:x:982:')).toBe(982);
		expect(parseGetentGroupId('skiff:x:982:caddy,skiff\n')).toBe(982);
		expect(parseGetentGroupId('')).toBeNull();
		expect(parseGetentGroupId('garbage')).toBeNull();
	});

	test('a process started before the drop-in lacks the skiff group', () => {
		// Observed on a fresh host: the unit file said skiff, the process had caddy + www-data only.
		expect(processHasGroup(status('33 983'), 982)).toBe(false);
	});

	test('a process restarted after the drop-in has the skiff group', () => {
		expect(processHasGroup(status('33 982 983'), 982)).toBe(true);
	});

	test('the primary gid counts as membership', () => {
		expect(processHasGroup(status('984', '982'), 982)).toBe(true);
	});

	test('a missing status file reports no membership', () => {
		expect(processHasGroup('', 982)).toBe(false);
	});
});
