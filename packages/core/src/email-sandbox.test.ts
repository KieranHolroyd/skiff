import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES, EMAIL_SANDBOX_ADDRESS_LIMITS, mailStateSchema } from '@skiff/contracts';
import type { AlertMessage, EmailMessage } from './config.ts';
import type { EmailDnsResolver } from './email.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/** Email sandbox flows (docs/EMAIL.md §4.3, §7.3): verified recipients and production access requests. */

const dir = mkdtempSync(join(tmpdir(), 'skiff-email-sandbox-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-07T10:00:00Z');

/** Platform mail (D22) as the tests see it; `failNext` makes the next send throw. */
const mail: EmailMessage[] = [];
let failNext = false;
const alerts: AlertMessage[] = [];

const txt = new Map<string, string[]>();
const dns: EmailDnsResolver = {
	async resolveTxt(name) {
		const values = txt.get(name);
		if (!values) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
		return values.map((value) => [value]);
	},
	async resolveMx() {
		throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
	},
};

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.skiff.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		features: { ...DEFAULT_FEATURES },
		email: {
			async send(message) {
				if (failNext) {
					failNext = false;
					throw new Error('SMTP said no');
				}
				mail.push(message);
			},
		},
		notifiers: [{ name: 'test', notify: async (alert) => void alerts.push(alert) }],
	},
	email: { dns },
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_admin', role: 'owner', platformAdmin: true });
const adminKey = buildPrincipal({ kind: 'apiKey', userId: 'user_admin', orgId: 'org_admin', role: 'owner', platformAdmin: true });
const owner = buildPrincipal({ kind: 'user', userId: 'user_owner', orgId: 'org_t', role: 'owner' });
const ownerKey = buildPrincipal({ kind: 'apiKey', userId: 'user_owner', orgId: 'org_t', role: 'owner' });
const deployer = buildPrincipal({ kind: 'user', userId: 'user_dep', orgId: 'org_t', role: 'deployer' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_view', orgId: 'org_t', role: 'viewer' });

/** The token in the last verification mail. */
function lastToken(): string {
	const match = /verify-email-address\?token=([A-Za-z0-9_-]+)/.exec(mail.at(-1)?.text ?? '');
	if (!match) throw new Error('no verification link in the last mail');
	return decodeURIComponent(match[1]!);
}

beforeAll(async () => {
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT)');
	opened.sqlite.run('CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT, createdAt TEXT)');
	opened.sqlite.run(`INSERT INTO "user" (id, email, name) VALUES ('user_owner', 'owner@tenant.test', 'Owner'), ('user_admin', 'admin@skiff.test', 'Admin')`);
	opened.sqlite.run(`INSERT INTO organization (id, name, slug) VALUES ('org_t', 'Tenant Ltd', 'tenant')`);

	// A mail node and a verified domain for the tenant, so sends reach the sandbox check.
	const joined = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'edge').token, name: 'edge', publicAddress: '203.0.113.10' });
	core.nodes.heartbeat(joined.token, { nodeId: joined.nodeId, agentVersion: '0.1.0', actualStateVersion: 1, status: 'online', caddyOk: true, releases: [], capabilities: ['mail'] });
	await core.email.configure(admin, { nodeId: joined.nodeId });
	const domain = await core.email.createDomain(owner, { name: 'tenant.test', autoDns: false });
	const dkim = domain.records.find((record) => record.purpose === 'dkim')!;
	txt.set(dkim.name, [dkim.value]);
	expect((await core.email.checkDomain(owner, 'tenant.test')).status).toBe('verified');
	nodeId = joined.nodeId;
});

let nodeId = '';

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('sandbox recipients', () => {
	test('adding an address mails a single-use link through platform mail', async () => {
		const added = await core.email.addSandboxAddress(owner, { address: 'Ada@Gmail.com' });
		expect(added).toMatchObject({ address: 'ada@gmail.com', status: 'pending', verifiedAt: null });
		expect(added.expiresAt).toBe(new Date(clock + EMAIL_SANDBOX_ADDRESS_LIMITS.linkTtlSeconds * 1000).toISOString());
		const sent = mail.at(-1)!;
		expect(sent.to).toBe('ada@gmail.com');
		expect(sent.subject).toContain('Tenant Ltd');
		expect(sent.text).toContain('owner@tenant.test');
		expect(sent.text).toContain('https://control.skiff.test/verify-email-address?token=');
		expect(core.email.listSandboxAddresses(viewer).map((entry) => entry.address)).toEqual(['ada@gmail.com']);
	});

	test('a pending address does not open the sandbox', async () => {
		clock += 2000;
		await expect(core.email.send(ownerKey, { from: 'hi@tenant.test', to: ['ada@gmail.com'], subject: 'x', text: 'x' })).rejects.toThrow(/sandbox/);
	});

	test('viewers cannot add; resends are paced and replace the link', async () => {
		await expect(core.email.addSandboxAddress(viewer, { address: 'x@gmail.com' })).rejects.toThrow(/email:update/);
		await expect(core.email.addSandboxAddress(owner, { address: 'not an address' })).rejects.toThrow();
		await expect(core.email.addSandboxAddress(owner, { address: 'ada@gmail.com' })).rejects.toThrow(/less than a minute/);
		const first = lastToken();
		clock += 61_000;
		await core.email.addSandboxAddress(deployer, { address: 'ada@gmail.com' });
		const second = lastToken();
		expect(second).not.toBe(first);
		expect(core.email.peekSandboxVerification(first)).toBeNull();
		expect(core.email.peekSandboxVerification(second)).toMatchObject({ address: 'ada@gmail.com', orgName: 'Tenant Ltd', expired: false });
	});

	test('a failed verification mail leaves no row behind', async () => {
		failNext = true;
		await expect(core.email.addSandboxAddress(owner, { address: 'bob@gmail.com' })).rejects.toThrow(/SMTP said no/);
		expect(core.email.listSandboxAddresses(owner).map((entry) => entry.address)).toEqual(['ada@gmail.com']);
	});

	test('confirming verifies the address once; sends to it then pass the sandbox', async () => {
		const token = lastToken();
		const generation = core.email.settings().generation;
		expect(core.email.verifySandboxAddress(token)).toEqual({ address: 'ada@gmail.com', orgName: 'Tenant Ltd' });
		expect(core.email.settings().generation).toBe(generation + 1);
		expect(() => core.email.verifySandboxAddress(token)).toThrow(/already used/);
		expect(core.email.listSandboxAddresses(owner)[0]).toMatchObject({ status: 'verified', expiresAt: null });
		// Adding it again is a no-op, not another mail.
		const before = mail.length;
		expect((await core.email.addSandboxAddress(owner, { address: 'ada@gmail.com' })).status).toBe('verified');
		expect(mail.length).toBe(before);

		clock += 2000;
		const result = await core.email.send(ownerKey, { from: 'hi@tenant.test', to: ['ada@gmail.com'], subject: 'Hello', text: 'Hi' });
		expect(result.accepted).toEqual(['ada@gmail.com']);
		const org = mailStateSchema.parse(core.email.stateForNode(nodeId)).orgs.find((entry) => entry.orgId === 'org_t')!;
		expect(org.verifiedAddresses).toEqual(['ada@gmail.com']);
	});

	test('links expire after a day', async () => {
		clock += 61_000;
		await core.email.addSandboxAddress(owner, { address: 'late@gmail.com' });
		const token = lastToken();
		clock += EMAIL_SANDBOX_ADDRESS_LIMITS.linkTtlSeconds * 1000;
		expect(core.email.peekSandboxVerification(token)).toMatchObject({ expired: true });
		expect(() => core.email.verifySandboxAddress(token)).toThrow(/expired/);
		expect(() => core.email.verifySandboxAddress('bogus')).toThrow(/not valid/);
	});

	test('removing an address takes it off the mail node', () => {
		core.email.removeSandboxAddress(owner, 'ADA@gmail.com');
		expect(() => core.email.removeSandboxAddress(owner, 'ada@gmail.com')).toThrow(/not found/);
		const org = mailStateSchema.parse(core.email.stateForNode(nodeId)).orgs.find((entry) => entry.orgId === 'org_t')!;
		expect(org.verifiedAddresses).toEqual([]);
		const actions = opened.sqlite
			.query<{ action: string }, []>("SELECT action FROM audit_log WHERE action LIKE 'email.address.%' ORDER BY rowid")
			.all()
			.map((row) => row.action);
		expect(actions).toEqual(['email.address.add', 'email.address.resend', 'email.address.verify', 'email.address.add', 'email.address.remove']);
	});

	test('at most a handful of addresses wait for verification at once', async () => {
		for (let i = 0; i < EMAIL_SANDBOX_ADDRESS_LIMITS.maxPending - 1; i++) await core.email.addSandboxAddress(owner, { address: `p${i}@gmail.com` });
		await expect(core.email.addSandboxAddress(owner, { address: 'one-too-many@gmail.com' })).rejects.toThrow(/waiting for verification/);
	});
});

describe('production access', () => {
	const request = { useCase: 'Password resets and receipts for our shop customers.', expectedDailyVolume: 500, website: 'https://tenant.test' };

	test('only an owner or admin may ask, with a real use case', async () => {
		await expect(core.email.requestProductionAccess(deployer, request)).rejects.toThrow(/owner or admin/);
		await expect(core.email.requestProductionAccess(owner, { ...request, useCase: 'mail' })).rejects.toThrow();
		await expect(core.email.requestProductionAccess(owner, { ...request, website: 'ftp://tenant.test' })).rejects.toThrow();
		expect(core.email.accessRequest(viewer)).toBeNull();
	});

	test('a request notifies the platform admins; one at a time', async () => {
		const created = await core.email.requestProductionAccess(ownerKey, request);
		expect(created).toMatchObject({ status: 'pending', orgName: 'Tenant Ltd', expectedDailyVolume: 500, requestedBy: { id: 'user_owner', email: 'owner@tenant.test' } });
		expect(alerts.at(-1)).toMatchObject({ key: `email.access_request.${created.id}`, severity: 'info' });
		expect(alerts.at(-1)!.detail).toContain('https://control.skiff.test/email/requests');
		await expect(core.email.requestProductionAccess(owner, request)).rejects.toThrow(/already waiting/);
		expect(core.email.accessRequest(viewer)?.id).toBe(created.id);
	});

	test('only platform admins see and decide the queue', async () => {
		expect(() => core.email.listAccessRequests(owner)).toThrow(/platform admin/);
		const [pending] = core.email.listAccessRequests(adminKey, { status: 'pending' });
		expect(pending?.orgId).toBe('org_t');
		await expect(core.email.decideAccessRequest(adminKey, pending!.id, { decision: 'approve' })).rejects.toThrow(/platform admin/);
		await expect(core.email.decideAccessRequest(owner, pending!.id, { decision: 'approve' })).rejects.toThrow(/platform admin/);
	});

	test('a denial needs a reason, keeps the sandbox and mails the requester', async () => {
		const [pending] = core.email.listAccessRequests(admin, { status: 'pending' });
		await expect(core.email.decideAccessRequest(admin, pending!.id, { decision: 'deny' })).rejects.toThrow(/why/);
		const denied = await core.email.decideAccessRequest(admin, pending!.id, { decision: 'deny', note: 'Verify a domain with DMARC first.' });
		expect(denied).toMatchObject({ status: 'denied', note: 'Verify a domain with DMARC first.', decidedBy: 'user_admin' });
		expect(mail.at(-1)).toMatchObject({ to: 'owner@tenant.test' });
		expect(mail.at(-1)!.text).toContain('Verify a domain with DMARC first.');
		expect(core.email.orgView(owner).state).toBe('sandbox');
		await expect(core.email.decideAccessRequest(admin, pending!.id, { decision: 'approve' })).rejects.toThrow(/already denied/);
	});

	test('approval lifts the sandbox with the limits given and mails the requester', async () => {
		const again = await core.email.requestProductionAccess(owner, request);
		const approved = await core.email.decideAccessRequest(admin, again.id, { decision: 'approve', perDay: 2000, perSecond: 5 });
		expect(approved).toMatchObject({ status: 'approved', perDay: 2000, perSecond: 5 });
		expect(core.email.orgView(owner)).toMatchObject({ state: 'active', perDay: 2000, perSecond: 5 });
		expect(mail.at(-1)!.subject).toContain('approved');
		expect(mail.at(-1)!.text).toContain('2,000 messages a day');
		clock += 2000;
		const result = await core.email.send(ownerKey, { from: 'hi@tenant.test', to: ['stranger@gmail.com'], subject: 'x', text: 'x' });
		expect(result.accepted).toEqual(['stranger@gmail.com']);
		await expect(core.email.requestProductionAccess(owner, request)).rejects.toThrow(/already out of the sandbox/);
		const actions = opened.sqlite
			.query<{ action: string }, []>("SELECT action FROM audit_log WHERE action LIKE 'email.access_request.%' ORDER BY rowid")
			.all()
			.map((row) => row.action);
		expect(actions).toEqual(['email.access_request.create', 'email.access_request.deny', 'email.access_request.create', 'email.access_request.approve']);
	});

	test('moving an org out by hand answers its pending request', async () => {
		core.email.setOrgState(admin, 'org_t', { state: 'sandbox' });
		const pending = await core.email.requestProductionAccess(owner, request);
		core.email.setOrgState(admin, 'org_t', { state: 'active' });
		expect(core.email.accessRequest(owner)).toMatchObject({ id: pending.id, status: 'approved', perDay: 10_000, perSecond: 10 });
	});
});

describe('resource-scoped access', () => {
	test('a domain binding reads that domain only, not the org-wide email views', () => {
		const domain = core.email.getDomain(owner, 'tenant.test');
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_scope_sandbox', 'org_t', 'user', 'user_scope_sandbox', 'viewer', 'emailDomain', ?, 'test', 0)`,
			[domain.id],
		);
		const guest = buildPrincipal({ kind: 'user', userId: 'user_scope_sandbox', orgId: 'org_t', role: 'viewer' });
		expect(core.email.getDomain(guest, 'tenant.test').id).toBe(domain.id);
		expect(() => core.email.listDomains(guest)).toThrow(/email:read/);
		expect(() => core.email.listSandboxAddresses(guest)).toThrow(/email:read/);
		expect(() => core.email.orgView(guest)).toThrow(/email:read/);
	});
});
