import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import {
	DEFAULT_FEATURES,
	nodeCapabilities,
	storageGatewayHost,
	storagePolicyName,
} from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-storage-sts-'));
const opened = createDb({ path: ':memory:' });
let clock = Date.parse('2026-11-09T10:00:00Z');

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		storageGatewayUrl: 'http://gateway.test',
		features: { ...DEFAULT_FEATURES, ORG_NETWORKS: false, SERVICE_ENDPOINTS: false },
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

let edgeToken = '';
let edgeId = '';
let workloadId = '';
let storageId = '';
let attachmentKeyId = '';

const requests: Array<{ url: string; body: string; host: string | null }> = [];
let stsFails = false;
const realFetch = globalThis.fetch;

function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const body = typeof init?.body === 'string' ? init.body : '';
	requests.push({
		url: String(input),
		body,
		host: new Headers(init?.headers).get('host'),
	});
	if (stsFails)
		return Promise.resolve(
			new Response(
				'<?xml version="1.0" encoding="UTF-8"?><ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>no policies are available for this OIDC token</Message></Error></ErrorResponse>',
				{ status: 403 },
			),
		);
	const expiration = new Date(clock + 3_600_000).toISOString();
	return Promise.resolve(
		new Response(
			`<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>STSKEY</AccessKeyId>
      <SecretAccessKey>STSSECRET</SecretAccessKey>
      <SessionToken>STSTOKEN</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
    <SubjectFromWebIdentityToken>subject</SubjectFromWebIdentityToken>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`,
			{ status: 200, headers: { 'content-type': 'application/xml' } },
		),
	);
}

function heartbeat(capabilities: string[]): void {
	core.nodes.heartbeat(edgeToken, {
		nodeId: edgeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		releases: [],
		capabilities,
	});
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('storage STS for workloads', () => {
	test('setup', async () => {
		const edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		edgeToken = edge.token;
		edgeId = edge.nodeId;
		heartbeat([...nodeCapabilities]);

		await core.projects.create(owner, {
			name: 'app',
			slug: 'app',
			runtime: 'process',
			placement: edgeId,
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		await core.uploads.deployInline(
			owner,
			core.projects.requireRow(owner, 'app'),
			[file('index.js', 'x'), file('package.json', '{}')],
			{ promote: true },
		);
		const storage = core.storage.create(owner, { name: 'media', placement: edgeId, buckets: ['uploads', 'avatars'] });
		storageId = storage.id;
		const attached = core.storage.attach(owner, core.projects.requireRow(owner, 'app'), {
			storage: 'media',
			grants: [{ bucket: 'uploads' }],
		});
		attachmentKeyId = attached.attachment.accessKeyId;
		const state = await core.nodes.desiredState(edgeToken);
		workloadId = state.workloads.find((workload) => workload.projectSlug === 'app')!.id;
		const media = state.workloads.find((workload) => workload.projectSlug === 'media')!;
		expect(media.env).toMatchObject({
			RUSTFS_IDENTITY_OPENID_ENABLE: 'on',
			RUSTFS_IDENTITY_OPENID_CONFIG_URL: 'https://control.test/.well-known/openid-configuration',
			RUSTFS_IDENTITY_OPENID_ISSUER: 'https://control.test',
			RUSTFS_IDENTITY_OPENID_CLIENT_ID: 'yoal',
		});

		expect(storage.capabilities.sts).toBe(true);
		expect(storage.sts).toMatchObject({
			enabled: true,
			issuer: 'https://control.test',
			audience: 'yoal',
			claim: 'groups',
			rolePolicy: null,
		});
	});

	test('issues a scoped token, sends the STS form and caches until five minutes before expiry', async () => {
		globalThis.fetch = fakeFetch as unknown as typeof fetch;
		const principal = buildPrincipal({ kind: 'workload', userId: workloadId, orgId: 'org_1', role: 'viewer' });
		const first = await core.storage.stsForWorkload(principal, { instanceId: storageId, bucket: 'uploads' });
		expect(first).toMatchObject({
			storageId,
			bucket: 'uploads',
			accessKeyId: 'STSKEY',
			secretAccessKey: 'STSSECRET',
			sessionToken: 'STSTOKEN',
		});
		expect(requests).toHaveLength(1);
		const request = requests[0]!;
		expect(request.url).toBe('http://gateway.test/');
		expect(request.host).toBe(storageGatewayHost(storageId));
		const form = new URLSearchParams(request.body);
		expect(form.get('Action')).toBe('AssumeRoleWithWebIdentity');
		expect(form.get('Version')).toBe('2011-06-15');
		expect(form.get('DurationSeconds')).toBe('3600');
		expect(form.get('RoleSessionName')).toContain(workloadId);
		const policy = JSON.parse(form.get('Policy')!) as {
			Statement: Array<{ Action: string[]; Resource: string[] }>;
		};
		expect(JSON.stringify(policy)).toContain('uploads');
		expect(policy.Statement.flatMap((statement) => statement.Action)).toContain('s3:GetObject');
		expect(policy.Statement.flatMap((statement) => statement.Resource)).toContain('arn:aws:s3:::uploads/*');

		const token = form.get('WebIdentityToken')!;
		const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
			aud: string;
			iss: string;
			groups: string[];
		};
		expect(claims.aud).toBe('yoal');
		expect(claims.iss).toBe('https://control.test');
		expect(claims.groups).toEqual([storagePolicyName(attachmentKeyId)]);

		// A second issue inside the cache window reuses the credentials (no second STS call).
		const cached = await core.storage.stsForWorkload(principal, { instanceId: storageId, bucket: 'uploads' });
		expect(cached).toEqual(first);
		expect(requests).toHaveLength(1);

		// At expiry the cache is stale and the next call mints again.
		clock += 3_600_000;
		await core.storage.stsForWorkload(principal, { instanceId: storageId, bucket: 'uploads' });
		expect(requests).toHaveLength(2);
	});

	test('falls back to the sealed attachment key when STS fails', async () => {
		globalThis.fetch = fakeFetch as unknown as typeof fetch;
		stsFails = true;
		clock += 3_600_000;
		const activation = await core.workloads.activationFor(edgeId, workloadId);
		expect(activation.env.S3_ACCESS_KEY_ID).toBe(attachmentKeyId);
		expect(activation.env.S3_SECRET_ACCESS_KEY).toBeString();
		expect(activation.env.S3_SESSION_TOKEN).toBeUndefined();
		expect(activation.storageSts).toBeUndefined();
	});

	test('capability off keeps the static key and never calls STS', async () => {
		stsFails = false;
		clock += 3_600_000;
		const before = requests.length;
		heartbeat(['workload-identity']);
		const activation = await core.workloads.activationFor(edgeId, workloadId);
		expect(activation.env.S3_ACCESS_KEY_ID).toBe(attachmentKeyId);
		expect(activation.env.S3_SESSION_TOKEN).toBeUndefined();
		expect(activation.storageSts).toBeUndefined();
		expect(requests.length).toBe(before);
	});
});
