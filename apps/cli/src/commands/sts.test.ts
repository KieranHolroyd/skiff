import { describe, expect, test } from 'bun:test';
import {
	JWT_TOKEN_TYPE,
	TOKEN_EXCHANGE_GRANT,
	buildTokenExchangeBody,
	parseExchangeScopes,
	parseStsResponse,
	stsErrorText,
} from './sts.ts';

describe('parseExchangeScopes', () => {
	test('splits repeats, commas and whitespace, then deduplicates', () => {
		expect(
			parseExchangeScopes(['project:read,database:read', 'project:read deployment:create']),
		).toBe('project:read database:read deployment:create');
	});

	test('an absent scope stays absent', () => {
		expect(parseExchangeScopes([])).toBe('');
	});

	test('separators without a permission are refused', () => {
		expect(() => parseExchangeScopes([' , '])).toThrow();
	});
});

describe('buildTokenExchangeBody', () => {
	test('sends the grant, subject token, type and audience', () => {
		const body = buildTokenExchangeBody({
			subjectToken: 'eyJ.header.signature',
			audience: 'https://control.example.com',
		});
		expect(body.get('grant_type')).toBe(TOKEN_EXCHANGE_GRANT);
		expect(body.get('subject_token')).toBe('eyJ.header.signature');
		expect(body.get('subject_token_type')).toBe(JWT_TOKEN_TYPE);
		expect(body.get('audience')).toBe('https://control.example.com');
		expect(body.get('scope')).toBeNull();
		expect(body.get('trust_id')).toBeNull();
	});

	test('includes a narrowed scope and a chosen trust', () => {
		const body = buildTokenExchangeBody({
			subjectToken: 'eyJ.header.signature',
			audience: 'skiff',
			scope: 'project:read deployment:create',
			trustId: 'ft_github',
		});
		expect(body.get('scope')).toBe('project:read deployment:create');
		expect(body.get('trust_id')).toBe('ft_github');
	});
});

describe('parseStsResponse', () => {
	test('keeps the RFC 8693 response fields', () => {
		expect(
			parseStsResponse({
				access_token: 'eyJ.header.signature',
				issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
				token_type: 'Bearer',
				expires_in: 900,
			}),
		).toEqual({
			access_token: 'eyJ.header.signature',
			issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
			token_type: 'Bearer',
			expires_in: 900,
		});
	});

	test('defaults the type and expiry, and refuses a response without a token', () => {
		expect(parseStsResponse({ access_token: 'eyJ.header.signature' })).toMatchObject({
			token_type: 'Bearer',
			expires_in: 0,
			issued_token_type: '',
		});
		expect(() => parseStsResponse({ expires_in: 900 })).toThrow();
		expect(() => parseStsResponse(null)).toThrow();
	});
});

describe('stsErrorText', () => {
	test('shows the RFC 8693 code and description', () => {
		expect(
			stsErrorText({ error: 'invalid_grant', error_description: 'No trust matched.' }),
		).toBe('invalid_grant: No trust matched.');
		expect(stsErrorText({ error: 'invalid_request' })).toBe('invalid_request');
		expect(stsErrorText({ error_description: 'Only a description.' })).toBe(
			'Only a description.',
		);
	});

	test('returns null for a non-error body', () => {
		expect(stsErrorText(null)).toBeNull();
		expect(stsErrorText({ access_token: 'eyJ.header.signature' })).toBeNull();
	});
});
