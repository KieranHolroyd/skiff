import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	pinnedWorkerdVersion,
	workerdArch,
	workerdPackageFor,
	workerdTarballUrl,
} from './workerd.ts';

describe('workerd installer helpers', () => {
	test('maps Linux architectures to npm platform packages', () => {
		expect(workerdPackageFor('amd64')).toBe('@cloudflare/workerd-linux-64');
		expect(workerdPackageFor('arm64')).toBe('@cloudflare/workerd-linux-arm64');
		expect(workerdArch('x86_64')).toBe('amd64');
		expect(workerdArch('aarch64')).toBe('arm64');
		expect(workerdArch('riscv64')).toBeNull();
	});

	test('builds the registry tarball URL for the pinned version', () => {
		expect(workerdTarballUrl('@cloudflare/workerd-linux-64', '1.20261106.1')).toBe(
			'https://registry.npmjs.org/@cloudflare/workerd-linux-64/-/workerd-linux-64-1.20261106.1.tgz',
		);
		expect(() => workerdTarballUrl('@cloudflare/workerd-linux-64', '../../etc')).toThrow();
	});

	test('reads the same pin the control plane and helper use', () => {
		// This test file runs from scripts/install; the repo root is two levels up.
		const root = join(import.meta.dir, '..', '..');
		expect(pinnedWorkerdVersion(root)).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
