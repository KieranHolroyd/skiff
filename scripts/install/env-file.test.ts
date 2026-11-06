import { describe, expect, test } from 'bun:test';
import { formatEnvFile, formatEnvLine, parseEnvFile } from './env-file.ts';

describe('skiff.env format', () => {
	test('writes shell-safe values bare', () => {
		expect(formatEnvLine('SKIFF_PLATFORM_ORIGIN', 'https://control.example.com')).toBe(
			'SKIFF_PLATFORM_ORIGIN=https://control.example.com',
		);
		expect(formatEnvLine('BETTER_AUTH_SECRET', 'abc+/def==')).toBe('BETTER_AUTH_SECRET=abc+/def==');
		expect(formatEnvLine('EMPTY', '')).toBe('EMPTY=');
	});

	test('double-quotes and escapes anything else (systemd EnvironmentFile syntax)', () => {
		expect(formatEnvLine('SKIFF_SMTP_FROM', 'Skiff <noreply@examplecloud.com>')).toBe(
			'SKIFF_SMTP_FROM="Skiff <noreply@examplecloud.com>"',
		);
		expect(formatEnvLine('P', 'a$b"c\\d`e')).toBe('P="a\\$b\\"c\\\\d\\`e"');
	});

	test('round-trips values, including legacy bare and single-quoted lines', () => {
		const values = new Map([
			['SKIFF_SMTP_FROM', 'Skiff <noreply@examplecloud.com>'],
			['SKIFF_SMTP_PASSWORD', `p@ss w0rd;$HOME"\\'\``],
			['R2_BUCKET', 'skiff'],
		]);
		expect(parseEnvFile(formatEnvFile(values))).toEqual(values);
		const legacy = parseEnvFile('# comment\nA=Skiff <x@y>\nB=\'quoted value\'\n\nC=1=2\n');
		expect(legacy.get('A')).toBe('Skiff <x@y>');
		expect(legacy.get('B')).toBe('quoted value');
		expect(legacy.get('C')).toBe('1=2');
	});

	test('rejects newlines', () => {
		expect(() => formatEnvLine('X', 'a\nb')).toThrow();
	});
});
