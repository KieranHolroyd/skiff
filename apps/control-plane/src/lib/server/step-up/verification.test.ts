import { describe, expect, test } from 'bun:test';
import { verificationFromSession } from './verification';

describe('verificationFromSession', () => {
	test('reads the plugin session fields', () => {
		expect(
			verificationFromSession({
				verificationAt: 1_700_000_000_000,
				verificationClass: 'strong',
				strongest: 'strong',
			}),
		).toEqual({ at: 1_700_000_000_000, class: 'strong', strongest: 'strong' });
	});

	test('accepts the older verifiedAt/verifiedClass spelling and ISO dates', () => {
		expect(
			verificationFromSession({
				verifiedAt: new Date(1_700_000_000_000).toISOString(),
				verifiedClass: 'basic',
			}),
		).toEqual({ at: 1_700_000_000_000, class: 'basic', strongest: 'basic' });
	});

	test('fails closed without a time or a class', () => {
		expect(verificationFromSession(null)).toBeUndefined();
		expect(verificationFromSession({ verificationClass: 'strong' })).toBeUndefined();
		expect(verificationFromSession({ verificationAt: 1_700_000_000_000 })).toBeUndefined();
		expect(
			verificationFromSession({ verificationAt: 1_700_000_000_000, verificationClass: 'nonsense' }),
		).toBeUndefined();
	});

	test('a missing strongest falls back to the class that was used', () => {
		expect(
			verificationFromSession({ verificationAt: 1_700_000_000_000, verificationClass: 'basic' }),
		).toEqual({ at: 1_700_000_000_000, class: 'basic', strongest: 'basic' });
	});
});
