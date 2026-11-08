import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES, mailStateSchema, type EmailEvent } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { CloudflareClient, CloudflareRecord, CloudflareRecordInput } from './domains.ts';
import type { EmailDnsResolver } from './email.ts';
import type { Core } from './index.ts';
import { verifyPassword } from './util.ts';

/** Email (docs/EMAIL.md): domains, sending, the mail node bridge, suppression and reputation. */

const dir = mkdtempSync(join(tmpdir(), 'skiff-email-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-07T10:00:00Z');

/** Public DNS as the tests set it. */
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

/** A Cloudflare zone that publishes straight into the fake DNS. */
const zone = new Map<string, CloudflareRecord>();
let recordSeq = 0;
const cloudflare: CloudflareClient = {
	async findRecord(name) {
		return [...zone.values()].find((record) => record.name === name) ?? null;
	},
	async createRecord(input: CloudflareRecordInput) {
		const record = { id: `rec_${++recordSeq}`, type: input.type, name: input.name, content: input.content };
		zone.set(record.id, record);
		if (input.type === 'TXT') txt.set(input.name, [...(txt.get(input.name) ?? []), input.content]);
		return record;
	},
	async updateRecord(id, input) {
		const record = { id, type: input.type, name: input.name, content: input.content };
		zone.set(id, record);
		return record;
	},
	async deleteRecord(id) {
		const record = zone.get(id);
		zone.delete(id);
		if (record?.type === 'TXT') txt.set(record.name, (txt.get(record.name) ?? []).filter((value) => value !== record.content));
	},
};

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.skiff.test',
		contentDomain: 'skiff.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		features: { ...DEFAULT_FEATURES },
	},
	email: { dns, cloudflare, cloudflareZoneName: 'skiff.test' },
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const tenant = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_2', role: 'owner' });
const tenantKey = buildPrincipal({ kind: 'apiKey', userId: 'user_2', orgId: 'org_2', role: 'owner' });
const agent = buildPrincipal({ kind: 'mcp', userId: 'user_2', orgId: 'org_2', role: 'owner', clientId: 'c1' });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_3', orgId: 'org_2', role: 'viewer' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

let nodeId = '';
let nodeToken = '';

function event(patch: Partial<EmailEvent> & Pick<EmailEvent, 'kind' | 'messageId' | 'orgId'>): EmailEvent {
	return {
		seq: 0,
		projectId: null,
		recipient: null,
		recipientIndex: null,
		at: new Date(clock).toISOString(),
		attempt: 1,
		severity: null,
		bounceClass: null,
		remoteHost: null,
		response: null,
		tls: null,
		source: 'api',
		feedbackType: null,
		tags: {},
		from: null,
		subject: null,
		...patch,
	};
}

describe('mail node', () => {
	test('a node must advertise mail before it can be the mail node', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(admin, 'edge').token, name: 'edge', publicAddress: '203.0.113.10' });
		nodeId = joined.nodeId;
		nodeToken = joined.token;
		core.nodes.heartbeat(nodeToken, { nodeId, agentVersion: '0.1.0', actualStateVersion: 1, status: 'online', caddyOk: true, releases: [], capabilities: ['functions'] });
		await expect(core.email.send(tenantKey, { from: 'a@example.com', to: ['b@example.com'], text: 'x' })).rejects.toThrow(/not set up/);
		await expect(core.email.configure(admin, { nodeId })).rejects.toThrow(/without mail support/);
		core.nodes.heartbeat(nodeToken, { nodeId, agentVersion: '0.1.0', actualStateVersion: 1, status: 'online', caddyOk: true, releases: [], capabilities: ['functions', 'mail'] });
		await expect(core.email.configure(tenant, { nodeId })).rejects.toThrow(/platform admin/);
		const settings = await core.email.configure(admin, { nodeId });
		expect(settings).toMatchObject({ nodeId, mailDomain: 'skiff.test', hostnames: { helo: 'mx1.skiff.test', bounce: 'bounces.skiff.test' } });
	});

	test('platform records are published to Cloudflare', () => {
		const published = [...zone.values()].map((record) => `${record.type} ${record.name} ${record.content}`);
		expect(published).toContain('A mx1.skiff.test 203.0.113.10');
		expect(published).toContain('TXT _spf.skiff.test v=spf1 ip4:203.0.113.10 -all');
		expect(published).toContain('MX bounces.skiff.test mx.skiff.test');
		expect(published).toContain('TXT bounces.skiff.test v=spf1 include:_spf.skiff.test -all');
	});

	test('desired state carries the mail section only for the mail node, without secrets', async () => {
		const state = await core.nodes.desiredState(nodeToken);
		expect(state.mail).toMatchObject({ hostnames: { mx: 'mx.skiff.test' } });
		expect(JSON.stringify(state.mail)).not.toContain('PRIVATE KEY');
		expect(core.email.desiredForNode('node_other')).toBeNull();
		expect(() => core.email.stateForNode('node_other')).toThrow(/not the mail node/);
	});

	test('the mail domain follows the content domain unless a custom one is set', async () => {
		expect(core.email.settings()).toMatchObject({ mailDomain: 'skiff.test', mailDomainSource: 'content', contentDomain: 'skiff.test' });
		const before = core.email.settings().generation;
		const custom = await core.email.configure(admin, { mailDomain: 'https://Mail.Skiff.test/' });
		expect(custom).toMatchObject({ mailDomain: 'mail.skiff.test', mailDomainSource: 'custom', hostnames: { helo: 'mx1.mail.skiff.test', submission: 'smtp.mail.skiff.test' } });
		expect(custom.generation).toBe(before + 1);
		expect((await core.nodes.desiredState(nodeToken)).mail).toMatchObject({ hostnames: { mx: 'mx.mail.skiff.test' } });
		expect([...zone.values()].map((record) => `${record.type} ${record.name} ${record.content}`)).toContain('A mx1.mail.skiff.test 203.0.113.10');
		await expect(core.email.configure(admin, { mailDomain: 'not a domain' })).rejects.toThrow(/not a domain name/);
		await expect(core.email.configure(tenant, { mailDomain: 'mail.example.com' })).rejects.toThrow(/platform admin/);
		// Naming the content domain is the default, not a custom setting.
		expect(await core.email.configure(admin, { mailDomain: 'skiff.test' })).toMatchObject({ mailDomain: 'skiff.test', mailDomainSource: 'content' });
		await core.email.configure(admin, { mailDomain: 'mail.skiff.test' });
		expect(await core.email.configure(admin, { mailDomain: null })).toMatchObject({ mailDomain: 'skiff.test', mailDomainSource: 'content' });
	});
});

describe('domains', () => {
	test('a domain outside the zone shows its records and verifies once DKIM resolves', async () => {
		const domain = await core.email.createDomain(tenant, { name: 'Example.com' });
		expect(domain).toMatchObject({ name: 'example.com', status: 'pending', sending: true });
		const dkim = domain.records.find((record) => record.purpose === 'dkim')!;
		expect(dkim.name).toBe('skf202611._domainkey.example.com');
		expect(dkim.value).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]{300,}$/);
		expect(dkim.ok).toBe(false);
		expect(domain.records.find((record) => record.purpose === 'spf')!.value).toBe('v=spf1 include:_spf.skiff.test ~all');

		txt.set(dkim.name, [dkim.value]);
		txt.set('example.com', ['v=spf1 include:_spf.google.com -all']);
		const checked = await core.email.checkDomain(tenant, 'example.com');
		expect(checked.status).toBe('verified');
		const spf = checked.records.find((record) => record.purpose === 'spf')!;
		expect(spf.ok).toBe(false);
		expect(spf.note).toContain('v=spf1 include:_spf.google.com include:_spf.skiff.test -all');
	});

	test('a domain in the platform zone gets its records created through Cloudflare', async () => {
		const domain = await core.email.createDomain(admin, { name: 'app.skiff.test' });
		expect(domain.status).toBe('verified');
		expect(domain.records.find((record) => record.purpose === 'dkim')!.managed).toBe(true);
		expect(txt.get('_dmarc.app.skiff.test')).toEqual(['v=DMARC1; p=none; rua=mailto:dmarc@app.skiff.test']);
	});

	test('"set up for me" writes the records of a domain added without them', async () => {
		const added = await core.email.createDomain(admin, { name: 'later.skiff.test', autoDns: false });
		expect(added.status).toBe('pending');
		expect(core.email.managesDns('later.skiff.test')).toBe(true);
		const { domain, written } = await core.email.publishDomain(admin, 'later.skiff.test');
		expect(written).toEqual(['dkim', 'spf', 'dmarc']);
		expect(domain.status).toBe('verified');
		expect((await core.email.publishDomain(admin, 'later.skiff.test')).written).toEqual([]);
		expect(core.email.managesDns('example.com')).toBe(false);
		await expect(core.email.publishDomain(tenant, 'example.com')).rejects.toThrow(/Cloudflare zone/);
		await expect(core.email.publishDomain(viewer, 'example.com')).rejects.toThrow();
	});

	test('one org per domain; the platform names are reserved; viewers cannot add domains', async () => {
		await expect(core.email.createDomain(admin, { name: 'example.com' })).rejects.toThrow(/another organisation/);
		await expect(core.email.createDomain(admin, { name: 'bounces.skiff.test' })).rejects.toThrow(/platform/);
		await expect(core.email.createDomain(viewer, { name: 'other.com' })).rejects.toThrow();
	});

	test('a verified domain that loses its record pauses after the grace period', async () => {
		const name = 'skf202611._domainkey.example.com';
		const saved = txt.get(name)!;
		txt.delete(name);
		expect((await core.email.checkDomain(tenant, 'example.com')).status).toBe('verified');
		clock += 73 * 3_600_000;
		expect((await core.email.checkDomain(tenant, 'example.com')).status).toBe('failed');
		txt.set(name, saved);
		expect((await core.email.checkDomain(tenant, 'example.com')).status).toBe('verified');
	});
});

describe('sending', () => {
	test('reading the org view never creates it; batches fail per message', async () => {
		expect(core.email.orgView(admin)).toMatchObject({ state: 'active' });
		const results = await core.email.sendBatch(tenantKey, { messages: [{ from: 'hi@example.com', to: ['team@example.com'], text: 'x' }, { from: 'nope' }] });
		expect(results[0]).toHaveProperty('id');
		expect(results[1]).toMatchObject({ error: { code: 'validation_failed' } });
		expect(() => core.email.setOrgState(admin, 'org_2', { state: 'bogus' as never })).toThrow();
	});

	test('an org starts in the sandbox: own domain only', async () => {
		clock += 2000;
		expect(core.email.orgView(tenant)).toMatchObject({ state: 'sandbox', perDay: 200, perSecond: 1 });
		await expect(core.email.send(tenantKey, { from: 'hi@example.com', to: ['stranger@gmail.com'], subject: 'x', text: 'x' })).rejects.toThrow(/sandbox/);
		const result = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['team@example.com'], subject: 'Hello', text: 'Hi there' });
		expect(result.id).toMatch(/^em_[0-9a-f]{32}$/);
		expect(result.accepted).toEqual(['team@example.com']);
	});

	test('a platform admin moves the org out of the sandbox', () => {
		expect(() => core.email.setOrgState(tenant, 'org_2', { state: 'active' })).toThrow(/platform admin/);
		expect(core.email.setOrgState(admin, 'org_2', { state: 'active' })).toMatchObject({ state: 'active', perDay: 10_000, perSecond: 10 });
	});

	test('the outbox carries rendered MIME with no Bcc header; an unverified From is refused', async () => {
		clock += 2000;
		const result = await core.email.send(tenantKey, {
			from: { name: 'Example', address: 'hi@example.com' },
			to: ['a@gmail.com'],
			bcc: ['secret@gmail.com'],
			subject: 'Welcome',
			html: '<p>Hi</p>',
			tags: { kind: 'welcome' },
			unsubscribe: { url: 'https://example.com/u/1', oneClick: true },
		});
		expect(result.accepted).toEqual(['a@gmail.com', 'secret@gmail.com']);
		const claimed = core.email.claimOutbox(nodeId).find((item) => item.messageId === result.id)!;
		const mime = Buffer.from(claimed.raw, 'base64').toString('utf8');
		expect(mime).toMatch(/^From: Example <hi@example\.com>/m);
		expect(mime).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
		expect(mime).toContain(`Message-ID: <${result.id}@example.com>`);
		expect(mime).not.toMatch(/^Bcc:/im);
		expect(claimed.tags).toEqual({ kind: 'welcome' });
		await expect(core.email.send(tenantKey, { from: 'hi@unverified.com', to: ['a@gmail.com'], text: 'x' })).rejects.toThrow(/not a verified sending domain/);
	});

	test('idempotency keys return the first message', async () => {
		clock += 2000;
		const first = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['b@gmail.com'], text: 'x', idempotencyKey: 'order-42' });
		const second = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['b@gmail.com'], text: 'x', idempotencyKey: 'order-42' });
		expect(second.id).toBe(first.id);
	});

	test('claims time out and acks remove rows', () => {
		// Only the idempotent send is still unclaimed; the rest were claimed a moment ago.
		expect(core.email.claimOutbox(nodeId).map((item) => item.messageId)).toHaveLength(1);
		expect(core.email.claimOutbox(nodeId)).toEqual([]);
		clock += 61_000;
		const reclaimed = core.email.claimOutbox(nodeId);
		expect(reclaimed.length).toBeGreaterThanOrEqual(3);
		expect(core.email.ackOutbox(nodeId, reclaimed.map((item) => item.messageId))).toBe(reclaimed.length);
		clock += 61_000;
		expect(core.email.claimOutbox(nodeId)).toEqual([]);
	});
});

describe('the mail node state', () => {
	test('carries verified domains with opened keys, credential hashes and org policy', () => {
		const state = mailStateSchema.parse(core.email.stateForNode(nodeId));
		const example = state.domains.find((domain) => domain.name === 'example.com')!;
		expect(example.dkim[0]!.privateKey).toContain('BEGIN PRIVATE KEY');
		expect(state.orgs.find((org) => org.orgId === 'org_2')).toMatchObject({ state: 'active', perDay: 10_000 });
	});

	test('credentials: shown once, hashed for the node, never created by an agent', () => {
		expect(() => core.email.createCredential(agent, { name: 'ci' })).toThrow(/person/);
		expect(() => core.email.createCredential(tenantKey, { name: 'ci' })).toThrow(/person/);
		const created = core.email.createCredential(tenant, { name: 'ci', allowedFromDomains: ['example.com'] });
		expect(created.username).toMatch(/^skf_[0-9a-f]{32}$/);
		expect(created.smtp).toEqual({ host: 'smtp.skiff.test', port: 587, secure: 'starttls' });
		const node = core.email.stateForNode(nodeId).credentials.find((entry) => entry.username === created.username)!;
		expect(verifyPassword(created.password, node.hash)).toBe(true);
		expect(node.allowedFromDomains).toEqual(['example.com']);
		core.email.revokeCredential(tenant, created.id);
		expect(core.email.stateForNode(nodeId).credentials.some((entry) => entry.username === created.username)).toBe(false);
	});

	test('attaching a project injects SMTP_* at activation', async () => {
		const project = await core.projects.create(tenant, { slug: 'shop', name: 'Shop', runtime: 'process' } as never);
		const row = core.projects.requireRow(tenant, project.slug);
		expect(core.email.attach(tenant, row)).toEqual({ envPrefix: 'SMTP', envNames: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_URL'] });
		const env = core.email.consumerEnv(row.id);
		expect(env.SMTP_HOST).toBe('smtp.skiff.test');
		expect(env.SMTP_URL).toMatch(/^smtp:\/\/skf_[0-9a-f]+:[^@]+@smtp\.skiff\.test:587$/);
		expect(() => core.email.attach(tenant, row)).toThrow(/already has/);
		core.email.detach(tenant, row);
		expect(core.email.consumerEnv(row.id)).toEqual({});
	});
});

describe('events', () => {
	test('delivery events update the message log', async () => {
		clock += 1000;
		const sent = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['c@gmail.com'], text: 'x' });
		await core.email.ingestEvents(nodeId, [
			event({ kind: 'accepted', messageId: sent.id, orgId: 'org_2', recipient: 'c@gmail.com', recipientIndex: 0 }),
			event({ kind: 'deferred', messageId: sent.id, orgId: 'org_2', recipient: 'c@gmail.com', recipientIndex: 0, response: '451 later' }),
		]);
		expect(core.email.getMessage(tenant, sent.id)).toMatchObject({ status: 'deferred', recipients: [{ status: 'deferred', lastResponse: '451 later' }] });
		await core.email.ingestEvents(nodeId, [event({ kind: 'delivered', messageId: sent.id, orgId: 'org_2', recipient: 'c@gmail.com', recipientIndex: 0, response: '250 OK' })]);
		expect(core.email.getMessage(tenant, sent.id).status).toBe('delivered');
		await expect(core.email.ingestEvents('node_other', [])).rejects.toThrow(/not the mail node/);
	});

	test('SMTP-submitted mail enters the log through its accepted event', async () => {
		const id = 'em_0123456789abcdef0123456789abcdef';
		await core.email.ingestEvents(nodeId, [
			event({ kind: 'accepted', messageId: id, orgId: 'org_2', recipient: 'd@gmail.com', recipientIndex: 0, source: 'smtp', from: 'hi@example.com', subject: 'From SMTP' }),
		]);
		expect(core.email.getMessage(tenant, id)).toMatchObject({ source: 'smtp', from: 'hi@example.com', subject: 'From SMTP', status: 'accepted' });
	});

	test('a hard bounce suppresses the address and later sends drop it', async () => {
		const sent = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['gone@gmail.com'], text: 'x' });
		await core.email.ingestEvents(nodeId, [
			event({ kind: 'bounced', messageId: sent.id, orgId: 'org_2', recipient: 'gone@gmail.com', recipientIndex: 0, severity: 'hard', bounceClass: 'invalid-recipient', response: '550 5.1.1 no such user' }),
		]);
		expect(core.email.listSuppressions(tenant)).toMatchObject([{ address: 'gone@gmail.com', reason: 'bounce', messageId: sent.id }]);
		expect(core.email.stateForNode(nodeId).orgs.find((org) => org.orgId === 'org_2')!.suppressed).toContain('gone@gmail.com');
		clock += 2000;
		await expect(core.email.send(tenantKey, { from: 'hi@example.com', to: ['Gone@gmail.com'], text: 'x' })).rejects.toThrow(/suppression list/);
		clock += 2000;
		const mixed = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['gone@gmail.com', 'e@gmail.com'], text: 'x' });
		expect(mixed).toMatchObject({ accepted: ['e@gmail.com'], suppressed: ['gone@gmail.com'] });
		core.email.removeSuppression(tenant, 'gone@gmail.com');
		expect(core.email.listSuppressions(tenant)).toEqual([]);
	});

	test('a complaint suppresses too', async () => {
		clock += 2000;
		const sent = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['angry@gmail.com'], text: 'x' });
		await core.email.ingestEvents(nodeId, [event({ kind: 'complained', messageId: sent.id, orgId: 'org_2', recipient: 'angry@gmail.com', recipientIndex: 0, feedbackType: 'abuse' })]);
		expect(core.email.listSuppressions(tenant, { address: 'angry@gmail.com' })[0]?.reason).toBe('complaint');
		expect(core.email.getMessage(tenant, sent.id).status).toBe('complained');
	});

	test('a bounce rate over 8% pauses the org on every path', async () => {
		// 240 accepted recipients in the window, 24 hard bounces (10%).
		const now = clock;
		for (let i = 0; i < 240; i++) {
			opened.sqlite.run(
				"INSERT INTO email_recipients (message_id, idx, org_id, address, status, hard_bounced, created_at, updated_at) VALUES (?, 0, 'org_2', ?, ?, ?, ?, ?)",
				[`em_bulk${String(i).padStart(24, '0')}`, `bulk${i}@gmail.com`, i < 23 ? 'bounced' : 'delivered', i < 23 ? 1 : 0, now, now],
			);
		}
		const sent = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['last@gmail.com'], text: 'x' });
		await core.email.ingestEvents(nodeId, [event({ kind: 'bounced', messageId: sent.id, orgId: 'org_2', recipient: 'last@gmail.com', recipientIndex: 0, severity: 'hard', bounceClass: 'invalid-recipient' })]);
		const view = core.email.orgView(tenant);
		expect(view.state).toBe('paused');
		expect(view.pausedReason).toMatch(/^Hard-bounce rate \d+\.\d% over the last \d+ messages \(limit 8%\)\.$/);
		expect(core.email.stateForNode(nodeId).orgs.find((org) => org.orgId === 'org_2')!.state).toBe('paused');
		clock += 2000;
		await expect(core.email.send(tenantKey, { from: 'hi@example.com', to: ['x@gmail.com'], text: 'x' })).rejects.toThrow(/paused/);
		core.email.setOrgState(admin, 'org_2', { state: 'active' });
	});
});

describe('maintenance', () => {
	test('stale outbox rows fail and old messages are trimmed', async () => {
		clock += 2000;
		const sent = await core.email.send(tenantKey, { from: 'hi@example.com', to: ['late@gmail.com'], text: 'x' });
		clock += 25 * 3_600_000;
		const { expired } = await core.email.sweep();
		// Every unacknowledged send from the earlier tests expires too.
		expect(expired).toBeGreaterThanOrEqual(1);
		expect(core.email.getMessage(tenant, sent.id).status).toBe('rejected');
		clock += 31 * 86_400_000;
		const { trimmed } = await core.email.sweep();
		expect(trimmed).toBeGreaterThan(0);
		expect(() => core.email.getMessage(tenant, sent.id)).toThrow(/not found/);
	});
});

describe('resource-scoped access', () => {
	test('an emailDomain binding covers only that domain, not the org-wide list', async () => {
		const visible = await core.email.createDomain(tenant, { name: 'scoped-visible.test', autoDns: false });
		const hidden = await core.email.createDomain(tenant, { name: 'scoped-hidden.test', autoDns: false });
		opened.sqlite.run(
			`INSERT INTO iam_bindings
			   (id, org_id, principal_type, principal_id, role_id, scope_type, scope_id, created_by, created_at)
			 VALUES ('bind_scope_email', 'org_2', 'user', 'user_scope_email', 'owner', 'emailDomain', ?, 'test', 0)`,
			[visible.id],
		);
		const guest = buildPrincipal({ kind: 'user', userId: 'user_scope_email', orgId: 'org_2', role: 'viewer' });
		expect(core.email.getDomain(guest, 'scoped-visible.test').id).toBe(visible.id);
		expect(core.email.updateDomain(guest, 'scoped-visible.test', { sending: false }).sending).toBe(false);
		expect(() => core.email.getDomain(guest, 'scoped-hidden.test')).toThrow(/email:read/);
		expect(() => core.email.updateDomain(guest, 'scoped-hidden.test', { sending: false })).toThrow(/email:update/);
		await expect(core.email.deleteDomain(guest, 'scoped-hidden.test')).rejects.toThrow(/email:delete/);
		// Listing every domain is an org-wide read, not one covered by a single-domain binding.
		expect(() => core.email.listDomains(guest)).toThrow(/email:read/);
	});
});
