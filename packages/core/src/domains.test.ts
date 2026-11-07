import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createDb, domains as domainsTable } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import {
	DOMAIN_FAIL_AFTER_MS,
	DOMAIN_RECHECK_FAILED_MS,
	DomainService,
	nextStatus,
	HttpCloudflareClient,
	cloudflareConfigFromEnv,
	type CloudflareClient,
	type CloudflareRecord,
	type CloudflareRecordInput,
	type DnsResolver,
} from './domains.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-domains-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.now();

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

const normalize = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');

class FakeDns implements DnsResolver {
	private readonly txt = new Map<string, string[][]>();
	private readonly cname = new Map<string, string[]>();
	private readonly a = new Map<string, string[]>();

	setTxt(name: string, value: string): void {
		this.txt.set(normalize(name), [[value]]);
	}

	setCname(name: string, target: string): void {
		this.cname.set(normalize(name), [target]);
	}

	setA(name: string, address: string): void {
		this.a.set(normalize(name), [address]);
	}

	async resolveTxt(name: string): Promise<string[][]> {
		const value = this.txt.get(normalize(name));
		if (!value) throw new Error('ENODATA');
		return value;
	}

	async resolveCname(name: string): Promise<string[]> {
		const value = this.cname.get(normalize(name));
		if (!value) throw new Error('ENODATA');
		return value;
	}

	async resolve4(name: string): Promise<string[]> {
		const value = this.a.get(normalize(name));
		if (!value) throw new Error('ENODATA');
		return value;
	}
}

class FakeCloudflare implements CloudflareClient {
	readonly records: CloudflareRecord[] = [];
	creates = 0;
	updates = 0;
	deletes = 0;
	failCreate = false;
	private sequence = 0;

	async findRecord(name: string): Promise<CloudflareRecord | null> {
		return this.records.find((record) => normalize(record.name) === normalize(name)) ?? null;
	}

	async createRecord(input: CloudflareRecordInput): Promise<CloudflareRecord> {
		if (this.failCreate) throw new Error('Cloudflare is down');
		this.creates += 1;
		const record: CloudflareRecord = { id: `cf_${++this.sequence}`, ...input };
		this.records.push(record);
		return record;
	}

	async updateRecord(id: string, input: CloudflareRecordInput): Promise<CloudflareRecord> {
		const index = this.records.findIndex((record) => record.id === id);
		if (index === -1) throw new Error('Record not found');
		this.updates += 1;
		const record: CloudflareRecord = { id, ...input };
		this.records[index] = record;
		return record;
	}

	async deleteRecord(id: string): Promise<void> {
		const index = this.records.findIndex((record) => record.id === id);
		if (index === -1) throw new Error('Record not found');
		this.deletes += 1;
		this.records.splice(index, 1);
	}
}

const dns = new FakeDns();
const cloudflare = new FakeCloudflare();
const service = new DomainService(core.ctx, { dns, cloudflare, cloudflareZoneName: 'example.com' });

beforeAll(async () => {
	await core.projects.create(principal, {
		name: 'Blog',
		slug: 'blog',
		runtime: 'static',
		placement: 'edge',
		productionAccess: 'public',
		previewAccess: 'platform',
	});
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('custom domains', () => {
	test('creates a pending domain, suggests TXT/CNAME and writes a Cloudflare record', async () => {
		const view = await service.create(principal, {
			project: 'blog',
			hostname: 'App.Example.COM.',
			redirectWww: false,
		});

		expect(view.hostname).toBe('app.example.com');
		expect(view.kind).toBe('custom');
		expect(view.status).toBe('pending');
		expect(view.verification?.recordName).toBe('_skiff.app.example.com');
		expect(view.verification?.recordValue).toStartWith('skiff-verify=');
		expect(view.wwwHostname).toBeNull();

		const record = cloudflare.records.find((candidate) => candidate.name === 'app.example.com');
		expect(record).toMatchObject({
			type: 'CNAME',
			content: 'blog.sites.test',
			proxied: false,
		});
		expect(service.get(principal, view.id).id).toBe(view.id);

		const audit = core.audit.list({ orgId: 'org_1' });
		expect(audit.some((entry) => entry.action === 'domain.create' && entry.result === 'ok')).toBe(true);
	});

	test('verifies through TXT, reports CNAME drift and self-heals the Cloudflare record', async () => {
		const view = await service.create(principal, {
			project: 'blog',
			hostname: 'verify.example.com',
			redirectWww: false,
		});
		const token = view.verification!.recordValue;

		const pending = await service.check(principal, view.id);
		expect(pending.domain.status).toBe('pending');
		expect(pending.detail).toContain('_skiff.verify.example.com');
		expect(pending.records.map((record) => record.type)).toEqual(['TXT', 'CNAME']);
		expect(service.approve('verify.example.com')).toBe(false);

		dns.setTxt('_skiff.verify.example.com', token);
		const drifted = await service.check(principal, view.id);
		expect(drifted.domain.status).toBe('verified');
		expect(drifted.domain.lastError).toContain('No CNAME record');
		expect(drifted.detail).toContain('Verified, but DNS needs attention');

		// Out-of-band change in Cloudflare: check puts the managed record back.
		const record = cloudflare.records.find((candidate) => candidate.name === 'verify.example.com')!;
		record.content = 'wrong.example.net';
		const updatesBefore = cloudflare.updates;
		dns.setCname('verify.example.com', 'blog.sites.test');
		const healed = await service.check(principal, view.id);
		expect(cloudflare.updates).toBeGreaterThan(updatesBefore);
		expect(cloudflare.records.find((candidate) => candidate.name === 'verify.example.com')?.content).toBe(
			'blog.sites.test',
		);
		expect(healed.domain.status).toBe('verified');
		expect(healed.domain.lastError).toBeNull();
		expect(healed.detail).toContain('Verified.');

		expect(service.approve('VERIFY.EXAMPLE.COM.')).toBe(true);
		expect(service.approve('unknown.example.com')).toBe(false);
		const project = core.projects.requireRow(principal, 'blog');
		expect(service.desiredForProjects([project.id])).toContainEqual({
			host: 'verify.example.com',
			projectId: project.id,
			kind: 'custom',
			redirectTo: null,
		});

		const removesBefore = cloudflare.deletes;
		await service.remove(principal, view.id);
		expect(cloudflare.deletes).toBeGreaterThan(removesBefore);
		expect(service.approve('verify.example.com')).toBe(false);
		expect(() => service.get(principal, view.id)).toThrow(/not found/i);
	});

	test('apex plus www creates both records, redirects www and reports the missing sibling', async () => {
		const view = await service.create(principal, {
			project: 'blog',
			hostname: 'example.com',
			redirectWww: true,
		});
		expect(view.kind).toBe('apex');
		expect(view.wwwHostname).toBe('www.example.com');

		const names = cloudflare.records
			.filter((record) => record.content === 'blog.sites.test' && record.name.endsWith('example.com'))
			.filter((record) => record.name === 'example.com' || record.name === 'www.example.com')
			.map((record) => record.name)
			.sort();
		expect(names).toEqual(['example.com', 'www.example.com']);

		dns.setTxt('_skiff.example.com', view.verification!.recordValue);
		dns.setCname('example.com', 'blog.sites.test');
		const missingWww = await service.check(principal, view.id);
		expect(missingWww.domain.status).toBe('verified');
		expect(missingWww.domain.lastError).toContain('www.example.com');
		expect(missingWww.records).toContainEqual({
			type: 'CNAME',
			name: 'www.example.com',
			value: 'blog.sites.test',
		});

		dns.setCname('www.example.com', 'blog.sites.test');
		const verified = await service.check(principal, view.id);
		expect(verified.domain.lastError).toBeNull();

		// Caddy asks before issuing the www redirect's certificate too; unrelated www hosts stay denied.
		expect(service.approve('www.example.com')).toBe(true);
		expect(service.approve('www.unknown.example.com')).toBe(false);

		// Only verified domains reach nodes, and the www sibling carries the apex redirect.
		const project = core.projects.requireRow(principal, 'blog');
		const desired = service.desiredForProjects([project.id]);
		expect(desired).toContainEqual({
			host: 'example.com',
			projectId: project.id,
			kind: 'apex',
			redirectTo: null,
		});
		expect(desired).toContainEqual({
			host: 'www.example.com',
			projectId: project.id,
			kind: 'apex',
			redirectTo: 'example.com',
		});

		await service.remove(principal, view.id);
		expect(cloudflare.records.some((record) => record.name === 'example.com')).toBe(false);
		expect(cloudflare.records.some((record) => record.name === 'www.example.com')).toBe(false);
	});

	test('rejects hosts on the platform or content domain before touching DNS', async () => {
		for (const hostname of ['control.test', 'foo.control.test', 'sites.test', 'evil.sites.test'])
			await expect(
				service.create(principal, { project: 'blog', hostname, redirectWww: false }),
			).rejects.toMatchObject({ code: 'validation' });

		await expect(
			service.create(principal, { project: 'blog', hostname: 'not a host', redirectWww: false }),
		).rejects.toMatchObject({ code: 'validation' });
	});

	test('rejects a duplicate hostname', async () => {
		await expect(
			service.create(principal, { project: 'blog', hostname: 'app.example.com', redirectWww: false }),
		).rejects.toMatchObject({ code: 'conflict' });
	});

	test('a Cloudflare outage leaves the domain pending instead of failing the attach', async () => {
		cloudflare.failCreate = true;
		const view = await service.create(principal, {
			project: 'blog',
			hostname: 'flaky.example.com',
			redirectWww: false,
		});
		cloudflare.failCreate = false;
		expect(view.status).toBe('pending');
		expect(view.lastError).toContain('Cloudflare');
	});

	test('the Cloudflare client stays grey-cloud, scoped and network-injectable', async () => {
		expect(cloudflareConfigFromEnv({ SKIFF_CLOUDFLARE_API_TOKEN: 'token-only' })).toBeNull();
		expect(
			cloudflareConfigFromEnv({
				SKIFF_CLOUDFLARE_API_TOKEN: 'token',
				SKIFF_CLOUDFLARE_ZONE_ID: 'zone_1',
			}),
		).toEqual({ apiToken: 'token', zoneId: 'zone_1', zoneName: undefined });

		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
			calls.push({ url, init });
			const envelope = (result: unknown) =>
				new Response(JSON.stringify({ success: true, result }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			if (url.endsWith('/zones?name=example.com')) return envelope([{ id: 'zone_1', name: 'example.com' }]);
			if (url.includes('/dns_records?name=')) return envelope([]);
			if (url.endsWith('/zones/zone_1/dns_records'))
				return envelope({
					id: 'record_1',
					type: 'CNAME',
					name: 'app.example.com',
					content: 'blog.sites.test',
					proxied: false,
				});
			return new Response('{}', { status: 404 });
		};
		const client = new HttpCloudflareClient(
			{ apiToken: 'secret-token', zoneName: 'example.com' },
			fetchImpl,
		);

		expect(await client.findRecord('app.example.com')).toBeNull();
		const created = await client.createRecord({
			type: 'CNAME',
			name: 'app.example.com',
			content: 'blog.sites.test',
			proxied: false,
			ttl: 1,
			comment: 'Managed by Skiff',
		});
		expect(created.id).toBe('record_1');
		expect(calls[0]!.url).toBe('https://api.cloudflare.com/client/v4/zones?name=example.com');
		for (const call of calls) {
			expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
			expect(JSON.stringify(call)).not.toContain('skiff-verify');
		}
		const createCall = calls.at(-1)!;
		expect(createCall.init?.method).toBe('POST');
		expect(JSON.parse(String(createCall.init?.body))).toMatchObject({
			type: 'CNAME',
			name: 'app.example.com',
			content: 'blog.sites.test',
			proxied: false,
			ttl: 1,
		});
	});

	test('updates an existing address record on attach but never replaces a TXT record', async () => {
		cloudflare.records.push({
			id: 'cf_legacy',
			type: 'CNAME',
			name: 'legacy.example.com',
			content: 'old.example.net',
			proxied: false,
		});
		const adopted = await service.create(principal, {
			project: 'blog',
			hostname: 'legacy.example.com',
			redirectWww: false,
		});
		expect(adopted.lastError).toBeNull();
		expect(
			cloudflare.records.find((record) => record.name === 'legacy.example.com')?.content,
		).toBe('blog.sites.test');

		cloudflare.records.push({
			id: 'cf_txt',
			type: 'TXT',
			name: 'txt.example.com',
			content: 'v=spf1 -all',
			proxied: false,
		});
		const conflict = await service.create(principal, {
			project: 'blog',
			hostname: 'txt.example.com',
			redirectWww: false,
		});
		expect(conflict.lastError).toContain('TXT');
		expect(cloudflare.records.find((record) => record.name === 'txt.example.com')?.content).toBe('v=spf1 -all');
	});

	test('a domain outside the configured Cloudflare zone never gets automatic records', async () => {
		const before = cloudflare.records.length;
		const view = await service.create(principal, {
			project: 'blog',
			hostname: 'outside.example.net',
			redirectWww: false,
		});
		expect(view.status).toBe('pending');
		expect(cloudflare.records.length).toBe(before);
	});
});

describe('domain status lifecycle', () => {
	const HOUR = 3_600_000;
	const statusOf = (id: string) => service.get(principal, id).status;

	test('a verified domain goes active once an edge reports its certificate, and back if it expires', async () => {
		const view = await service.create(principal, { project: 'blog', hostname: 'live.example.com', redirectWww: false });
		const project = core.projects.requireRow(principal, 'blog');

		// A certificate report for a pending domain changes nothing: it is not routed yet.
		service.applyServedCertificates([{ host: 'live.example.com', notAfter: new Date(clock + 60 * 86_400_000).toISOString() }]);
		expect(statusOf(view.id)).toBe('pending');

		dns.setTxt('_skiff.live.example.com', view.verification!.recordValue);
		dns.setCname('live.example.com', 'blog.sites.test');
		expect((await service.check(principal, view.id)).domain.status).toBe('verified');

		// The content wildcard and unrelated hosts are ignored; the domain's own certificate activates it.
		service.applyServedCertificates([
			{ host: '*.sites.test', notAfter: new Date(clock + 60 * 86_400_000).toISOString() },
			{ host: 'live.example.com', notAfter: new Date(clock + 60 * 86_400_000).toISOString() },
		]);
		expect(statusOf(view.id)).toBe('active');
		expect(service.approve('live.example.com')).toBe(true);
		expect(service.desiredForProjects([project.id]).map((entry) => entry.host)).toContain('live.example.com');

		// A re-check keeps it active.
		const recheck = await service.check(principal, view.id);
		expect(recheck.domain.status).toBe('active');
		expect(recheck.detail).toContain('serving over HTTPS');
		expect(core.audit.list({ orgId: 'org_1', action: 'domain.status' }).some((entry) => entry.resourceId === view.id)).toBe(true);

		// Its certificate expired and no node reports a current one: back to verified, still routed.
		service.applyServedCertificates([{ host: 'live.example.com', notAfter: new Date(clock - 1000).toISOString() }]);
		const demoted = service.get(principal, view.id);
		expect(demoted.status).toBe('verified');
		expect(demoted.lastError).toContain('expired');
		expect(service.approve('live.example.com')).toBe(true);

		// A renewed certificate activates it again and clears the note.
		service.applyServedCertificates([{ host: 'LIVE.example.com.', notAfter: new Date(clock + 90 * 86_400_000).toISOString() }]);
		expect(service.get(principal, view.id)).toMatchObject({ status: 'active', lastError: null });
		await service.remove(principal, view.id);
	});

	test('the agent heartbeat carries the certificate signal', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge-domains' });
		const view = await core.domains.create(principal, { project: 'blog', hostname: 'beat.example.com', redirectWww: false });
		core.ctx.db.update(domainsTable).set({ status: 'verified', verifiedAt: clock }).where(eq(domainsTable.id, view.id)).run();
		core.nodes.heartbeat(joined.token, {
			nodeId: joined.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			stats: { certs: [{ host: 'beat.example.com', notAfter: new Date(clock + 30 * 86_400_000).toISOString() }] },
		});
		expect(core.domains.get(principal, view.id).status).toBe('active');

		// Another node reporting an expired copy does not demote it while this one serves a current one.
		core.domains.applyServedCertificates([{ host: 'beat.example.com', notAfter: new Date(clock - 1000).toISOString() }]);
		expect(core.domains.get(principal, view.id).status).toBe('active');
		core.ctx.db.delete(domainsTable).where(eq(domainsTable.id, view.id)).run();
	});

	test('a domain that never verifies fails after the window, keeps being re-checked and recovers', async () => {
		const view = await service.create(principal, { project: 'blog', hostname: 'late.example.com', redirectWww: false });
		const lastChecked = () => service.get(principal, view.id).lastCheckedAt;

		// The sweep checks a never-checked pending domain straight away, then every 10 minutes.
		await service.recheckDue();
		const first = lastChecked();
		expect(first).not.toBeNull();
		expect(statusOf(view.id)).toBe('pending');
		clock += 5 * 60_000;
		await service.recheckDue();
		expect(lastChecked()).toBe(first);
		clock += 6 * 60_000;
		await service.recheckDue();
		expect(lastChecked()).not.toBe(first);

		// Past the window, a failing check marks it failed; it is not served.
		clock += DOMAIN_FAIL_AFTER_MS;
		await service.recheckDue();
		const failed = service.get(principal, view.id);
		expect(failed.status).toBe('failed');
		expect(failed.lastError).toContain('has not verified within 72 hours');
		expect(service.approve('late.example.com')).toBe(false);
		const project = core.projects.requireRow(principal, 'blog');
		expect(service.desiredForProjects([project.id]).map((entry) => entry.host)).not.toContain('late.example.com');

		// Failed domains are re-checked every 6 hours; a manual check still works any time.
		const failedAt = lastChecked();
		clock += HOUR;
		await service.recheckDue();
		expect(lastChecked()).toBe(failedAt);
		dns.setTxt('_skiff.late.example.com', view.verification!.recordValue);
		clock += DOMAIN_RECHECK_FAILED_MS;
		await service.recheckDue();
		const recovered = service.get(principal, view.id);
		expect(recovered.status).toBe('verified');
		expect(recovered.verifiedAt).not.toBeNull();
		expect(service.approve('late.example.com')).toBe(true);

		// Once verified it never fails on a later missing TXT record (it may be removed after verifying).
		dns.setTxt('_skiff.late.example.com', 'something-else');
		clock += DOMAIN_FAIL_AFTER_MS;
		const later = await service.check(principal, view.id);
		expect(later.domain.status).toBe('verified');
		expect(later.domain.lastError).toContain('does not contain');
	});

	test('nextStatus covers every transition', () => {
		const base = { verifiedAt: null, createdAt: 0 };
		expect(nextStatus({ ...base, status: 'pending' }, true, 1)).toBe('verified');
		expect(nextStatus({ ...base, status: 'failed' }, true, DOMAIN_FAIL_AFTER_MS * 2)).toBe('verified');
		expect(nextStatus({ ...base, status: 'pending' }, false, DOMAIN_FAIL_AFTER_MS - 1)).toBe('pending');
		expect(nextStatus({ ...base, status: 'pending' }, false, DOMAIN_FAIL_AFTER_MS)).toBe('failed');
		expect(nextStatus({ status: 'active', verifiedAt: 1, createdAt: 0 }, true, 2)).toBe('active');
		expect(nextStatus({ status: 'active', verifiedAt: 1, createdAt: 0 }, false, DOMAIN_FAIL_AFTER_MS * 2)).toBe('active');
		expect(nextStatus({ status: 'verified', verifiedAt: 1, createdAt: 0 }, false, DOMAIN_FAIL_AFTER_MS * 2)).toBe('verified');
	});
});
