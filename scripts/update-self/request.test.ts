import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeRequestedChannel, consumeRequestedMethod } from './request.ts';

const path = join(mkdtempSync(join(tmpdir(), 'skiff-update-request-')), 'request.mode');

function write(value: string): void {
	writeFileSync(path, `${value}\n`);
}

describe('consumeRequestedMethod', () => {
	test('returns an allowlisted dashboard choice and deletes the sidecar', () => {
		write('build');
		expect(consumeRequestedMethod(path, 'dashboard')).toBe('build');
		expect(existsSync(path)).toBe(false);
	});

	test('falls back to auto for an unknown value but still consumes it', () => {
		write('source');
		expect(consumeRequestedMethod(path, 'dashboard')).toBeNull();
		expect(existsSync(path)).toBe(false);
	});

	test('ignores the sidecar for a CLI run, so it cannot leak into the next update', () => {
		write('download');
		expect(consumeRequestedMethod(path, 'cli')).toBeNull();
		expect(existsSync(path)).toBe(false);
	});

	test('is a no-op when the sidecar is missing', () => {
		expect(consumeRequestedMethod(path, 'dashboard')).toBeNull();
	});
});

afterAll(() => rmSync(path, { force: true }));

describe('consumeRequestedChannel', () => {
	const channelPath = join(mkdtempSync(join(tmpdir(), 'skiff-update-channel-')), 'request.channel');

	test('returns an allowlisted dashboard channel and deletes the sidecar', () => {
		writeFileSync(channelPath, 'stable\n');
		expect(consumeRequestedChannel(channelPath, 'dashboard')).toBe('stable');
		expect(existsSync(channelPath)).toBe(false);
	});

	test('ignores unknown values and CLI runs, but always consumes the file', () => {
		writeFileSync(channelPath, 'beta\n');
		expect(consumeRequestedChannel(channelPath, 'dashboard')).toBeNull();
		expect(existsSync(channelPath)).toBe(false);
		writeFileSync(channelPath, 'canary\n');
		expect(consumeRequestedChannel(channelPath, 'cli')).toBeNull();
		expect(existsSync(channelPath)).toBe(false);
	});

	afterAll(() => rmSync(channelPath, { force: true }));
});
