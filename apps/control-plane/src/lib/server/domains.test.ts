import { describe, expect, test } from 'bun:test';
import { isSharedDomain, registrableDomain } from './domains';

describe('isSharedDomain', () => {
	test('two registrable domains are separate', () => {
		expect(isSharedDomain('control.kieran.dev', 'kierancloud.dev')).toBe(false);
		expect(isSharedDomain('cloud.example.co.uk', 'sites.other.co.uk')).toBe(false);
	});

	test('same or nested domains are shared, in both directions', () => {
		expect(isSharedDomain('kieran.dev', 'kieran.dev')).toBe(true);
		expect(isSharedDomain('control.kieran.dev', 'kieran.dev')).toBe(true);
		expect(isSharedDomain('kieran.dev', 'sites.kieran.dev')).toBe(true);
	});

	test('siblings under one registrable domain are shared', () => {
		expect(isSharedDomain('cloud.example.com', 'sites.example.com')).toBe(true);
		expect(isSharedDomain('cloud.example.co.uk', 'sites.example.co.uk')).toBe(true);
	});

	test('localhost dev setups compare exactly', () => {
		expect(isSharedDomain('localhost', 'localhost')).toBe(true);
		expect(isSharedDomain('127.0.0.1', 'localhost')).toBe(false);
	});

	test('registrableDomain handles common ccTLD second levels', () => {
		expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
		expect(registrableDomain('a.b.example.dev')).toBe('example.dev');
	});
});
