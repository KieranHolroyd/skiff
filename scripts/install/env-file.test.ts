import { describe, expect, test } from 'bun:test';
import { formatEnvFile, formatEnvLine, parseEnvFile } from './env-file.ts';

describe('yoal.env format', () => {
	test('writes shell-safe values bare', () => {
		expect(formatEnvLine('YOAL_PLATFORM_ORIGIN', 'https://control.example.com')).toBe(
			'YOAL_PLATFORM_ORIGIN=https://control.example.com',
		);
		expect(formatEnvLine('BETTER_AUTH_SECRET', 'abc+/def==')).toBe('BETTER_AUTH_SECRET=abc+/def==');
		expect(formatEnvLine('EMPTY', '')).toBe('EMPTY=');
	});

	test('double-quotes and escapes anything else (systemd EnvironmentFile syntax)', () => {
		expect(formatEnvLine('YOAL_SMTP_FROM', 'Yoal <noreply@examplecloud.com>')).toBe(
			'YOAL_SMTP_FROM="Yoal <noreply@examplecloud.com>"',
		);
		expect(formatEnvLine('P', 'a$b"c\\d`e')).toBe('P="a\\$b\\"c\\\\d\\`e"');
	});

	test('round-trips values, including legacy bare and single-quoted lines', () => {
		const values = new Map([
			['YOAL_SMTP_FROM', 'Yoal <noreply@examplecloud.com>'],
			['YOAL_SMTP_PASSWORD', `p@ss w0rd;$HOME"\\'\``],
			['R2_BUCKET', 'yoal'],
		]);
		expect(parseEnvFile(formatEnvFile(values))).toEqual(values);
		const legacy = parseEnvFile('# comment\nA=Yoal <x@y>\nB=\'quoted value\'\n\nC=1=2\n');
		expect(legacy.get('A')).toBe('Yoal <x@y>');
		expect(legacy.get('B')).toBe('quoted value');
		expect(legacy.get('C')).toBe('1=2');
	});

	test('rejects newlines', () => {
		expect(() => formatEnvLine('X', 'a\nb')).toThrow();
	});
});
