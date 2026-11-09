import { describe, expect, test } from 'bun:test';
import { choosePromotion, type ListedRelease } from './promote.ts';

const SIGNED = ['manifest.json', 'manifest.json.sig', 'yoal-x-linux-amd64.tar.gz'];
const release = (tag: string, prerelease: boolean, assets = SIGNED): ListedRelease => ({
	tag,
	draft: false,
	prerelease,
	assets,
	createdAt: '2026-11-07T00:00:00Z',
});

const releases = [
	release('v0.8.2', true),
	release('v0.8.1', true),
	release('v0.8.0', true, ['yoal-x-linux-amd64.tar.gz']),
	release('v0.7.9', false),
	release('cli-v9.9.9', false),
	{ ...release('v0.9.0', true), draft: true },
];

describe('choosePromotion', () => {
	test('defaults to the newest signed canary and lists the canaries stable skips', () => {
		expect(choosePromotion(releases, null)).toEqual({
			ok: true,
			tag: 'v0.8.2',
			version: '0.8.2',
			stable: '0.7.9',
			skipped: ['v0.8.1'],
		});
	});

	test('promotes a named canary, with or without the v', () => {
		expect(choosePromotion(releases, '0.8.1')).toMatchObject({ ok: true, tag: 'v0.8.1', skipped: [] });
		expect(choosePromotion(releases, 'v0.8.1')).toMatchObject({ ok: true, tag: 'v0.8.1' });
	});

	test('refuses releases hosts could not install or would ignore', () => {
		expect(choosePromotion(releases, '0.8.0')).toMatchObject({ ok: false, reason: expect.stringMatching(/no signed manifest/) });
		expect(choosePromotion(releases, '0.7.9')).toMatchObject({ ok: false, reason: expect.stringMatching(/already stable/) });
		expect(choosePromotion(releases, '0.9.0')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a published/) });
		expect(choosePromotion(releases, 'latest')).toMatchObject({ ok: false, reason: expect.stringMatching(/not a platform version/) });
	});

	test('refuses a canary older than stable unless allowed', () => {
		const behind = [release('v0.7.5', true), release('v0.7.9', false)];
		expect(choosePromotion(behind, '0.7.5')).toMatchObject({ ok: false, reason: expect.stringMatching(/not newer/) });
		expect(choosePromotion(behind, '0.7.5', { allowOlder: true })).toMatchObject({ ok: true, tag: 'v0.7.5' });
	});

	test('the first promotion works with no stable release yet', () => {
		expect(choosePromotion([release('v0.8.2', true)], null)).toEqual({
			ok: true,
			tag: 'v0.8.2',
			version: '0.8.2',
			stable: null,
			skipped: [],
		});
		expect(choosePromotion([], null)).toMatchObject({ ok: false, reason: expect.stringMatching(/no signed canary/) });
	});
});
