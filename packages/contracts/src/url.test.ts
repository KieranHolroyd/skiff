import { describe, expect, test } from 'bun:test';
import { contentUrl } from './url.ts';

describe('contentUrl', () => {
	test('production content is always HTTPS on the default port', () => {
		expect(contentUrl('https://control.example.com', 'blog.example.com')).toBe('https://blog.example.com');
		expect(contentUrl('http://127.0.0.1:5173', 'blog.example.com')).toBe('https://blog.example.com');
	});

	test('loopback dev hosts reuse the platform scheme and port', () => {
		expect(contentUrl('http://localhost:5173', 'blog.localhost')).toBe('http://blog.localhost:5173');
		expect(contentUrl('http://localhost:5173', 'blog--staging.localhost')).toBe(
			'http://blog--staging.localhost:5173'
		);
		expect(contentUrl('http://localhost', 'blog.localhost')).toBe('http://blog.localhost');
		expect(contentUrl('https://localhost:8443', 'blog.localhost')).toBe('https://blog.localhost:8443');
	});

	test('normalizes trailing dots and empty platform origins', () => {
		expect(contentUrl('http://localhost:5173', 'Blog.LocalHost.')).toBe('http://blog.localhost:5173');
		expect(contentUrl('', 'blog.localhost')).toBe('https://blog.localhost');
	});

	test('a hostname that merely contains localhost is not loopback', () => {
		expect(contentUrl('http://localhost:5173', 'localhost.example.com')).toBe('https://localhost.example.com');
	});
});
