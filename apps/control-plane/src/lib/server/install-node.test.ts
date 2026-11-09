import { describe, expect, test } from 'bun:test';
import { renderNodeScript } from './install-node.js';

describe('node installer script', () => {
	test('bakes the origin and keeps the token out of the script', () => {
		const script = renderNodeScript('https://control.example.com/');
		expect(script).toContain("ORIGIN=https://control.example.com");
		expect(script).toContain('--network-mode yoal');
		expect(script).toContain('yoal-agent join');
		expect(script).not.toContain('skn1_');
	});

	test('quotes an origin that is not shell-safe', () => {
		const script = renderNodeScript("https://control.example.com/it's");
		expect(script).toContain("'https://control.example.com/it'\\''s'");
	});
});
