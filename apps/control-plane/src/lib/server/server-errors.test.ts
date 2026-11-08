import { describe, expect, test } from 'bun:test';
import type { RequestEvent } from '@sveltejs/kit';
import type { ServerErrorCapture } from '@skiff/core';
import {
	reportBackgroundError,
	reportErrorResponse,
	reportRequestError,
	setServerErrorSink,
	withErrorContext
} from './server-errors';

const captured: ServerErrorCapture[] = [];
setServerErrorSink({
	capture(input) {
		captured.push(input);
		return { issueId: `err_${captured.length}` };
	}
});

function fakeEvent(path: string): RequestEvent {
	return {
		request: new Request(`https://control.test${path}?token=secret`, { method: 'POST' }),
		url: new URL(`https://control.test${path}?token=secret`),
		route: { id: '/api/v1/things/[id]' },
		locals: { principal: { userId: 'user_a', orgId: 'org_a', kind: 'user' } },
		isDataRequest: false
	} as unknown as RequestEvent;
}

describe('server error reporting', () => {
	test('an error inside a request carries its context, and its 500 is not recorded twice', async () => {
		captured.length = 0;
		const event = fakeEvent('/api/v1/things/1');
		const id = await withErrorContext(event, async () => {
			await Promise.resolve();
			const issueId = reportRequestError(new Error('boom'));
			reportErrorResponse(event, new Response(null, { status: 500 }));
			return issueId;
		});
		expect(id).toBe('err_1');
		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({
			source: 'api',
			method: 'POST',
			path: '/api/v1/things/1',
			routeId: '/api/v1/things/[id]',
			userId: 'user_a',
			orgId: 'org_a'
		});
	});

	test('a bare 5xx is recorded as a response; 4xx is not', async () => {
		captured.length = 0;
		const event = fakeEvent('/projects');
		await withErrorContext(event, async () => {
			reportErrorResponse(event, new Response(null, { status: 404 }));
			reportErrorResponse(event, new Response(null, { status: 502 }));
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({ source: 'response', status: 502, name: 'HTTP 502' });
	});

	test('background errors name their task', () => {
		captured.length = 0;
		const original = console.error;
		console.error = () => undefined;
		try {
			reportBackgroundError('jobs', new Error('tick'));
		} finally {
			console.error = original;
		}
		expect(captured[0]).toMatchObject({ source: 'background', culprit: 'jobs' });
	});
});
