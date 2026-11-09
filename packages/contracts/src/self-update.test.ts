import { describe, expect, test } from 'bun:test';
import {
	SELF_UPDATE_CHANNELS,
	SELF_UPDATE_METHODS,
	isSelfUpdateChannel,
	isSelfUpdateMethod,
	releaseInChannel,
	selfUpdateChannelFile,
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
		expect(selfUpdateModeFile('/var/lib/yoal/update/request')).toBe(
			'/var/lib/yoal/update/request.mode'
		);
	});
});

describe('self-update release channel', () => {
	test('accepts only canary and stable', () => {
		for (const channel of SELF_UPDATE_CHANNELS) expect(isSelfUpdateChannel(channel)).toBe(true);
		for (const value of ['', 'beta', 'STABLE', null, 1]) expect(isSelfUpdateChannel(value)).toBe(false);
	});

	test('canary follows prereleases and full releases; stable only full releases', () => {
		const canary = { draft: false, prerelease: true };
		const stable = { draft: false, prerelease: false };
		const draft = { draft: true, prerelease: false };
		expect(releaseInChannel(canary, 'canary')).toBe(true);
		expect(releaseInChannel(stable, 'canary')).toBe(true);
		expect(releaseInChannel(canary, 'stable')).toBe(false);
		expect(releaseInChannel(stable, 'stable')).toBe(true);
		expect(releaseInChannel(draft, 'canary')).toBe(false);
		expect(releaseInChannel(draft, 'stable')).toBe(false);
	});

	test('derives the channel sidecar from the request path', () => {
		expect(selfUpdateChannelFile('/var/lib/yoal/update/request')).toBe(
			'/var/lib/yoal/update/request.channel'
		);
	});
});
