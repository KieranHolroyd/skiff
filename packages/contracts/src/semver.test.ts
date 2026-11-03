import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compareSemver, isSemver, parseSemver, semverBump } from './semver.ts';

describe('parseSemver', () => {
	test('accepts release, prerelease, build and a leading v', () => {
		expect(parseSemver('1.2.3')?.version).toBe('1.2.3');
		expect(parseSemver('v1.2.3-rc.1+build.5')).toMatchObject({
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: ['rc', 1],
			build: ['build', '5'],
			version: '1.2.3-rc.1',
		});
		expect(parseSemver('0.1.0\n')?.version).toBe('0.1.0');
	});

	test('rejects anything that is not semver 2.0.0', () => {
		for (const bad of ['', '1', '1.2', '1.2.3.4', '01.2.3', '1.2.3-01', '1.2.3-', 'latest', ' v', '1.2.3 beta'])
			expect(isSemver(bad)).toBe(false);
		expect(parseSemver(undefined)).toBeNull();
	});
});

describe('compareSemver', () => {
	test('orders by semver precedence (spec §11 example chain)', () => {
		const chain = [
			'1.0.0-alpha',
			'1.0.0-alpha.1',
			'1.0.0-alpha.beta',
			'1.0.0-beta',
			'1.0.0-beta.2',
			'1.0.0-beta.11',
			'1.0.0-rc.1',
			'1.0.0',
			'1.0.1',
			'1.1.0',
			'1.10.0',
			'2.0.0',
		];
		for (let i = 0; i < chain.length - 1; i++) {
			expect(compareSemver(chain[i]!, chain[i + 1]!)).toBeLessThan(0);
			expect(compareSemver(chain[i + 1]!, chain[i]!)).toBeGreaterThan(0);
		}
	});

	test('ignores build metadata and a leading v', () => {
		expect(compareSemver('v1.2.3+a', '1.2.3+b')).toBe(0);
	});

	test('throws on invalid input instead of guessing', () => {
		expect(() => compareSemver('1.2', '1.2.0')).toThrow(/Invalid semantic version/);
	});
});

test('semverBump names the change', () => {
	expect(semverBump('1.2.3', '2.0.0')).toBe('major');
	expect(semverBump('1.2.3', '1.3.0')).toBe('minor');
	expect(semverBump('1.2.3', '1.2.4')).toBe('patch');
	expect(semverBump('1.2.3-rc.1', '1.2.3')).toBe('prerelease');
	expect(semverBump('1.2.3', '1.2.3')).toBeNull();
	expect(semverBump('1.2.3', '1.0.0')).toBeNull();
});

test('the repository VERSION file is valid semver', () => {
	const body = readFileSync(new URL('../../../VERSION', import.meta.url), 'utf8');
	expect(body).toMatch(/^\S+\n$/);
	expect(isSemver(body)).toBe(true);
});
