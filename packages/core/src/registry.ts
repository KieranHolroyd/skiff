import { and, eq } from 'drizzle-orm';
import { deployments, nodes, pipelineRuns, projects, registryOidcTrusts, registryPins, registryRepositories, settings, workloads } from '@skiff/db';
import {
	REGISTRY_DEFAULT_PORT,
	REGISTRY_DEFAULT_VERSION,
	REGISTRY_ENGINE,
	REGISTRY_GITHUB_OIDC_USER,
	REGISTRY_GITLAB_OIDC_USER,
	GITLAB_DEFAULT_ISSUER,
	REGISTRY_ID_PREFIX,
	REGISTRY_PIN_TAG_PREFIX,
	REGISTRY_REPOSITORY_PATTERN,
	canAdministerPlatform,
	hasPermission,
	parseImageReference,
	registryImageTag,
	registryOidcTrustCreateSchema,
	registrySettingsUpdateSchema,
	workloadSpecSchema,
	type Permission,
	type Principal,
	type RegistryAuthEntry,
	type RegistryMirrorUpstream,
	type RegistryOidcTrustCreate,
	type RegistryOidcTrustView,
	type RegistryPinView,
	type RegistryRepositoryView,
	type RegistrySettingsUpdate,
	type RegistryTagView,
	type RegistryUsageView,
	type RegistryView,
	type StorageRoute,
	type WorkloadActivation,
	type WorkloadDesired,
} from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { CoreError, NotFoundError, ValidationError } from './errors.ts';
import { buildSystemPrincipal } from './iam/system.ts';
import { MANIFEST_ACCEPT } from './oci-client.ts';
import { OidcError, refMatches, verifyGithubOidc, verifyGitlabOidc } from './registry-oidc.ts';
import { certificateFromPrivateKeyPem, type RegistryAccess } from './registry-token.ts';
import { hmac, newId, parseJson, randomBytes, randomToken, safeEqual, sha256Hex } from './util.ts';

/**
 * The platform container registry (docs/REGISTRY.md G1).
 *
 * zot runs as a managed container on one node (the helper derives its image and config, D61);
 * everything Skiff-specific lives here: settings, the Docker token realm, who may pull or push
 * which repository, repository ownership, push events, and listing tags for the dashboard.
 *
 * **Names.** A repository is `<org slug>/<name>`; the first segment is the tenancy boundary.
 * **Principals.** A user or API key gets the intersection of the requested scope and its
 * `image:*` permissions in the org that owns the namespace. A workload pulls with a per-workload
 * HMAC login handed to its node through activation, valid only for its own image's repository.
 * The control plane mints its own tokens for digest resolution and listing.
 */

const CONFIG_KEY = 'registry.config';
/**
 * Legacy (D155): the registry key and certificate sealed in `settings` before the ring. The realm
 * no longer signs with it, but the row stays readable so tokens minted before I15 remain valid
 * until their 5-minute TTL lapses. Remove it (and any migration/cleanup) one release after the ring
 * move; see docs/IAM.md §7.3.
 */
const SIGNING_KEY = 'registry.signingKey';
/** The certificate zot is given, cached by the active ring `kid` (a rotation rewrites it). */
const CERTIFICATE_KEY = `${SIGNING_KEY}.certificate`;
const PLATFORM_KEY_ORG = 'platform';
/** Basic auth forbids ":" in a username (RFC 7617), so the kind and id are joined with ".". */
const WORKLOAD_USER_PREFIX = 'workload.';
/** Pipeline jobs log in as `job.<jobId>` with their job token (docs/PIPELINES.md W9). */
const JOB_USER_PREFIX = 'job.';
/** Nodes pull through the mirror as `node.<nodeId>` with their node token (G4). */
const NODE_USER_PREFIX = 'node.';
const TOKEN_TTL_SECONDS = 300;

interface RegistryConfig {
	enabled: boolean;
	nodeId: string | null;
	host: string | null;
	port: number;
	keepTags: number;
	memoryMb: number;
	version: string;
	workloadId: string;
	/** Path secret for zot's push-event sink. */
	eventsSecret: string;
	/** G4: upstreams mirrored on demand; every node points Podman's mirrors at them. */
	mirrors: RegistryMirrorUpstream[];
	/** G5: signature policy for own-registry deploys, the trusted cosign keys and their upload state. */
	signatures: 'off' | 'warn' | 'enforce';
	cosignKeys: string[];
	cosignKeysSyncedHash: string | null;
	/** G5: zot's admin password (sealed), for the key-upload routes bearer tokens cannot use. */
	adminPasswordSealed: string | null;
	cveScanning: boolean;
	/** G6: S3 storage with a Redis/Valkey cache; secrets sealed. */
	s3: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretSealed: string; cacheUrlSealed: string } | null;
}

export interface RegistryTokenResponse {
	token: string;
	access_token: string;
	expires_in: number;
	issued_at: string;
}

/** Who asks the realm for a token: a resolved user/API key, or a Basic login the realm can't map. */
export type RegistryClient = { kind: 'principal'; principal: Principal } | { kind: 'login'; username: string; password: string } | { kind: 'anonymous' };

interface ZotEvent {
	type: string;
	name?: string;
	reference?: string;
	digest?: string;
}

export class RegistryService {
	constructor(private readonly ctx: CoreContext) {}

	// ------------------------------------------------------------------------------ settings

	private config(): RegistryConfig {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, CONFIG_KEY)).get();
		const stored = parseJson<Partial<RegistryConfig>>(row?.value, {});
		return {
			enabled: stored.enabled ?? false,
			nodeId: stored.nodeId ?? null,
			host: stored.host ?? null,
			port: stored.port ?? REGISTRY_DEFAULT_PORT,
			keepTags: stored.keepTags ?? 20,
			memoryMb: stored.memoryMb ?? 256,
			version: stored.version ?? REGISTRY_DEFAULT_VERSION,
			workloadId: stored.workloadId ?? '',
			eventsSecret: stored.eventsSecret ?? '',
			mirrors: stored.mirrors ?? [],
			signatures: stored.signatures ?? 'off',
			cosignKeys: stored.cosignKeys ?? [],
			cosignKeysSyncedHash: stored.cosignKeysSyncedHash ?? null,
			adminPasswordSealed: stored.adminPasswordSealed ?? null,
			cveScanning: stored.cveScanning ?? false,
			s3: stored.s3 ?? null,
		};
	}

	private saveConfig(config: RegistryConfig): void {
		const value = JSON.stringify(config);
		const now = this.ctx.now();
		this.ctx.db
			.insert(settings)
			.values({ key: CONFIG_KEY, value, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
			.run();
	}

	/** The registry hostname: the configured one, else `registry.<content domain>`. */
	host(): string {
		return this.config().host ?? `registry.${this.ctx.config.contentDomain}`;
	}

	realm(): string {
		return `${this.ctx.config.platformOrigin.replace(/\/$/, '')}/api/registry/token`;
	}

	enabled(): boolean {
		const config = this.config();
		return config.enabled && Boolean(config.nodeId);
	}

	/** True when `image` lives on this install's registry. */
	isOwnImage(image: string | undefined): boolean {
		if (!image || !this.enabled()) return false;
		return parseImageReference(image)?.registry === this.host();
	}

	view(principal: Principal): RegistryView {
		this.ctx.iam.require(principal, 'image:pull', { type: 'org' });
		const config = this.config();
		const node = config.nodeId
			? this.ctx.db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, config.nodeId)).get()
			: undefined;
		const status = !config.enabled ? 'disabled' : (this.statusOf(config.workloadId) ?? 'pending');
		return {
			enabled: config.enabled,
			host: this.host(),
			node: node ?? null,
			status,
			engine: REGISTRY_ENGINE,
			version: config.version,
			keepTags: config.keepTags,
			memoryMb: config.memoryMb,
			realm: this.realm(),
			mirrors: config.mirrors,
			signatures: config.signatures,
			cosignKeys: config.cosignKeys.length,
			cosignKeysPending: config.cosignKeys.length > 0 && config.cosignKeysSyncedHash !== this.keysHash(config),
			cveScanning: config.cveScanning,
			s3: config.s3 ? { endpoint: config.s3.endpoint, bucket: config.s3.bucket, region: config.s3.region } : null,
		};
	}

	private keysHash(config: RegistryConfig): string {
		return sha256Hex(config.cosignKeys.join('\n'));
	}

	private statusOf(workloadId: string): string | null {
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, `${CONFIG_KEY}.status`)).get();
		const stored = parseJson<{ id?: string; status?: string }>(row?.value, {});
		return stored.id === workloadId ? (stored.status ?? null) : null;
	}

	/** The registry node's heartbeat report for the registry workload (status only). */
	applyHeartbeat(nodeId: string, reports: Array<{ id: string; status: string }>): void {
		const config = this.config();
		if (!config.enabled || config.nodeId !== nodeId) return;
		const report = reports.find((entry) => entry.id === config.workloadId);
		if (!report || this.statusOf(config.workloadId) === report.status) return;
		const value = JSON.stringify({ id: config.workloadId, status: report.status });
		const now = this.ctx.now();
		this.ctx.db
			.insert(settings)
			.values({ key: `${CONFIG_KEY}.status`, value, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
			.run();
	}

	update(principal: Principal, raw: RegistrySettingsUpdate): RegistryView {
		if (!canAdministerPlatform(principal))
			throw new CoreError(
				'forbidden',
				principal.platformAdmin
					? 'Registry settings need a platform admin signed in to the dashboard (not an API key or MCP token).'
					: 'Platform admin required.',
				403,
			);
		const input = registrySettingsUpdateSchema.parse(raw);
		const config = this.config();
		if (input.node !== undefined) {
			const node = this.ctx.db
				.select({ id: nodes.id })
				.from(nodes)
				.all()
				.find((row) => row.id === input.node) ??
				this.ctx.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.name, input.node)).get();
			if (!node) throw new NotFoundError('Node');
			config.nodeId = node.id;
		}
		if (input.host !== undefined) config.host = input.host;
		if (input.keepTags !== undefined) config.keepTags = input.keepTags;
		if (input.memoryMb !== undefined) config.memoryMb = input.memoryMb;
		if (input.enabled !== undefined) config.enabled = input.enabled;
		if (input.mirrors !== undefined) config.mirrors = [...new Set(input.mirrors)];
		if (input.signatures !== undefined) config.signatures = input.signatures;
		if (input.cosignKeys !== undefined) {
			for (const key of input.cosignKeys)
				if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(key.trim()))
					throw new ValidationError('Each cosign key must be a PEM public key (cosign.pub).');
			config.cosignKeys = input.cosignKeys.map((key) => key.trim());
		}
		if (input.cveScanning !== undefined) config.cveScanning = input.cveScanning;
		if (input.s3 !== undefined) {
			config.s3 = input.s3
				? {
						endpoint: input.s3.endpoint,
						bucket: input.s3.bucket,
						region: input.s3.region ?? 'us-east-1',
						accessKeyId: input.s3.accessKeyId,
						secretSealed: this.ctx.secrets.seal(PLATFORM_KEY_ORG, input.s3.secretAccessKey),
						cacheUrlSealed: this.ctx.secrets.seal(PLATFORM_KEY_ORG, input.s3.cacheUrl),
					}
				: null;
		}
		if (config.cveScanning && config.s3) throw new ValidationError('zot cannot scan for CVEs with S3 storage; turn one off.');
		if ((config.signatures !== 'off' || config.cosignKeys.length > 0) && !config.adminPasswordSealed)
			config.adminPasswordSealed = this.ctx.secrets.seal(PLATFORM_KEY_ORG, randomToken(24));
		if (config.enabled && !config.nodeId) throw new ValidationError('Choose the node the registry runs on.');
		if (!config.workloadId) config.workloadId = newId(REGISTRY_ID_PREFIX);
		if (!config.eventsSecret) config.eventsSecret = randomToken(24);
		if (config.enabled) this.signingCertificate();
		this.saveConfig(config);
		this.ctx.projects.bump();
		const { s3: s3Input, cosignKeys: _keys, ...audited } = input;
		this.ctx.audit.record({
			principal,
			action: 'registry.settings.update',
			resource: 'registry',
			resourceId: config.workloadId,
			args: {
				...audited,
				...(input.cosignKeys ? { cosignKeys: input.cosignKeys.length } : {}),
				...(s3Input !== undefined ? { s3: s3Input ? { endpoint: s3Input.endpoint, bucket: s3Input.bucket } : null } : {}),
			},
			result: 'ok',
		});
		// Keys go to zot as soon as it runs; the maintenance sweep retries until they land.
		void this.syncTrustKeys().catch(() => undefined);
		return this.view(principal);
	}

	signaturePolicy(): 'off' | 'warn' | 'enforce' {
		return this.config().signatures;
	}

	private trustOn(config: RegistryConfig): boolean {
		return config.signatures !== 'off' || config.cosignKeys.length > 0;
	}

	private s3Endpoint(config: RegistryConfig): { host: string; secure: boolean } | null {
		if (!config.s3) return null;
		const url = new URL(config.s3.endpoint);
		return { host: url.host, secure: url.protocol === 'https:' };
	}

	private adminPassword(config: RegistryConfig): string | null {
		return config.adminPasswordSealed ? this.ctx.secrets.open(PLATFORM_KEY_ORG, config.adminPasswordSealed) : null;
	}

	private adminHtpasswdCache: { password: string; line: string } | null = null;

	/** `skiff-admin:<bcrypt>`: hashed once per password (bcrypt salts differ, so cache it). */
	private adminHtpasswd(config: RegistryConfig): string | null {
		const password = this.adminPassword(config);
		if (!password) return null;
		if (this.adminHtpasswdCache?.password !== password) {
			const stored = this.ctx.db.select().from(settings).where(eq(settings.key, `${CONFIG_KEY}.htpasswd`)).get();
			const line =
				stored && Bun.password.verifySync(password, stored.value.slice('skiff-admin:'.length))
					? stored.value
					: `skiff-admin:${Bun.password.hashSync(password, { algorithm: 'bcrypt', cost: 10 })}`;
			if (!stored || stored.value !== line)
				this.ctx.db
					.insert(settings)
					.values({ key: `${CONFIG_KEY}.htpasswd`, value: line, updatedAt: this.ctx.now() })
					.onConflictDoUpdate({ target: settings.key, set: { value: line, updatedAt: this.ctx.now() } })
					.run();
			this.adminHtpasswdCache = { password, line };
		}
		return this.adminHtpasswdCache.line;
	}

	private trustSync: Promise<boolean> | null = null;

	/** G5: upload the trusted cosign keys to zot as its admin. Returns true once they are in. */
	async syncTrustKeys(): Promise<boolean> {
		// One upload at a time: a settings save and the maintenance sweep may both ask.
		this.trustSync ??= this.uploadTrustKeys().finally(() => {
			this.trustSync = null;
		});
		return this.trustSync;
	}

	private async uploadTrustKeys(): Promise<boolean> {
		const config = this.config();
		if (!config.enabled || !this.trustOn(config) || config.cosignKeys.length === 0) return false;
		const hash = this.keysHash(config);
		if (config.cosignKeysSyncedHash === hash) return true;
		const password = this.adminPassword(config);
		if (!password) return false;
		const authorization = `Basic ${Buffer.from(`skiff-admin:${password}`).toString('base64')}`;
		for (const key of config.cosignKeys) {
			const response = await this.transport()(this.registryUrl('/v2/_zot/ext/cosign'), {
				method: 'POST',
				headers: { Authorization: authorization, 'Content-Type': 'application/octet-stream' },
				body: key,
				signal: AbortSignal.timeout(15_000),
			}).catch(() => null);
			if (!response?.ok) return false;
		}
		const fresh = this.config();
		fresh.cosignKeysSyncedHash = hash;
		this.saveConfig(fresh);
		return true;
	}

	/** zot's search extension (GraphQL), with a token scoped to `repository`. */
	private async graphql<T>(repository: string, query: string): Promise<T> {
		const response = await this.transport()(this.registryUrl(`/v2/_zot/ext/search?query=${encodeURIComponent(query)}`), {
			headers: { Authorization: `Bearer ${this.internalToken(repository)}` },
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) throw new CoreError('upstream', `The registry search answered ${response.status}.`, 502);
		const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
		if (body.errors?.length) throw new CoreError('upstream', `Registry search: ${body.errors[0]!.message}`, 502);
		return body.data as T;
	}

	/**
	 * G5: before a deploy of an own-registry image, check that its digest carries a signature from a
	 * trusted key. `warn` logs and continues; `enforce` refuses the deploy. Other registries: no-op.
	 */
	async checkSignature(image: string, digest: string): Promise<{ signed: boolean; trusted: boolean; checked: boolean }> {
		const config = this.config();
		if (!this.isOwnImage(image) || config.signatures === 'off') return { signed: false, trusted: false, checked: false };
		const repository = parseImageReference(image)!.repository;
		let result = { signed: false, trusted: false };
		try {
			const data = await this.graphql<{ Image?: { IsSigned?: boolean; SignatureInfo?: Array<{ IsTrusted?: boolean }> } | null }>(
				repository,
				`{ Image(image: "${repository}@${digest}") { IsSigned SignatureInfo { Tool IsTrusted Author } } }`,
			);
			result = {
				signed: Boolean(data.Image?.IsSigned),
				trusted: Boolean(data.Image?.SignatureInfo?.some((info) => info.IsTrusted)),
			};
		} catch (error) {
			if (config.signatures === 'enforce')
				throw new ValidationError(`Could not check the signature of ${repository}@${digest}: ${(error as Error).message}`);
		}
		if (!result.trusted) {
			const message = `${repository}@${digest.slice(0, 19)}… is ${result.signed ? 'signed, but not by a trusted key' : 'not signed'}.`;
			if (config.signatures === 'enforce')
				throw new ValidationError(`${message} This registry only deploys images signed by a trusted cosign key.`);
			console.warn(`[registry] ${message}`);
		}
		return { ...result, checked: true };
	}

	/** G5: vulnerability summary (and the most severe CVEs) of one image, from zot's Trivy scan. */
	async vulnerabilities(principal: Principal, repository: string, reference: string) {
		const row = this.requireRepository(principal, repository);
		this.ctx.iam.require(principal, 'image:pull', { type: 'repository', id: row.id });
		if (!this.config().cveScanning) throw new ValidationError('CVE scanning is off; a platform admin turns it on in Settings → Container registries.');
		if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$|^sha256:[a-f0-9]{64}$/.test(reference)) throw new ValidationError('Name a tag or a sha256 digest.');
		const image = reference.startsWith('sha256:') ? `${repository}@${reference}` : `${repository}:${reference}`;
		const data = await this.graphql<{
			CVEListForImage?: {
				Summary?: { MaxSeverity?: string; Count?: number; CriticalCount?: number; HighCount?: number; MediumCount?: number; LowCount?: number; UnknownCount?: number };
				CVEList?: Array<{ Id: string; Severity: string; Title: string }>;
			};
		}>(repository, `{ CVEListForImage(image: "${image}") { Summary { MaxSeverity Count CriticalCount HighCount MediumCount LowCount UnknownCount } CVEList { Id Severity Title } } }`);
		const list = data.CVEListForImage;
		const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };
		return {
			image,
			summary: list?.Summary ?? null,
			cves: (list?.CVEList ?? []).sort((a, b) => (rank[a.Severity] ?? 5) - (rank[b.Severity] ?? 5)).slice(0, 50),
		};
	}

	/**
	 * zot's verification certificate, derived from the ring's active `registry` key. zot reads an
	 * X.509 certificate rather than a JWKS, so a rotation regenerates the self-signed certificate
	 * and the activation version changes. The certificate is cached by `kid` so repeated desired
	 * state renders are byte-identical until the active key actually moves.
	 *
	 * zot trusts one certificate, so the old certificate cannot stay beside the new one. Registry
	 * tokens live five minutes: a token minted just before the switch may fail until the client
	 * fetches a new one. A lossless switch needs zot to accept a certificate bundle (follow-up).
	 */
	private signingCertificate(): { kid: string; certificatePem: string } {
		const active = this.ctx.signingKeys.activeSync('registry');
		const row = this.ctx.db.select().from(settings).where(eq(settings.key, CERTIFICATE_KEY)).get();
		if (row) {
			try {
				const stored = JSON.parse(row.value) as { kid?: string; certificatePem?: string };
				if (stored.kid === active.kid && stored.certificatePem) {
					return { kid: active.kid, certificatePem: stored.certificatePem };
				}
			} catch {
				// A malformed cache is regenerated below.
			}
		}
		const { kid, privateKeyPem } = this.ctx.signingKeys.activePrivateKeyPem('registry');
		const certificatePem = certificateFromPrivateKeyPem(privateKeyPem, 'skiff-registry-token', this.ctx.now());
		const value = JSON.stringify({ kid, certificatePem });
		this.ctx.db
			.insert(settings)
			.values({ key: CERTIFICATE_KEY, value, updatedAt: this.ctx.now() })
			.onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: this.ctx.now() } })
			.run();
		return { kid, certificatePem };
	}

	// ------------------------------------------------------------------- desired state (node)

	isRegistryId(id: string): boolean {
		return id.startsWith(REGISTRY_ID_PREFIX);
	}

	private eventsUrl(config: RegistryConfig): string {
		return `${this.ctx.config.platformOrigin.replace(/\/$/, '')}/api/webhooks/registry/${config.eventsSecret}`;
	}

	private activationVersionOf(config: RegistryConfig): string {
		return sha256Hex(
			JSON.stringify({
				cert: this.signingCertificate().certificatePem,
				events: this.eventsUrl(config),
				host: this.host(),
				keepTags: config.keepTags,
				version: config.version,
				realm: this.realm(),
				// Present only when used, so a registry without them keeps its version.
				...(config.mirrors.length ? { mirrors: config.mirrors } : {}),
				...(this.trustOn(config) ? { trust: true, admin: sha256Hex(config.adminPasswordSealed ?? '') } : {}),
				...(config.cveScanning ? { cve: true } : {}),
				...(config.s3 ? { s3: sha256Hex(JSON.stringify(config.s3)) } : {}),
			}),
		);
	}

	/** G4: the mirror every node points Podman at, or null when none is on. */
	mirrorForNodes(): { host: string; upstreams: RegistryMirrorUpstream[] } | null {
		const config = this.config();
		if (!this.enabled() || config.mirrors.length === 0) return null;
		return { host: this.host(), upstreams: config.mirrors };
	}

	/** `docker.io/…`, `ghcr.io/…`, `quay.io/…` repositories while that mirror is on. */
	private isMirrorRepository(name: string): boolean {
		const upstream = name.split('/')[0]!;
		return (this.config().mirrors as string[]).includes(upstream);
	}

	desiredForNode(nodeId: string): WorkloadDesired[] {
		const config = this.config();
		if (!config.enabled || config.nodeId !== nodeId || !config.workloadId) return [];
		return [
			{
				id: config.workloadId,
				projectId: config.workloadId,
				projectSlug: 'registry',
				deploymentId: config.workloadId,
				runtime: 'container',
				status: 'running',
				release: null,
				image: registryImageTag(config.version),
				upstream: `127.0.0.1:${config.port}`,
				memoryMb: config.memoryMb,
				cpus: 1,
				port: config.port,
				healthPath: '/readyz',
				socketActivation: false,
				activationVersion: this.activationVersionOf(config),
				env: {},
				secrets: [],
				dataSizeMb: null,
				registry: {
					engine: REGISTRY_ENGINE,
					version: config.version as '2.1.23',
					service: this.host(),
					realm: this.realm(),
					keepTags: config.keepTags,
					mirrors: config.mirrors,
					trust: this.trustOn(config),
					cve: config.cveScanning,
					s3: (() => {
						const endpoint = this.s3Endpoint(config);
						return endpoint && config.s3
							? { endpoint: endpoint.host, bucket: config.s3.bucket, region: config.s3.region, secure: endpoint.secure }
							: null;
					})(),
				},
			} as WorkloadDesired,
		];
	}

	/**
	 * Caddy routes for the registry host: the registry node proxies to its loopback port, the edge
	 * proxies to that node. Same streaming route as public S3 (D64): no body limit, no buffering.
	 */
	routesForNode(nodeId: string, isEdge: boolean, publicAddressOf: (nodeId: string) => string | null): StorageRoute[] {
		const config = this.config();
		if (!config.enabled || !config.nodeId) return [];
		if (config.nodeId === nodeId) return [{ storageId: config.workloadId, host: this.host(), upstream: `127.0.0.1:${config.port}` }];
		if (!isEdge) return [];
		return [{ storageId: config.workloadId, host: this.host(), upstream: `http://${publicAddressOf(config.nodeId) ?? '127.0.0.1:1'}` }];
	}

	activation(nodeId: string, id: string): WorkloadActivation {
		const config = this.config();
		if (!config.enabled || id !== config.workloadId) throw new NotFoundError('Registry');
		if (config.nodeId !== nodeId) throw new CoreError('forbidden', 'The registry is placed on another node.', 403);
		return {
			workloadId: id,
			activationVersion: this.activationVersionOf(config),
			env: {
				SKIFF_REGISTRY_TOKEN_CERT: this.signingCertificate().certificatePem,
				SKIFF_REGISTRY_EVENTS_URL: this.eventsUrl(config),
				...(this.trustOn(config) ? { SKIFF_REGISTRY_ADMIN_HTPASSWD: this.adminHtpasswd(config)! } : {}),
				...(config.s3
					? {
							SKIFF_REGISTRY_S3_ACCESS_KEY: config.s3.accessKeyId,
							SKIFF_REGISTRY_S3_SECRET_KEY: this.ctx.secrets.open(PLATFORM_KEY_ORG, config.s3.secretSealed),
							SKIFF_REGISTRY_CACHE_URL: this.ctx.secrets.open(PLATFORM_KEY_ORG, config.s3.cacheUrlSealed),
						}
					: {}),
			},
			files: {},
		};
	}

	// -------------------------------------------------------------------------------- tokens

	/** The per-workload pull login a node receives through activation (never stored). */
	workloadLogin(desiredId: string): RegistryAuthEntry {
		return {
			registry: this.host(),
			username: `${WORKLOAD_USER_PREFIX}${desiredId}`,
			password: hmac(this.ctx.config.masterKey, `registry-workload:${desiredId}`),
		};
	}

	/**
	 * Mint a Docker token with the ring's `registry` purpose (D155 moved onto the ring, I15).
	 * `iss` is the platform origin, as before, and the key's `kid` is now the ring `kid`.
	 */
	private mintRegistryToken(
		subject: string,
		access: RegistryAccess[],
		ttlSeconds: number,
	): { token: string; expiresIn: number; issuedAt: string } {
		const iat = Math.floor(this.ctx.now() / 1000);
		const token = this.ctx.signingKeys.signSync(
			'registry',
			{
				sub: subject,
				aud: this.host(),
				nbf: iat - 30,
				jti: randomBytes(12).toString('hex'),
				access,
			},
			ttlSeconds,
		);
		return { token, expiresIn: ttlSeconds, issuedAt: new Date(iat * 1000).toISOString() };
	}

	/** A token the control plane uses itself: pull (and optionally delete) on one repository. */
	internalToken(repository: string, actions: string[] = ['pull']): string {
		return this.mintRegistryToken('skiff-control-plane', [{ type: 'repository', name: repository, actions }], 120).token;
	}

	/**
	 * The realm (`GET /api/registry/token`): grant the subset of `scopes` the client may have.
	 * Docker's login probe asks with no scope and only needs a token to exist.
	 */
	issueToken(client: RegistryClient, service: string | null, scopes: string[]): RegistryTokenResponse {
		if (!this.enabled()) throw new NotFoundError('Registry');
		if (service && service !== this.host()) throw new ValidationError(`This realm issues tokens for ${this.host()}, not ${service}.`);
		let subject: string;
		let access: RegistryAccess[];
		if (client.kind === 'principal') {
			subject = `user:${client.principal.userId}`;
			access = scopes.flatMap((scope) => this.grantForPrincipal(client.principal, scope));
		} else if (client.kind === 'login' && client.username.startsWith(WORKLOAD_USER_PREFIX)) {
			const desiredId = client.username.slice(WORKLOAD_USER_PREFIX.length);
			if (!safeEqual(client.password, this.workloadLogin(desiredId).password))
				throw new CoreError('unauthorized', 'Invalid registry login.', 401);
			subject = client.username;
			access = scopes.flatMap((scope) => this.grantForWorkload(desiredId, scope));
		} else if (client.kind === 'login' && client.username.startsWith(NODE_USER_PREFIX)) {
			// A node pulls through the mirror with its own token (G4); it gets nothing else.
			let node: { id: string };
			try {
				node = this.ctx.nodes.authenticate(client.password);
			} catch {
				throw new CoreError('unauthorized', 'Invalid registry login.', 401);
			}
			if (node.id !== client.username.slice(NODE_USER_PREFIX.length)) throw new CoreError('unauthorized', 'Invalid registry login.', 401);
			subject = client.username;
			access = scopes.flatMap((scope) => this.grantMirrorPull(scope));
		} else if (client.kind === 'login' && client.username.startsWith(JOB_USER_PREFIX)) {
			const job = this.authenticateJob(client.username.slice(JOB_USER_PREFIX.length), client.password);
			subject = client.username;
			access = scopes.flatMap((scope) => this.grantForJob(job, scope));
		} else {
			throw new CoreError('unauthorized', 'Sign in with your Skiff API key as the password.', 401);
		}
		const signed = this.mintRegistryToken(subject, access, TOKEN_TTL_SECONDS);
		return { token: signed.token, access_token: signed.token, expires_in: signed.expiresIn, issued_at: signed.issuedAt };
	}

	/**
	 * The realm entry point (`GET /api/registry/token`). CI OIDC tokens — GitHub Actions (G3) and
	 * GitLab CI `id_tokens` (D178) — are verified asynchronously against the issuer's keys; every
	 * other client goes through `issueToken`.
	 */
	async authorize(client: RegistryClient, service: string | null, scopes: string[]): Promise<RegistryTokenResponse> {
		const oidcUser = client.kind === 'login' && (client.username === REGISTRY_GITHUB_OIDC_USER || client.username === REGISTRY_GITLAB_OIDC_USER);
		if (!oidcUser || client.kind !== 'login') return this.issueToken(client, service, scopes);
		if (!this.enabled()) throw new NotFoundError('Registry');
		if (service && service !== this.host()) throw new ValidationError(`This realm issues tokens for ${this.host()}, not ${service}.`);
		let trusts: Array<typeof registryOidcTrusts.$inferSelect>;
		let subject: string;
		let source: string;
		try {
			if (client.username === REGISTRY_GITHUB_OIDC_USER) {
				const claims = await verifyGithubOidc(client.password, { audience: this.host(), fetch: this.transport(), now: this.ctx.now() });
				trusts = this.ctx.db
					.select()
					.from(registryOidcTrusts)
					.where(and(eq(registryOidcTrusts.provider, 'github'), eq(registryOidcTrusts.subjectRepository, claims.repository)))
					.all()
					.filter((trust) => refMatches(trust.subjectRef, claims.ref));
				if (trusts.length === 0)
					throw new CoreError('unauthorized', `No organisation trusts GitHub repository ${claims.repository} at ${claims.ref}.`, 401);
				subject = `github:${claims.sub}`;
				source = `github:${claims.repository}`;
			} else {
				const gitlabTrusts = this.ctx.db.select().from(registryOidcTrusts).where(eq(registryOidcTrusts.provider, 'gitlab')).all();
				const issuers = [...new Set(gitlabTrusts.map((trust) => trust.issuer ?? GITLAB_DEFAULT_ISSUER))];
				const claims = await verifyGitlabOidc(client.password, { audience: this.host(), issuers, fetch: this.transport(), now: this.ctx.now() });
				trusts = gitlabTrusts.filter(
					(trust) =>
						(trust.issuer ?? GITLAB_DEFAULT_ISSUER) === claims.iss &&
						trust.subjectRepository.toLowerCase() === claims.project_path.toLowerCase() &&
						refMatches(trust.subjectRef, claims.fullRef),
				);
				if (trusts.length === 0)
					throw new CoreError('unauthorized', `No organisation trusts GitLab project ${claims.project_path} at ${claims.fullRef}.`, 401);
				subject = `gitlab:${claims.sub}`;
				source = `gitlab:${claims.project_path}`;
			}
		} catch (error) {
			if (error instanceof CoreError) throw error;
			throw new CoreError('unauthorized', error instanceof OidcError ? error.message : 'Invalid OIDC token.', 401);
		}
		const access = scopes.flatMap((scope): RegistryAccess[] => {
			const parsed = this.parseScope(scope);
			if (!parsed) return [];
			const allowed = new Set<string>();
			for (const trust of trusts) {
				const target = trust.repository.endsWith('/*') ? `${trust.repository.slice(0, -1)}` : null;
				const covers = target ? parsed.name.startsWith(target) : parsed.name === trust.repository;
				if (!covers || this.orgIdBySlug(parsed.name.split('/')[0]!) !== trust.orgId) continue;
				allowed.add('pull');
				if (trust.push) allowed.add('push');
			}
			const actions = parsed.actions.flatMap((action) => (action === '*' ? ['pull', 'push'] : [action])).filter((action) => allowed.has(action));
			if (actions.length === 0) return [];
			const orgId = this.orgIdBySlug(parsed.name.split('/')[0]!)!;
			if (actions.includes('push')) {
				this.assertPushQuota(orgId, parsed.name);
				this.ensureRepository(orgId, parsed.name, source);
			}
			return [{ type: 'repository', name: parsed.name, actions: [...new Set(actions)] }];
		});
		const signed = this.mintRegistryToken(subject, access, TOKEN_TTL_SECONDS);
		return { token: signed.token, access_token: signed.token, expires_in: signed.expiresIn, issued_at: signed.issuedAt };
	}

	listOidcTrusts(principal: Principal): RegistryOidcTrustView[] {
		this.ctx.iam.require(principal, 'image:pull', { type: 'org' });
		return this.ctx.db
			.select()
			.from(registryOidcTrusts)
			.where(eq(registryOidcTrusts.orgId, principal.orgId))
			.all()
			.map((row) => ({
				id: row.id,
				provider: row.provider,
				githubRepository: row.subjectRepository,
				subject: row.subjectRepository,
				issuer: row.provider === 'gitlab' ? (row.issuer ?? GITLAB_DEFAULT_ISSUER) : null,
				ref: row.subjectRef,
				repository: row.repository,
				push: row.push,
				createdAt: row.createdAt,
			}));
	}

	/** Let a GitHub repository's workflows or a GitLab project's jobs use one repository (or `<org>/*`) with their OIDC token. */
	createOidcTrust(principal: Principal, raw: RegistryOidcTrustCreate): RegistryOidcTrustView {
		this.ctx.iam.require(principal, 'image:credentials', { type: 'org' });
		const input = registryOidcTrustCreateSchema.parse(raw);
		if (input.push) this.ctx.iam.require(principal, 'image:push', { type: 'org' });
		const slug = this.orgSlug(principal.orgId);
		const [owner, ...rest] = input.repository.split('/');
		if (!slug || owner !== slug || rest.length === 0)
			throw new ValidationError(`The repository must be in your namespace: ${slug ?? '<org>'}/<name> or ${slug ?? '<org>'}/*.`);
		if (input.repository !== `${slug}/*` && !REGISTRY_REPOSITORY_PATTERN.test(input.repository))
			throw new ValidationError(`"${input.repository}" is not a repository name.`);
		const row = {
			id: newId('rot_'),
			orgId: principal.orgId,
			provider: input.provider,
			subjectRepository: input.provider === 'gitlab' ? input.gitlabProject! : input.githubRepository!,
			issuer: input.provider === 'gitlab' ? (input.issuer ?? GITLAB_DEFAULT_ISSUER) : null,
			subjectRef: input.ref ?? null,
			repository: input.repository,
			push: input.push,
			createdBy: principal.userId,
			createdAt: this.ctx.now(),
		};
		this.ctx.db.insert(registryOidcTrusts).values(row).run();
		this.ctx.audit.record({
			principal,
			action: 'registry.oidc.create',
			resource: 'registryOidcTrust',
			resourceId: row.id,
			args: { provider: row.provider, subject: row.subjectRepository, issuer: row.issuer, ref: row.subjectRef, repository: row.repository, push: row.push },
			result: 'ok',
		});
		return this.listOidcTrusts(principal).find((trust) => trust.id === row.id)!;
	}

	deleteOidcTrust(principal: Principal, id: string): void {
		this.ctx.iam.require(principal, 'image:credentials', { type: 'org' });
		const row = this.ctx.db.select().from(registryOidcTrusts).where(eq(registryOidcTrusts.id, id)).get();
		if (!row || row.orgId !== principal.orgId) throw new NotFoundError('Trust');
		this.ctx.db.delete(registryOidcTrusts).where(eq(registryOidcTrusts.id, id)).run();
		this.ctx.audit.record({ principal, action: 'registry.oidc.delete', resource: 'registryOidcTrust', resourceId: id, result: 'ok' });
	}

	private parseScope(scope: string): { name: string; actions: string[] } | null {
		const match = /^repository:([^:]+):([a-z*,]+)$/.exec(scope);
		if (!match) return null;
		const name = match[1]!;
		if (!REGISTRY_REPOSITORY_PATTERN.test(name)) return null;
		return { name, actions: [...new Set(match[2]!.split(',').filter(Boolean))] };
	}

	private orgIdBySlug(slug: string): string | null {
		return (
			this.ctx.sqlite.query<{ id: string }, [string]>('SELECT id FROM organization WHERE slug = ? LIMIT 1').get(slug)?.id ?? null
		);
	}

	private orgSlug(orgId: string): string | null {
		return this.ctx.sqlite.query<{ slug: string }, [string]>('SELECT slug FROM organization WHERE id = ? LIMIT 1').get(orgId)?.slug ?? null;
	}

	/** Pull on a mirrored upstream repository (G4); anything signed in may read the cache. */
	private grantMirrorPull(scope: string): RegistryAccess[] {
		const parsed = this.parseScope(scope);
		if (!parsed || !this.isMirrorRepository(parsed.name) || !parsed.actions.some((a) => a === 'pull' || a === '*')) return [];
		return [{ type: 'repository', name: parsed.name, actions: ['pull'] }];
	}

	private grantForPrincipal(principal: Principal, scope: string): RegistryAccess[] {
		const parsed = this.parseScope(scope);
		if (!parsed) return [];
		if (this.isMirrorRepository(parsed.name)) return hasPermission(principal, 'image:pull') ? this.grantMirrorPull(scope) : [];
		const orgSlug = parsed.name.split('/')[0]!;
		const orgId = this.orgIdBySlug(orgSlug);
		// The namespace is the principal's own org; a token never crosses orgs.
		if (!orgId || orgId !== principal.orgId) return [];
		const wanted: Record<string, Permission> = { pull: 'image:pull', push: 'image:push', delete: 'image:delete' };
		const actions = parsed.actions
			.flatMap((action) => (action === '*' ? ['pull', 'push', 'delete'] : [action]))
			.filter((action) => wanted[action] && hasPermission(principal, wanted[action]!));
		if (actions.length === 0) return [];
		if (actions.includes('push')) {
			this.assertPushQuota(orgId, parsed.name);
			this.ensureRepository(orgId, parsed.name, principal.userId);
		}
		return [{ type: 'repository', name: parsed.name, actions: [...new Set(actions)] }];
	}

	/** A running pipeline job, by id and its job token (`pjt_…`). */
	private authenticateJob(jobId: string, token: string): { orgId: string; trusted: boolean; createdBy: string } {
		let job: { id: string; orgId: string; runId: string };
		try {
			job = this.ctx.pipelines.engine.authenticateJob(token);
		} catch {
			throw new CoreError('unauthorized', 'Invalid registry login.', 401);
		}
		if (job.id !== jobId) throw new CoreError('unauthorized', 'Invalid registry login.', 401);
		const run = this.ctx.db
			.select({ trust: pipelineRuns.trust, createdBy: pipelineRuns.createdBy })
			.from(pipelineRuns)
			.where(eq(pipelineRuns.id, job.runId))
			.get();
		return { orgId: job.orgId, trusted: run?.trust !== 'untrusted', createdBy: run?.createdBy ?? 'pipeline' };
	}

	/**
	 * A pipeline job works in its org's namespace: pull anything there, push only from a trusted run
	 * (W10: pull requests from forks never publish images). It never deletes.
	 */
	private grantForJob(job: { orgId: string; trusted: boolean; createdBy: string }, scope: string): RegistryAccess[] {
		const parsed = this.parseScope(scope);
		if (!parsed) return [];
		if (this.isMirrorRepository(parsed.name)) return this.grantMirrorPull(scope);
		if (this.orgIdBySlug(parsed.name.split('/')[0]!) !== job.orgId) return [];
		const actions = parsed.actions
			.flatMap((action) => (action === '*' ? ['pull', 'push'] : [action]))
			.filter((action) => action === 'pull' || (action === 'push' && job.trusted));
		if (actions.length === 0) return [];
		if (actions.includes('push')) {
			this.assertPushQuota(job.orgId, parsed.name);
			this.ensureRepository(job.orgId, parsed.name, job.createdBy);
		}
		return [{ type: 'repository', name: parsed.name, actions: [...new Set(actions)] }];
	}

	/** What a pipeline job sees of the registry (claim + `skiff.registry*`), or null when it is off. */
	jobRegistry(orgId: string, trust: string): { host: string; namespace: string; push: boolean } | null {
		if (!this.enabled()) return null;
		const slug = this.orgSlug(orgId);
		if (!slug) return null;
		return { host: this.host(), namespace: `${this.host()}/${slug}`, push: trust !== 'untrusted' };
	}

	/** A workload may pull exactly the repository its own image names, nothing else. */
	private grantForWorkload(desiredId: string, scope: string): RegistryAccess[] {
		const parsed = this.parseScope(scope);
		if (!parsed || !parsed.actions.includes('pull')) return [];
		// The workload's auth file replaces root's for its pull, so it covers the mirror too (G4).
		if (this.isMirrorRepository(parsed.name)) return this.grantMirrorPull(scope);
		const workloadId = desiredId.replace(/-r\d+$/, '');
		const row = this.ctx.db.select({ specJson: workloads.specJson }).from(workloads).where(eq(workloads.id, workloadId)).get();
		const image = workloadSpecSchema.safeParse(parseJson<unknown>(row?.specJson, null)).data?.image;
		const ref = image ? parseImageReference(image) : null;
		if (!ref || ref.registry !== this.host() || ref.repository !== parsed.name) return [];
		return [{ type: 'repository', name: parsed.name, actions: ['pull'] }];
	}

	private ensureRepository(orgId: string, name: string, userId: string): void {
		const existing = this.ctx.db.select({ id: registryRepositories.id }).from(registryRepositories).where(eq(registryRepositories.name, name)).get();
		if (existing) return;
		// `<org>/<project-slug>` links itself to that project.
		const projectSlug = name.split('/')[1];
		const project = this.ctx.db
			.select({ id: projects.id })
			.from(projects)
			.where(and(eq(projects.orgId, orgId), eq(projects.slug, projectSlug ?? '')))
			.get();
		this.ctx.db
			.insert(registryRepositories)
			.values({
				id: newId('rr_'),
				orgId,
				name,
				projectId: name.split('/').length === 2 ? (project?.id ?? null) : null,
				createdBy: userId,
				createdAt: this.ctx.now(),
			})
			.onConflictDoNothing()
			.run();
	}

	// -------------------------------------------------------------------------------- events

	/** zot's CloudEvents sink (`POST /api/registry/events/<secret>`). Unknown types are ignored. */
	recordEvent(secret: string, type: string | null, body: unknown): boolean {
		const config = this.config();
		if (!config.eventsSecret || !safeEqual(secret, config.eventsSecret)) throw new CoreError('forbidden', 'Unknown event sink.', 403);
		const event = { type: type ?? '', ...((body ?? {}) as Omit<ZotEvent, 'type'>) };
		if (event.type !== 'zotregistry.image.updated' || !event.name || !event.digest) return false;
		if (event.reference?.startsWith(REGISTRY_PIN_TAG_PREFIX)) return false;
		const row = this.ctx.db.select().from(registryRepositories).where(eq(registryRepositories.name, event.name)).get();
		if (!row) return false;
		this.ctx.db
			.update(registryRepositories)
			.set({
				pushes: row.pushes + 1,
				lastTag: event.reference && !event.reference.startsWith('sha256:') ? event.reference : row.lastTag,
				lastDigest: event.digest,
				lastPushAt: this.ctx.now(),
			})
			.where(eq(registryRepositories.id, row.id))
			.run();
		this.ctx.events.emitRegistryPush(row.orgId, event.name, {
			repository: event.name,
			tag: event.reference && !event.reference.startsWith('sha256:') ? event.reference : null,
			digest: event.digest,
			image: `${this.host()}/${event.name}@${event.digest}`,
		});
		if (row.deployProjectId && row.deployTag && event.reference === row.deployTag)
			void this.autoDeploy(row.orgId, row.deployProjectId, event.name, row.deployTag, event.digest);
		return true;
	}

	/** Deploy on push (§5.3): the pushed tag goes to the linked project, pinned to its digest. */
	private async autoDeploy(orgId: string, projectId: string, repository: string, tag: string, digest: string): Promise<void> {
		const project = this.ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
		if (!project || project.deletedAt || project.orgId !== orgId) return;
		const principal = buildSystemPrincipal('system:registry-autodeploy', orgId);
		try {
			await this.ctx.deployments.deployImage(principal, project, {
				image: `${this.host()}/${repository}:${tag}`,
				message: `Pushed ${repository}:${tag} (${digest.slice(7, 19)})`,
			});
		} catch (error) {
			console.error(`[registry] deploy on push of ${repository}:${tag} to ${project.slug} failed:`, error);
		}
	}

	/** Link a repository tag to a project so every push of it deploys there; `project: null` unlinks. */
	setAutoDeploy(principal: Principal, name: string, input: { project: string | null; tag?: string }): RegistryRepositoryView {
		const row = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'image:push', { type: 'repository', id: row.id });
		let projectId: string | null = null;
		let tag: string | null = null;
		if (input.project) {
			const project = this.ctx.db
				.select()
				.from(projects)
				.where(and(eq(projects.orgId, principal.orgId), eq(projects.slug, input.project)))
				.get();
			if (!project || project.deletedAt) throw new NotFoundError('Project');
			this.ctx.iam.require(principal, 'deployment:create', { type: 'project', id: project.id });
			if (project.runtime !== 'container')
				throw new ValidationError(`"${project.slug}" is not a container project; only containers deploy an image.`);
			tag = (input.tag ?? 'latest').trim();
			if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag) || tag.startsWith(REGISTRY_PIN_TAG_PREFIX))
				throw new ValidationError(`"${tag}" is not a tag Skiff can deploy on push.`);
			projectId = project.id;
		} else {
			this.ctx.iam.require(principal, 'deployment:create', { type: 'org' });
		}
		this.ctx.db
			.update(registryRepositories)
			.set({ deployProjectId: projectId, deployTag: tag })
			.where(eq(registryRepositories.id, row.id))
			.run();
		this.ctx.audit.record({
			principal,
			action: 'registry.autodeploy.update',
			resource: 'registryRepository',
			resourceId: name,
			args: { project: input.project, tag },
			result: 'ok',
		});
		return this.repositoryView(this.requireRepository(principal, name), this.projectSlugs(principal.orgId));
	}

	// ------------------------------------------------------------------- usage and quota

	/** Sampled bytes of an org's repositories, or of those linked to one project. */
	usedBytes(orgId: string, projectId?: string | null): number {
		const rows = this.ctx.db
			.select({ bytes: registryRepositories.bytes, projectId: registryRepositories.projectId })
			.from(registryRepositories)
			.where(eq(registryRepositories.orgId, orgId))
			.all();
		return rows.filter((row) => !projectId || row.projectId === projectId).reduce((total, row) => total + row.bytes, 0);
	}

	private assertPushQuota(orgId: string, repository: string): void {
		this.ctx.quota.assertCanPushImage(orgId, null, this.usedBytes(orgId));
		const projectId = this.ctx.db
			.select({ projectId: registryRepositories.projectId })
			.from(registryRepositories)
			.where(eq(registryRepositories.name, repository))
			.get()?.projectId;
		if (projectId) this.ctx.quota.assertCanPushImage(orgId, projectId, this.usedBytes(orgId, projectId));
	}

	private lastSampleAt = 0;

	/**
	 * Re-measure every repository (§6.3): the unique blobs (config + layers) of every manifest any
	 * tag points at, deployment pins included, counted once per repository. Plain OCI calls, so it
	 * works against any registry engine. At most hourly unless `force`.
	 */
	async sampleUsage(options: { force?: boolean } = {}): Promise<number> {
		if (!this.enabled()) return 0;
		if (!options.force && this.ctx.now() - this.lastSampleAt < 60 * 60_000) return 0;
		this.lastSampleAt = this.ctx.now();
		let sampled = 0;
		for (const row of this.ctx.db.select().from(registryRepositories).all()) {
			const bytes = await this.measureRepository(row.name).catch(() => null);
			if (bytes === null) continue;
			this.ctx.db
				.update(registryRepositories)
				.set({ bytes, bytesSampledAt: this.ctx.now() })
				.where(eq(registryRepositories.id, row.id))
				.run();
			sampled += 1;
		}
		return sampled;
	}

	private async measureRepository(name: string): Promise<number> {
		const headers = { Authorization: `Bearer ${this.internalToken(name)}`, Accept: MANIFEST_ACCEPT };
		const get = async (path: string) => {
			const response = await this.transport()(this.registryUrl(`/v2/${name}/${path}`), { headers, signal: AbortSignal.timeout(15_000) });
			if (response.status === 404) return null;
			if (!response.ok) throw new Error(`${path} answered ${response.status}`);
			return response.json() as Promise<Record<string, unknown>>;
		};
		const tags = ((await get('tags/list'))?.tags as string[] | null | undefined) ?? [];
		const blobs = new Map<string, number>();
		const seen = new Set<string>();
		const walk = async (reference: string, depth: number): Promise<void> => {
			if (seen.has(reference) || depth > 2) return;
			seen.add(reference);
			const manifest = await get(`manifests/${reference}`);
			if (!manifest) return;
			const children = manifest.manifests as Array<{ digest: string }> | undefined;
			if (Array.isArray(children)) {
				for (const child of children) await walk(child.digest, depth + 1);
				return;
			}
			for (const blob of [manifest.config, ...((manifest.layers as unknown[]) ?? [])] as Array<{ digest?: string; size?: number }>)
				if (blob?.digest && typeof blob.size === 'number') blobs.set(blob.digest, blob.size);
		};
		for (const tag of tags) await walk(tag, 0);
		return [...blobs.values()].reduce((total, size) => total + size, 0);
	}

	// ------------------------------------------------------------------------ pins (R11)

	/**
	 * Tag the digest a new deployment runs as `skiff-d-<deployment>`, so retention keeps it for as
	 * long as the deployment exists (rollback included). Best effort: a failure is logged and the
	 * deployment stands; the pin sweep retries nothing, the next deploy pins again.
	 */
	async pinDeployment(image: string | undefined, digest: string | undefined, deploymentId: string): Promise<void> {
		if (!image || !digest || !this.isOwnImage(image)) return;
		const repository = parseImageReference(image)!.repository;
		const token = this.internalToken(repository, ['pull', 'push']);
		try {
			const manifest = await this.transport()(this.registryUrl(`/v2/${repository}/manifests/${digest}`), {
				headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
				signal: AbortSignal.timeout(15_000),
			});
			if (!manifest.ok) throw new Error(`GET manifest answered ${manifest.status}`);
			const body = new Uint8Array(await manifest.arrayBuffer());
			const put = await this.transport()(this.registryUrl(`/v2/${repository}/manifests/${REGISTRY_PIN_TAG_PREFIX}${deploymentId}`), {
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': manifest.headers.get('content-type') ?? 'application/vnd.oci.image.manifest.v1+json',
				},
				body,
				signal: AbortSignal.timeout(15_000),
			});
			if (!put.ok) throw new Error(`PUT pin answered ${put.status}`);
			this.ctx.db
				.insert(registryPins)
				.values({ deploymentId, repository, digest, createdAt: this.ctx.now() })
				.onConflictDoNothing()
				.run();
		} catch (error) {
			console.warn(`[registry] could not pin ${repository}@${digest} for ${deploymentId}:`, error instanceof Error ? error.message : error);
		}
	}

	/** Remove pins whose deployment row is gone (maintenance sweep). Returns how many were removed. */
	async sweepPins(): Promise<number> {
		if (!this.enabled()) return 0;
		const stale = this.ctx.db
			.select({ pin: registryPins, deploymentId: deployments.id })
			.from(registryPins)
			.leftJoin(deployments, eq(deployments.id, registryPins.deploymentId))
			.all()
			.filter((row) => !row.deploymentId)
			.map((row) => row.pin);
		let removed = 0;
		for (const pin of stale) {
			const response = await this.transport()(
				this.registryUrl(`/v2/${pin.repository}/manifests/${REGISTRY_PIN_TAG_PREFIX}${pin.deploymentId}`),
				{
					method: 'DELETE',
					headers: { Authorization: `Bearer ${this.internalToken(pin.repository, ['pull', 'delete'])}` },
					signal: AbortSignal.timeout(15_000),
				},
			).catch(() => null);
			if (!response || (!response.ok && response.status !== 404)) continue;
			this.ctx.db.delete(registryPins).where(eq(registryPins.deploymentId, pin.deploymentId)).run();
			removed += 1;
		}
		return removed;
	}

	// -------------------------------------------------------------------------- repositories

	listRepositories(principal: Principal): RegistryRepositoryView[] {
		// TODO(IAM I2): narrow this list once registry repositories can be selected for a
		// resource-scoped principal; `scopeFilter` only returns project/environment ids.
		this.ctx.iam.require(principal, 'image:pull', { type: 'org' });
		const projectSlugs = this.projectSlugs(principal.orgId);
		return this.ctx.db
			.select()
			.from(registryRepositories)
			.where(eq(registryRepositories.orgId, principal.orgId))
			.all()
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => this.repositoryView(row, projectSlugs));
	}

	private projectSlugs(orgId: string): Map<string, string> {
		return new Map(
			this.ctx.db
				.select({ id: projects.id, slug: projects.slug })
				.from(projects)
				.where(eq(projects.orgId, orgId))
				.all()
				.map((row) => [row.id, row.slug]),
		);
	}

	private repositoryView(
		row: typeof registryRepositories.$inferSelect,
		projectSlugs: Map<string, string>,
	): RegistryRepositoryView {
		return {
			name: row.name,
			projectSlug: row.projectId ? (projectSlugs.get(row.projectId) ?? null) : null,
			pushes: row.pushes,
			lastTag: row.lastTag,
			lastDigest: row.lastDigest,
			lastPushAt: row.lastPushAt,
			createdAt: row.createdAt,
			bytes: row.bytes,
			deploy: row.deployProjectId
				? { project: projectSlugs.get(row.deployProjectId) ?? null, tag: row.deployTag ?? 'latest' }
				: null,
		};
	}

	/** One repository of the principal's org. */
	repository(principal: Principal, name: string): RegistryRepositoryView {
		const row = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'image:pull', { type: 'repository', id: row.id });
		return this.repositoryView(row, this.projectSlugs(principal.orgId));
	}

	/** Deployments that pin a digest of this repository, newest first. */
	pins(principal: Principal, name: string): RegistryPinView[] {
		const row = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'image:pull', { type: 'repository', id: row.id });
		return this.ctx.db
			.select({ pin: registryPins, deployment: deployments, project: projects })
			.from(registryPins)
			.innerJoin(deployments, eq(deployments.id, registryPins.deploymentId))
			.leftJoin(projects, eq(projects.id, deployments.projectId))
			.where(and(eq(registryPins.repository, name), eq(deployments.orgId, principal.orgId)))
			.all()
			.sort((a, b) => b.deployment.createdAt - a.deployment.createdAt)
			.map(({ pin, deployment, project }) => ({
				deploymentId: deployment.id,
				shortId: deployment.shortId,
				projectSlug: project?.slug ?? null,
				digest: pin.digest,
				status: deployment.status,
				production: project?.productionDeploymentId === deployment.id,
				createdAt: deployment.createdAt,
			}));
	}

	/** The org's sampled registry storage against its quota. */
	usage(principal: Principal): RegistryUsageView {
		this.ctx.iam.require(principal, 'image:pull', { type: 'org' });
		const limit = this.ctx.quota.effective(principal.orgId).registryBytes;
		return { usedBytes: this.usedBytes(principal.orgId), limitBytes: limit < 0 ? null : limit };
	}

	private requireRepository(principal: Principal, name: string) {
		const row = this.ctx.db.select().from(registryRepositories).where(eq(registryRepositories.name, name)).get();
		if (!row || row.orgId !== principal.orgId) throw new NotFoundError('Repository');
		return row;
	}

	private registryUrl(path: string): string {
		return `https://${this.host()}${path}`;
	}

	private transport(): typeof fetch {
		return this.ctx.config.registryFetch ?? fetch;
	}

	/** Tags of one repository, read from zot; deployment pins are hidden. */
	async tags(principal: Principal, name: string): Promise<RegistryTagView[]> {
		const row = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'image:pull', { type: 'repository', id: row.id });
		const token = this.internalToken(name);
		const response = await this.transport()(this.registryUrl(`/v2/${name}/tags/list`), {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 404) return [];
		if (!response.ok) throw new CoreError('upstream', `The registry answered ${response.status}.`, 502);
		const body = (await response.json()) as { tags?: string[] | null };
		return (body.tags ?? [])
			.filter((tag) => !tag.startsWith(REGISTRY_PIN_TAG_PREFIX))
			.sort()
			.map((tag) => ({ tag, digest: null }));
	}

	/** Delete one tag (the manifest goes once nothing else points at it; GC frees the blobs). */
	async deleteTag(principal: Principal, name: string, tag: string): Promise<void> {
		const row = this.requireRepository(principal, name);
		this.ctx.iam.require(principal, 'image:delete', { type: 'repository', id: row.id });
		if (tag.startsWith(REGISTRY_PIN_TAG_PREFIX)) throw new ValidationError('Deployment pins are managed by Skiff.');
		const response = await this.transport()(this.registryUrl(`/v2/${name}/manifests/${encodeURIComponent(tag)}`), {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${this.internalToken(name, ['pull', 'delete'])}` },
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 404) throw new NotFoundError('Tag');
		if (!response.ok && response.status !== 202) throw new CoreError('upstream', `The registry answered ${response.status}.`, 502);
		this.ctx.audit.record({ principal, action: 'registry.tag.delete', resource: 'registryRepository', resourceId: name, args: { tag }, result: 'ok' });
	}

	/** For deploy-time digest pinning (R1): a bearer token when `image` is on this registry. */
	bearerForImage(orgId: string, image: string): string | null {
		const ref = parseImageReference(image);
		if (!ref || !this.enabled() || ref.registry !== this.host()) return null;
		const slug = ref.repository.split('/')[0]!;
		if (this.orgSlug(orgId) !== slug) return null;
		return this.internalToken(ref.repository);
	}

	/** Every registry repository name an org owns, for the project image picker. */
	orgSlugFor(orgId: string): string | null {
		return this.orgSlug(orgId);
	}
}
