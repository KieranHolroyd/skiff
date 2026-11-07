import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FRANKENPHP_DIGESTS,
	FRANKENPHP_PINNED_VERSION,
	ensureFrankenphp,
	frankenphpArch,
	frankenphpAssetUrl,
} from './frankenphp.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'skiff-frankenphp-'));
	dirs.push(dir);
	return dir;
}

const BODY = new TextEncoder().encode('#!/bin/sh\nexit 0\n');
const DIGEST = createHash('sha256').update(BODY).digest('hex');

describe('FrankenPHP installer (D121)', () => {
	test('maps architectures and builds the static asset URL', () => {
		expect(frankenphpArch('x86_64')).toBe('amd64');
		expect(frankenphpArch('aarch64')).toBe('arm64');
		expect(frankenphpArch('riscv64')).toBeNull();
		expect(frankenphpAssetUrl('1.13.2', 'amd64')).toBe(
			'https://github.com/php/frankenphp/releases/download/v1.13.2/frankenphp-linux-x86_64',
		);
		expect(() => frankenphpAssetUrl('latest', 'amd64')).toThrow();
	});

	test('the pin carries a digest for every architecture', () => {
		expect(FRANKENPHP_PINNED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		for (const digest of Object.values(FRANKENPHP_DIGESTS)) expect(digest).toMatch(/^[a-f0-9]{64}$/);
	});

	test('installs a verified binary and links it onto PATH', async () => {
		const dir = temp();
		const calls: string[] = [];
		const result = await ensureFrankenphp({
			arch: 'amd64',
			version: '9.9.9',
			sha256: DIGEST,
			destDir: join(dir, 'lib'),
			linkPath: join(dir, 'bin', 'frankenphp'),
			fetch: (async (url: string) => {
				calls.push(url);
				return new Response(BODY);
			}) as unknown as typeof fetch,
			run: () => 0,
		});
		expect(result).toBe('installed');
		expect(calls).toEqual([frankenphpAssetUrl('9.9.9', 'amd64')]);
		const target = join(dir, 'lib', '9.9.9', 'frankenphp');
		expect(existsSync(target)).toBe(true);
		expect(readlinkSync(join(dir, 'bin', 'frankenphp'))).toBe(target);

		// Second run: present, no download.
		const again = await ensureFrankenphp({
			arch: 'amd64',
			version: '9.9.9',
			sha256: DIGEST,
			destDir: join(dir, 'lib'),
			linkPath: join(dir, 'bin', 'frankenphp'),
			fetch: (async () => {
				throw new Error('must not download');
			}) as unknown as typeof fetch,
			run: () => 0,
		});
		expect(again).toBe('present');
	});

	test('refuses a download whose digest does not match and installs nothing', async () => {
		const dir = temp();
		await expect(
			ensureFrankenphp({
				arch: 'arm64',
				version: '9.9.9',
				sha256: 'f'.repeat(64),
				destDir: join(dir, 'lib'),
				linkPath: null,
				fetch: (async () => new Response(BODY)) as unknown as typeof fetch,
				run: () => 0,
			}),
		).rejects.toThrow(/digest mismatch/);
		expect(existsSync(join(dir, 'lib', '9.9.9', 'frankenphp'))).toBe(false);
	});

	test('an unpinned version needs an explicit digest', async () => {
		await expect(ensureFrankenphp({ arch: 'amd64', version: '0.0.1', dryRun: true })).rejects.toThrow(/No pinned digest/);
	});

	test('dry run reports and changes nothing', async () => {
		const dir = temp();
		const logs: string[] = [];
		const result = await ensureFrankenphp({
			arch: 'amd64',
			destDir: join(dir, 'lib'),
			linkPath: join(dir, 'bin', 'frankenphp'),
			dryRun: true,
			log: (message) => logs.push(message),
			run: () => 1,
		});
		expect(result).toBe('would-install');
		expect(logs[0]).toContain(`FrankenPHP ${FRANKENPHP_PINNED_VERSION}`);
		expect(existsSync(join(dir, 'bin'))).toBe(false);
	});
});
