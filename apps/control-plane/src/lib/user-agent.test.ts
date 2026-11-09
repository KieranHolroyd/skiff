import { describe, expect, test } from 'bun:test';
import { describeUserAgent } from './user-agent.ts';

describe('describeUserAgent', () => {
	test('recognises desktop browsers', () => {
		expect(
			describeUserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
			)
		).toBe('Chrome on macOS');
		expect(
			describeUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'
			)
		).toBe('Firefox on Windows');
		expect(
			describeUserAgent(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'
			)
		).toBe('Safari on macOS');
	});

	test('recognises mobile browsers without confusing Chrome for Safari', () => {
		expect(
			describeUserAgent(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1'
			)
		).toBe('Chrome on iPhone');
		expect(
			describeUserAgent(
				'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
			)
		).toBe('Chrome on Android');
		expect(
			describeUserAgent(
				'Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
			)
		).toBe('Safari on iPad');
	});

	test('prefers Edge and Opera over Chrome', () => {
		expect(
			describeUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
			)
		).toBe('Edge on Windows');
		expect(
			describeUserAgent(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/116.0.0.0'
			)
		).toBe('Opera on Windows');
	});

	test('handles missing and automated clients', () => {
		expect(describeUserAgent(null)).toBe('Unknown device');
		expect(describeUserAgent('   ')).toBe('Unknown device');
		expect(describeUserAgent('curl/8.10.1')).toBe('Automated client');
		expect(describeUserAgent('YoalBot/1.0 (+https://example.com)')).toBe('Automated client');
	});

	test('falls back to whatever part it can identify', () => {
		expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux');
		expect(describeUserAgent('SomeCustomBrowser/2.0')).toBe('Unknown device');
	});
});
