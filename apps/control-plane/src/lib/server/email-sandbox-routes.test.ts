import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { roles, type Principal } from '@skiff/contracts';
import { ConflictError, CoreError } from '@skiff/core';

/**
 * The REST routes and the platform-admin page for email sandbox recipients and production access
 * (docs/EMAIL.md §4.3, §7.3) against a fake `core.email`: inputs are validated before core is
 * called, results come back in the documented envelopes, and only platform admins reach the queue.
 */

const calls: Array<{ op: string; args: unknown[] }> = [];
let caller: Principal;
let decideError: Error | null = null;

const address = (value: string, status: 'pending' | 'verified') => ({
	id: 'ea_1',
	address: value.toLowerCase(),
	status,
	verifiedAt: status === 'verified' ? '2026-11-07T00:00:00.000Z' : null,
	sentAt: status === 'pending' ? '2026-11-07T10:00:00.000Z' : null,
	expiresAt: status === 'pending' ? '2026-11-08T10:00:00.000Z' : null,
	createdAt: '2026-11-07T00:00:00.000Z'
});

const request = (overrides: Record<string, unknown> = {}) => ({
	id: 'ear_1',
	orgId: 'org_1',
	orgName: 'Acme',
	status: 'pending',
	useCase: 'Password resets and receipts for our customers.',
	expectedDailyVolume: 500,
	website: null,
	requestedBy: { id: 'usr_1', email: 'ada@acme.example' },
	decidedBy: null,
	decidedAt: null,
	note: null,
	perDay: null,
	perSecond: null,
	createdAt: '2026-11-07T10:00:00.000Z',
	...overrides
});

const fakeCore = {
	ctx: {
		platformIam: {
			canView: (principal: Principal) => principal.platformAdmin === true,
			canAdminister: (principal: Principal) =>
				principal.platformAdmin === true && principal.kind === 'user'
		}
	},
	email: {
		listSandboxAddresses: (...args: unknown[]) => {
			calls.push({ op: 'list', args });
			return [address('me@gmail.com', 'verified')];
		},
		addSandboxAddress: async (...args: unknown[]) => {
			calls.push({ op: 'add', args });
			const input = args[1] as { address: string };
			return address(input.address, input.address.startsWith('me@') ? 'verified' : 'pending');
		},
		removeSandboxAddress: (...args: unknown[]) => {
			calls.push({ op: 'remove', args });
		},
		accessRequest: () => null,
		requestProductionAccess: async (...args: unknown[]) => {
			calls.push({ op: 'request', args });
			return request();
		},
		listAccessRequests: (...args: unknown[]) => {
			calls.push({ op: 'listRequests', args });
			const principal = args[0] as Principal;
			if (!principal.platformAdmin)
				throw new CoreError(
					'forbidden',
					'Only a platform admin can see production access requests.',
					403
				);
			return [request()];
		},
		decideAccessRequest: async (...args: unknown[]) => {
			calls.push({ op: 'decide', args });
			if (decideError) throw decideError;
			const input = args[2] as {
				decision: string;
				note?: string;
				perDay?: number;
				perSecond?: number;
			};
			return input.decision === 'approve'
				? request({
						status: 'approved',
						perDay: input.perDay ?? 10_000,
						perSecond: input.perSecond ?? 10
					})
				: request({ status: 'denied', note: input.note });
		}
	}
};

mock.module('#lib/server/core.js', () => ({ core: fakeCore }));
// Every export another test file's mock of this module names too: Bun links mocks across files.
mock.module('#lib/server/principal.js', () => ({
	requirePrincipal: () => caller,
	principalFromMcp: () => null
}));

const addresses = await import('../../routes/api/v1/email/addresses/+server');
const oneAddress = await import('../../routes/api/v1/email/addresses/[address]/+server');
const accessRequest = await import('../../routes/api/v1/email/access-request/+server');
const accessRequests = await import('../../routes/api/v1/email/access-requests/+server');
const decide = await import('../../routes/api/v1/email/access-requests/[id]/+server');
const page = await import('../../routes/(dashboard)/email/requests/+page.server');

const member = (role: 'owner' | 'viewer', extra: Partial<Principal> = {}): Principal =>
	({
		kind: 'user',
		userId: 'usr_1',
		orgId: 'org_1',
		role,
		permissions: new Set(roles[role]),
		...extra
	}) as Principal;
const admin = () => member('owner', { platformAdmin: true });

// The handlers only read these parts of a RequestEvent.
function event(method: string, path: string, body?: unknown, params: Record<string, string> = {}) {
	const url = new URL(`https://control.example.net${path}`);
	return {
		url,
		params,
		request: new Request(url, {
			method,
			...(body === undefined
				? {}
				: { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
		}),
		locals: { principal: caller }
	} as never;
}

function form(values: Record<string, string>) {
	const data = new FormData();
	for (const [key, value] of Object.entries(values)) data.set(key, value);
	return {
		request: new Request('https://control.example.net/email/requests', {
			method: 'POST',
			body: data
		}),
		locals: { principal: caller }
	} as never;
}

beforeEach(() => {
	calls.length = 0;
	caller = member('owner');
	decideError = null;
});

describe('sandbox recipient routes', () => {
	test('POST answers 201 for a new link and 200 for an address already verified', async () => {
		const created = await addresses.POST(
			event('POST', '/api/v1/email/addresses', { address: 'ada@gmail.com' })
		);
		expect(created.status).toBe(201);
		expect(((await created.json()) as { address: { status: string } }).address.status).toBe(
			'pending'
		);
		const known = await addresses.POST(
			event('POST', '/api/v1/email/addresses', { address: 'me@gmail.com' })
		);
		expect(known.status).toBe(200);
	});

	test('POST rejects a malformed address before core sends anything', async () => {
		const response = await addresses.POST(
			event('POST', '/api/v1/email/addresses', { address: 'not-an-address' })
		);
		expect(response.status).toBe(422);
		expect(calls).toHaveLength(0);
	});

	test('GET lists and DELETE removes by the URL-decoded address', async () => {
		const listed = await addresses.GET(event('GET', '/api/v1/email/addresses'));
		expect(((await listed.json()) as { addresses: unknown[] }).addresses).toHaveLength(1);
		const removed = await oneAddress.DELETE(
			event('DELETE', '/api/v1/email/addresses/me%40gmail.com', undefined, {
				address: 'me@gmail.com'
			})
		);
		expect(removed.status).toBe(204);
		expect(calls.at(-1)).toEqual({ op: 'remove', args: [caller, 'me@gmail.com'] });
	});
});

describe('production access routes', () => {
	test('POST /access-request validates the use case and volume, then answers 201', async () => {
		const short = await accessRequest.POST(
			event('POST', '/api/v1/email/access-request', { useCase: 'mail', expectedDailyVolume: 10 })
		);
		expect(short.status).toBe(422);
		const extra = await accessRequest.POST(
			event('POST', '/api/v1/email/access-request', {
				useCase: 'Password resets for our customers.',
				expectedDailyVolume: 10,
				plan: 'pro'
			})
		);
		expect(extra.status).toBe(422);
		expect(calls).toHaveLength(0);
		const ok = await accessRequest.POST(
			event('POST', '/api/v1/email/access-request', {
				useCase: 'Password resets for our customers.',
				expectedDailyVolume: 500,
				website: 'https://acme.example'
			})
		);
		expect(ok.status).toBe(201);
		expect(calls[0]?.args[1]).toEqual({
			useCase: 'Password resets for our customers.',
			expectedDailyVolume: 500,
			website: 'https://acme.example'
		});
	});

	test('GET /access-request answers null before the org ever asked', async () => {
		const response = await accessRequest.GET(event('GET', '/api/v1/email/access-request'));
		expect(await response.json()).toEqual({ request: null });
	});

	test('GET /access-requests checks ?status and leaves the platform check to core', async () => {
		caller = admin();
		const bad = await accessRequests.GET(
			event('GET', '/api/v1/email/access-requests?status=maybe')
		);
		expect(bad.status).toBe(422);
		const ok = await accessRequests.GET(
			event('GET', '/api/v1/email/access-requests?status=pending&limit=5')
		);
		expect(ok.status).toBe(200);
		expect(calls.at(-1)?.args[1]).toEqual({ status: 'pending', limit: 5 });
		caller = member('owner');
		const denied = await accessRequests.GET(event('GET', '/api/v1/email/access-requests'));
		expect(denied.status).toBe(403);
	});

	test('POST /access-requests/:id passes the decision through', async () => {
		caller = admin();
		const response = await decide.POST(
			event(
				'POST',
				'/api/v1/email/access-requests/ear_1',
				{ decision: 'approve', perDay: 2000 },
				{ id: 'ear_1' }
			)
		);
		expect(response.status).toBe(200);
		expect(
			((await response.json()) as { request: { status: string; perDay: number } }).request
		).toMatchObject({ status: 'approved', perDay: 2000 });
		expect(calls.at(-1)?.args.slice(1)).toEqual(['ear_1', { decision: 'approve', perDay: 2000 }]);
		const invalid = await decide.POST(
			event('POST', '/api/v1/email/access-requests/ear_1', { decision: 'later' }, { id: 'ear_1' })
		);
		expect(invalid.status).toBe(422);
	});
});

describe('the /email/requests page', () => {
	test('is for platform admins only', () => {
		caller = member('owner');
		expect(() => page.load({ locals: { principal: caller } } as never)).toThrow();
		caller = admin();
		const data = page.load({ locals: { principal: caller } } as never) as {
			requests: unknown[];
			canDecide: boolean;
		};
		expect(data.requests).toHaveLength(1);
		expect(data.canDecide).toBe(true);
	});

	test('approve sends the limits given and leaves blanks to the defaults', async () => {
		caller = admin();
		const result = (await page.actions.approve(
			form({ id: 'ear_1', perDay: '2000', perSecond: '', note: '' })
		)) as { success: string };
		expect(calls.at(-1)?.args.slice(1)).toEqual(['ear_1', { decision: 'approve', perDay: 2000 }]);
		expect(result.success).toContain('2,000 a day');
		const bad = (await page.actions.approve(form({ id: 'ear_1', perDay: '-3' }))) as {
			status: number;
			data: { fieldErrors: Record<string, string> };
		};
		expect(bad.status).toBe(400);
		expect(bad.data.fieldErrors.perDay).toBeTruthy();
	});

	test('deny needs a reason, and core conflicts come back as form failures', async () => {
		caller = admin();
		const missing = (await page.actions.deny(form({ id: 'ear_1', note: '  ' }))) as {
			status: number;
		};
		expect(missing.status).toBe(400);
		expect(calls.filter((call) => call.op === 'decide')).toHaveLength(0);
		await page.actions.deny(form({ id: 'ear_1', note: 'DMARC still fails.' }));
		expect(calls.at(-1)?.args.slice(1)).toEqual([
			'ear_1',
			{ decision: 'deny', note: 'DMARC still fails.' }
		]);
		decideError = new ConflictError('This request was already approved.');
		const conflict = (await page.actions.deny(form({ id: 'ear_1', note: 'Too late' }))) as {
			status: number;
			data: { message: string };
		};
		expect(conflict.status).toBe(409);
		expect(conflict.data.message).toContain('already approved');
	});

	test('an API key with platform view but no admin session cannot decide', async () => {
		caller = member('owner', { platformAdmin: true, kind: 'apiKey' } as Partial<Principal>);
		const data = page.load({ locals: { principal: caller } } as never) as { canDecide: boolean };
		expect(data.canDecide).toBe(false);
		await expect(page.actions.approve(form({ id: 'ear_1' }))).rejects.toMatchObject({
			status: 403
		});
		expect(calls.filter((call) => call.op === 'decide')).toHaveLength(0);
	});
});
