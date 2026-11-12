import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { CloudflareClient, CloudflareRecord } from './domains.ts';
import { isPublicIpv4, type EmailDnsResolver } from './email.ts';
import type { Core } from './index.ts';

/**
 * The mail node's sending IPv4 (EMAIL.md §3.1). `nodes.public_address` is the WireGuard upstream
 * the edge proxies to, so the edge has none; its IP comes from the zone's platform-host record.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-email-ip-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const dns: EmailDnsResolver = {
	async resolveTxt() {
		throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
	},
	async resolveMx() {
		throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
	},
};

/** The platform host is proxied: public DNS would give Cloudflare's IPs, the zone holds the origin. */
const zone = new Map<string, CloudflareRecord>([
	['rec_0', { id: 'rec_0', type: 'A', name: 'control.yoal.test', content: '203.0.113.7' }],
]);
let seq = 0;
const cloudflare: CloudflareClient = {
	async findRecord(name) {
		return [...zone.values()].find((record) => record.name === name) ?? null;
	},
	async createRecord(input) {
		const record = { id: `rec_${++seq}`, type: input.type, name: input.name, content: input.content };
		zone.set(record.id, record);
		return record;
	},
	async updateRecord(id, input) {
		const record = { id, type: input.type, name: input.name, content: input.content };
		zone.set(id, record);
		return record;
	},
	async deleteRecord(id) {
		zone.delete(id);
	},
};

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.yoal.test',
		contentDomain: 'yoal.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		features: { ...DEFAULT_FEATURES },
	},
	email: { dns, cloudflare, cloudflareZoneName: 'yoal.test' },
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function joinMailNode(name: string, publicAddress?: string): string {
	const joined = core.nodes.join({
		token: core.nodes.createJoinToken(admin, name).token,
		name,
		...(publicAddress ? { publicAddress } : {}),
	});
	core.nodes.heartbeat(joined.token, {
		nodeId: joined.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities: ['mail'],
	});
	return joined.nodeId;
}

const aRecord = () => core.email.platformRecords().find((record) => record.type === 'A')?.value ?? null;

describe('mail node IPv4', () => {
	test('public IPv4 test', () => {
		expect(isPublicIpv4('163.172.72.185')).toBe(true);
		for (const ip of ['10.47.0.2', '192.168.0.9', '172.20.1.1', '100.100.1.1', '127.0.0.1', '169.254.1.1', '256.1.1.1', '1.2.3'])
			expect(isPublicIpv4(ip)).toBe(false);
	});

	test('an edge with no proxy address gets the origin IP from the zone\'s platform-host record', async () => {
		const edge = joinMailNode('edge');
		const settings = await core.email.configure(admin, { nodeId: edge });
		expect(settings).toMatchObject({ nodeId: edge, ip: '203.0.113.7' });
		expect(aRecord()).toBe('203.0.113.7');
	});

	test('an entered IP wins and is kept when only the pause changes', async () => {
		const edge = core.email.settings().nodeId!;
		await expect(core.email.configure(admin, { nodeId: edge, ip: '10.47.0.1' })).rejects.toThrow(/not a public IPv4/);
		await core.email.configure(admin, { nodeId: edge, ip: '198.51.100.20' });
		await core.email.configure(admin, { paused: true });
		expect(core.email.settings()).toMatchObject({ ip: '198.51.100.20', paused: true });
		await core.email.configure(admin, { nodeId: edge });
		expect(core.email.settings().ip).toBe('198.51.100.20');
	});

	test('a worker uses a public address it was given, and needs one entered otherwise', async () => {
		const routed = joinMailNode('routed', '198.51.100.30:8080');
		expect((await core.email.configure(admin, { nodeId: routed })).ip).toBe('198.51.100.30');
		const tunnelled = joinMailNode('tunnelled', '10.47.0.3:8080');
		await expect(core.email.configure(admin, { nodeId: tunnelled })).rejects.toThrow(/Couldn't find a public IPv4/);
		expect(core.email.settings().nodeId).toBe(routed);
	});

	test('turning email off clears the IP and the A records', async () => {
		await core.email.configure(admin, { nodeId: null });
		expect(core.email.settings()).toMatchObject({ nodeId: null, ip: null });
		expect(aRecord()).toBeNull();
	});
});
