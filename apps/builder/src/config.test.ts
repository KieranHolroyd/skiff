import { describe, expect, test } from 'bun:test';
import { ConfigError, DEFAULT_BUILD_PATH, loadConfig } from './config.ts';

const base = { SKIFF_CONTROL_URL: 'https://control.test/', SKIFF_NODE_TOKEN: 'tok', SKIFF_BUILD_DIR: '/tmp/b' };
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('builder config', () => {
	test.skipIf(isRoot)('direct execution needs no build account', () => {
		const config = loadConfig({ ...base, SKIFF_BUILDER_SYSTEMD: 'false' });
		expect(config.controlUrl).toBe('https://control.test');
		expect(config.buildUser).toBeNull();
		expect(config.buildPath).toBe(DEFAULT_BUILD_PATH);
		expect(config.idlePollMs).toBe(30_000);
	});

	test('honours an explicit build account with systemd-run', () => {
		const config = loadConfig({ ...base, SKIFF_BUILDER_SYSTEMD: 'true', SKIFF_BUILDER_USER: 'skiff-build' });
		expect(config.buildUser).toBe('skiff-build');
	});

	test('rejects a build account without systemd-run, and odd user names', () => {
		expect(() => loadConfig({ ...base, SKIFF_BUILDER_SYSTEMD: 'false', SKIFF_BUILDER_USER: 'skiff-build' })).toThrow(
			ConfigError,
		);
		expect(() => loadConfig({ ...base, SKIFF_BUILDER_SYSTEMD: 'true', SKIFF_BUILDER_USER: 'root;rm' })).toThrow(
			ConfigError,
		);
	});
});
