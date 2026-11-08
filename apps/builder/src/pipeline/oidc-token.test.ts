import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAction } from './actions.ts';
import { JobApi } from './client.ts';
import { testHost } from './image-test-fixtures.ts';
import { jobClaim } from './test-server.ts';

/** `skiff/oidc-token` (W9) against a fake `/api/pipeline/oidc-token`. */

const ID_TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJyZXBvOmFjbWUvYXBwIn0.c2lnbmF0dXJl';
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fakeControlPlane(status: number) {
	const requests: Array<{ authorization: string | null; body: unknown }> = [];
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			if (new URL(request.url).pathname !== '/api/pipeline/oidc-token' || request.method !== 'POST') return new Response('not found', { status: 404 });
			requests.push({ authorization: request.headers.get('authorization'), body: await request.json() });
			if (status !== 200) return new Response('{"error":"forbidden"}', { status });
			return Response.json({ token: ID_TOKEN, expiresAt: 1_900_000_000_000 });
		},
	});
	cleanups.push(() => server.stop(true));
	const dir = mkdtempSync(join(tmpdir(), 'skiff-oidc-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const host = testHost({ claim: jobClaim({ steps: [] }), workspace: dir, temp: join(dir, 'tmp') });
	host.api = new JobApi(`http://127.0.0.1:${server.port}`, 'job-token-123');
	return { host, requests };
}

describe('skiff/oidc-token', () => {
	test('mints a token with the job token, masks it and outputs it', async () => {
		const { host, requests } = fakeControlPlane(200);
		const result = await runAction('skiff/oidc-token', { audience: 'sts.amazonaws.com' }, host);
		expect(result).toEqual({ outcome: 'success', outputs: { token: ID_TOKEN, 'expires-at': '1900000000000' } });
		expect(requests).toEqual([{ authorization: 'Bearer job-token-123', body: { audience: 'sts.amazonaws.com' } }]);
		expect(host.masker.mask(`token: ${ID_TOKEN}`)).toBe('token: ***');
		expect(host.lines.join('\n')).not.toContain(ID_TOKEN);
		expect(host.env).not.toHaveProperty('SKIFF_OIDC_TOKEN');

		const { host: plain, requests: plainRequests } = fakeControlPlane(200);
		expect((await runAction('skiff/oidc-token', {}, plain)).outcome).toBe('success');
		expect(plainRequests[0]!.body).toEqual({});
	});

	test('untrusted runs get a clear failure on 403', async () => {
		const { host } = fakeControlPlane(403);
		const result = await runAction('skiff/oidc-token', {}, host);
		expect(result).toEqual({ outcome: 'failure', outputs: {} });
		expect(host.lines.join('\n')).toContain('OIDC tokens are not available to untrusted runs (fork pull requests, inline workflows)');
	});
});
