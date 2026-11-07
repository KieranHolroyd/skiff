import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mailHostnames, roles, type EmailDomainView, type Principal } from '@skiff/contracts';

/**
 * The Email MCP tools (docs/EMAIL.md §9) against a fake `core.email`: the EMAIL flag hides them,
 * `get_email_domain` spells out the missing DNS records, and the assistant gates sending.
 */

const sends: unknown[] = [];
const audits: Array<{ action: string }> = [];
const features: Record<string, boolean> = { EMAIL: true };

const pendingDomain: EmailDomainView = {
	id: 'ed_1',
	name: 'example.com',
	status: 'pending',
	sending: true,
	receiving: false,
	dkimSelector: 'skiff2611',
	records: [
		{
			purpose: 'dkim',
			type: 'TXT',
			name: 'skiff2611._domainkey.example.com',
			value: 'v=DKIM1; k=rsa; p=MIIB',
			required: true,
			ok: false,
			found: [],
			managed: false,
			note: 'Not found yet. DNS changes can take a few minutes.'
		},
		{
			purpose: 'spf',
			type: 'TXT',
			name: 'example.com',
			value: 'v=spf1 include:_spf.example.net ~all',
			required: false,
			ok: true,
			found: ['v=spf1 include:_spf.example.net ~all'],
			managed: false,
			note: null
		}
	],
	lastCheckedAt: null,
	verifiedAt: null,
	failingSince: null,
	createdAt: '2026-11-07T00:00:00.000Z'
};

const addressCalls: Array<{ op: string; address: string }> = [];
let orgState: 'sandbox' | 'active' = 'sandbox';
let accessRequest: { status: 'pending' | 'approved' | 'denied'; createdAt: string; note: string | null } | null = null;

const fakeCore = {
	ctx: { config: { features, platformOrigin: 'https://control.example.net' } },
	audit: { record: (entry: { action: string }) => audits.push(entry) },
	email: {
		settings: () => ({
			nodeId: 'node_1',
			paused: false,
			generation: 1,
			mailDomain: 'example.net',
			hostnames: mailHostnames('example.net')
		}),
		listDomains: () => [pendingDomain],
		getDomain: () => pendingDomain,
		send: async (_principal: Principal, input: unknown) => {
			sends.push(input);
			return { id: 'em_test', accepted: ['ada@example.org'], suppressed: [] };
		},
		orgView: () => ({
			state: orgState,
			perSecond: 1,
			perDay: 200,
			sentToday: 0,
			bounceRate: null,
			complaintRate: null,
			windowMessages: 0,
			pausedReason: null
		}),
		accessRequest: () => accessRequest,
		listSandboxAddresses: () => [
			{
				id: 'ea_1',
				address: 'me@gmail.com',
				status: 'verified',
				verifiedAt: '2026-11-07T00:00:00.000Z',
				sentAt: null,
				expiresAt: null,
				createdAt: '2026-11-07T00:00:00.000Z'
			}
		],
		addSandboxAddress: async (_principal: Principal, input: { address: string }) => {
			addressCalls.push({ op: 'add', address: input.address });
			return {
				id: 'ea_2',
				address: input.address.toLowerCase(),
				status: 'pending',
				verifiedAt: null,
				sentAt: '2026-11-07T10:00:00.000Z',
				expiresAt: '2026-11-08T10:00:00.000Z',
				createdAt: '2026-11-07T10:00:00.000Z'
			};
		},
		removeSandboxAddress: (_principal: Principal, address: string) => {
			addressCalls.push({ op: 'remove', address });
		}
	}
};

mock.module('./core', () => ({ core: fakeCore }));
mock.module('./config', () => ({ authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { skiffToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

const principal = (role: 'deployer' | 'viewer'): Principal =>
	({
		kind: 'user',
		userId: 'usr_1',
		orgId: 'org_1',
		role,
		permissions: new Set(roles[role])
	}) as Principal;

const EMAIL_TOOLS = [
	'get_email_status',
	'list_email_domains',
	'get_email_domain',
	'create_email_domain',
	'check_email_domain',
	'send_email',
	'list_email_messages',
	'get_email_message',
	'list_email_suppressions',
	'remove_email_suppression',
	'list_email_addresses',
	'add_email_address',
	'remove_email_address'
];

describe('email MCP tools', () => {
	beforeEach(() => {
		features.EMAIL = true;
		sends.length = 0;
		audits.length = 0;
		addressCalls.length = 0;
		orgState = 'sandbox';
		accessRequest = null;
	});

	test('are offered only while SKIFF_FEATURE_EMAIL is on', () => {
		const on = new Set(skiffToolDefinitions(principal('deployer')).map((tool) => tool.name));
		for (const name of EMAIL_TOOLS) expect(on.has(name)).toBe(true);
		features.EMAIL = false;
		const off = new Set(skiffToolDefinitions(principal('deployer')).map((tool) => tool.name));
		for (const name of EMAIL_TOOLS) expect(off.has(name)).toBe(false);
		expect(off.has('whoami')).toBe(true);
	});

	test('never include credential, settings or org-state tools (D58)', () => {
		const names = skiffToolDefinitions(principal('deployer')).map((tool) => tool.name);
		expect(
			names.filter((name) => name.includes('email') && /credential|setting|org_state/.test(name))
		).toEqual([]);
	});

	test('get_email_domain tells the agent exactly which records are missing', async () => {
		const tool = assistantTools(principal('viewer')).find(
			(entry) => entry.name === 'get_email_domain'
		)!;
		const result = await tool.run({ domain: 'example.com' });
		expect(result.ok).toBe(true);
		const body = JSON.parse(result.text) as { nextSteps: string[] };
		expect(body.nextSteps[0]).toContain('TXT record at skiff2611._domainkey.example.com');
		expect(body.nextSteps[0]).toContain('v=DKIM1; k=rsa; p=MIIB');
		// The SPF record already checks out, so it is not repeated.
		expect(body.nextSteps.some((step) => step.includes('(spf)'))).toBe(false);
		expect(body.nextSteps.at(-1)).toContain('check_email_domain');
	});

	test('the assistant asks before sending or un-suppressing, and hides sending from viewers', () => {
		const deployer = new Map(
			assistantTools(principal('deployer')).map((tool) => [tool.name, tool])
		);
		expect(deployer.get('send_email')?.destructive).toBe(true);
		expect(deployer.get('remove_email_suppression')?.destructive).toBe(true);
		expect(deployer.get('list_email_messages')?.destructive).toBe(false);
		const viewer = new Set(assistantTools(principal('viewer')).map((tool) => tool.name));
		expect(viewer.has('send_email')).toBe(false);
		expect(viewer.has('remove_email_suppression')).toBe(false);
		expect(viewer.has('list_email_domains')).toBe(true);
	});

	test('send_email hands the message to core.email.send and reports the id', async () => {
		const tool = assistantTools(principal('deployer')).find(
			(entry) => entry.name === 'send_email'
		)!;
		const result = await tool.run({
			from: 'hi@example.com',
			to: ['ada@example.org'],
			subject: 'Hello',
			text: 'Hi Ada'
		});
		expect(result.ok).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0]).toMatchObject({
			from: 'hi@example.com',
			to: ['ada@example.org'],
			subject: 'Hello',
			text: 'Hi Ada'
		});
		expect((sends[0] as { idempotencyKey?: string }).idempotencyKey).toBeUndefined();
		expect(JSON.parse(result.text).id).toBe('em_test');
		expect(audits.map((entry) => entry.action)).toEqual(['assistant.send_email']);
	});

	test('the assistant asks before adding or removing a sandbox recipient; viewers get neither', () => {
		const deployer = new Map(
			assistantTools(principal('deployer')).map((tool) => [tool.name, tool])
		);
		expect(deployer.get('add_email_address')?.destructive).toBe(true);
		expect(deployer.get('remove_email_address')?.destructive).toBe(true);
		expect(deployer.get('list_email_addresses')?.destructive).toBe(false);
		const viewer = new Set(assistantTools(principal('viewer')).map((tool) => tool.name));
		expect(viewer.has('add_email_address')).toBe(false);
		expect(viewer.has('remove_email_address')).toBe(false);
		expect(viewer.has('list_email_addresses')).toBe(true);
	});

	test('add_email_address mails the link through core and says what happens next', async () => {
		const tool = assistantTools(principal('deployer')).find(
			(entry) => entry.name === 'add_email_address'
		)!;
		const result = await tool.run({ address: 'Ada@Gmail.com' });
		expect(result.ok).toBe(true);
		expect(addressCalls).toEqual([{ op: 'add', address: 'Ada@Gmail.com' }]);
		const body = JSON.parse(result.text) as { address: { status: string }; nextSteps: string[] };
		expect(body.address.status).toBe('pending');
		expect(body.nextSteps[0]).toContain('A verification link went to ada@gmail.com');
		expect(body.nextSteps[0]).toContain('2026-11-08T10:00:00.000Z');
	});

	test('remove_email_address and list_email_addresses go through core', async () => {
		const tools = new Map(assistantTools(principal('deployer')).map((tool) => [tool.name, tool]));
		const removed = await tools.get('remove_email_address')!.run({ address: 'me@gmail.com' });
		expect(removed.ok).toBe(true);
		expect(addressCalls).toEqual([{ op: 'remove', address: 'me@gmail.com' }]);
		const listed = await tools.get('list_email_addresses')!.run({});
		const body = JSON.parse(listed.text) as { state: string; addresses: Array<{ address: string }>; note?: string };
		expect(body.state).toBe('sandbox');
		expect(body.addresses.map((entry) => entry.address)).toEqual(['me@gmail.com']);
		expect(body.note).toBeUndefined();
	});

	test('get_email_status points a sandboxed org at requesting production access', async () => {
		const status = assistantTools(principal('viewer')).find(
			(entry) => entry.name === 'get_email_status'
		)!;
		let body = JSON.parse((await status.run({})).text) as { nextSteps: string[] };
		expect(body.nextSteps.some((step) => step.includes('add_email_address'))).toBe(true);
		const ask = body.nextSteps.find((step) => step.includes('requests production access'));
		expect(ask).toContain('skif email request-access');
		expect(ask).toContain('https://control.example.net/api/v1/email/access-request');

		accessRequest = { status: 'pending', createdAt: '2026-11-07T09:00:00.000Z', note: null };
		body = JSON.parse((await status.run({})).text) as { nextSteps: string[] };
		expect(body.nextSteps.some((step) => step.includes('waiting for a platform admin'))).toBe(true);
		expect(body.nextSteps.some((step) => step.includes('skif email request-access'))).toBe(false);

		accessRequest = { status: 'denied', createdAt: '2026-11-07T09:00:00.000Z', note: 'DMARC fails' };
		body = JSON.parse((await status.run({})).text) as { nextSteps: string[] };
		expect(body.nextSteps.some((step) => step.includes('denied (DMARC fails)'))).toBe(true);
	});
});
