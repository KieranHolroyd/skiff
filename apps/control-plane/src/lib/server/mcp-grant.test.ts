import { describe, expect, test } from 'bun:test';
import { grantRevokedResponse } from './mcp-grant';

describe('grantRevokedResponse', () => {
	test('is a 401 RFC 9728 challenge, so the client re-authorizes', async () => {
		const response = grantRevokedResponse('https://control.example.com/mcp');
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe(
			'Bearer resource_metadata="https://control.example.com/.well-known/oauth-protected-resource/mcp"',
		);
		const body = (await response.json()) as { jsonrpc: string; error: { code: number; message: string } };
		expect(body.jsonrpc).toBe('2.0');
		expect(body.error.message).toContain('disconnected');
	});
});
