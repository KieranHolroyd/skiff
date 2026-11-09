/**
 * The platform's OCI registry (docs/REGISTRY.md G1): zot, run by the helper like any managed
 * service (D61). The wire names only `engine` + `version` and a few validated settings; the helper
 * picks the digest-pinned image, writes zot's config itself and never takes an image, user or
 * mount from the control plane.
 *
 * Auth is the Docker token flow: zot answers 401 with `Bearer realm=<control plane>` and verifies
 * the ES256 tokens the control plane signs against the certificate in the activation.
 */

export class RegistryValidationError extends Error {}

export const REGISTRY_ENGINES = {
	zot: {
		versions: ['2.1.23'],
		/** zot's image has no user; it runs as this unprivileged uid/gid with a chowned data dir. */
		uid: 65532,
		gid: 65532,
		containerPort: 5000,
		images: {
			// Multi-arch index (linux/amd64 + linux/arm64), resolved 2026-11-08.
			'2.1.23': 'ghcr.io/project-zot/zot:v2.1.23@sha256:9d3de83ac2099e6f4843045b4c9b65b7e8baf40f92d28f54906dee9d4d390fd7',
		} as Record<string, string>,
		tag: (version: string) => `ghcr.io/project-zot/zot:v${version}`,
	},
} as const;
export type RegistryEngine = keyof typeof REGISTRY_ENGINES;

/** Registry workloads carry this id prefix; `purge` accepts it too. */
export const REGISTRY_ID_PREFIX = 'reg_';
/** Activation env names the helper turns into files, never container env. */
export const REGISTRY_CERT_ENV = 'YOAL_REGISTRY_TOKEN_CERT';
export const REGISTRY_EVENTS_ENV = 'YOAL_REGISTRY_EVENTS_URL';
/** G5: `yoal-admin:<bcrypt>`, the only zot user allowed to upload signing keys. */
export const REGISTRY_ADMIN_HTPASSWD_ENV = 'YOAL_REGISTRY_ADMIN_HTPASSWD';
/** G6: S3 credentials and the Redis/Valkey cache URL. */
export const REGISTRY_S3_ACCESS_KEY_ENV = 'YOAL_REGISTRY_S3_ACCESS_KEY';
export const REGISTRY_S3_SECRET_KEY_ENV = 'YOAL_REGISTRY_S3_SECRET_KEY';
export const REGISTRY_CACHE_URL_ENV = 'YOAL_REGISTRY_CACHE_URL';
export const REGISTRY_ADMIN_USER = 'yoal-admin';
export const REGISTRY_MIRROR_UPSTREAMS = ['docker.io', 'ghcr.io', 'quay.io'] as const;
export type RegistryMirrorUpstream = (typeof REGISTRY_MIRROR_UPSTREAMS)[number];
/** The upstream URL zot syncs each mirror from. */
const MIRROR_URLS: Record<RegistryMirrorUpstream, string> = {
	'docker.io': 'https://index.docker.io',
	'ghcr.io': 'https://ghcr.io',
	'quay.io': 'https://quay.io',
};
/** Where the helper-written config directory is mounted inside the container. */
export const REGISTRY_CONFIG_MOUNT = '/etc/zot';

export interface WorkloadRegistry {
	engine: RegistryEngine;
	version: string;
	/** The registry hostname clients use; zot's token `service` and the token `aud`. */
	service: string;
	/** The control plane's token endpoint (https, or http on a dev install). */
	realm: string;
	/** Retention: tags kept per repository by push time; `yoal-d-*` deployment pins are always kept. */
	keepTags: number;
	/** G4: upstreams mirrored on demand under `<upstream>/…`. */
	mirrors: RegistryMirrorUpstream[];
	/** G5: signature verification (trust extension + an htpasswd admin for key uploads). */
	trust: boolean;
	/** G5: Trivy CVE scanning. */
	cve: boolean;
	/** G6: S3 storage; credentials and the cache URL come from activation. */
	s3: { endpoint: string; bucket: string; region: string; secure: boolean } | null;
}

/** Activation secrets zot's config needs (never env). */
export interface RegistrySecrets {
	certificatePem: string;
	eventsUrl: string | null;
	adminHtpasswd: string | null;
	s3: { accessKey: string; secretKey: string; cacheUrl: string } | null;
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/;

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new RegistryValidationError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

export function parseRegistryProfile(value: unknown, label = 'workload.registry'): WorkloadRegistry {
	const raw = record(value, label);
	const engine = raw.engine;
	if (engine !== 'zot') throw new RegistryValidationError(`${label}.engine must be zot`);
	const version = raw.version;
	if (typeof version !== 'string' || !(REGISTRY_ENGINES.zot.versions as readonly string[]).includes(version))
		throw new RegistryValidationError(`${label}.version must be one of ${REGISTRY_ENGINES.zot.versions.join(', ')}`);
	const service = raw.service;
	if (typeof service !== 'string' || service.length > 253 || !HOST_PATTERN.test(service))
		throw new RegistryValidationError(`${label}.service must be a registry host`);
	const realm = raw.realm;
	let url: URL;
	try {
		url = new URL(String(realm));
	} catch {
		throw new RegistryValidationError(`${label}.realm must be a URL`);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new RegistryValidationError(`${label}.realm must be http(s)`);
	if (url.username || url.password || url.search || url.hash || String(realm).length > 512)
		throw new RegistryValidationError(`${label}.realm must be a plain URL`);
	const keepTags = raw.keepTags === undefined ? 20 : raw.keepTags;
	if (typeof keepTags !== 'number' || !Number.isInteger(keepTags) || keepTags < 1 || keepTags > 1000)
		throw new RegistryValidationError(`${label}.keepTags must be an integer from 1 to 1000`);
	const mirrors = raw.mirrors === undefined ? [] : raw.mirrors;
	if (!Array.isArray(mirrors) || mirrors.some((m) => !(REGISTRY_MIRROR_UPSTREAMS as readonly string[]).includes(m)) || new Set(mirrors).size !== mirrors.length)
		throw new RegistryValidationError(`${label}.mirrors must be distinct values of ${REGISTRY_MIRROR_UPSTREAMS.join(', ')}`);
	const flag = (name: 'trust' | 'cve') => {
		const value = raw[name];
		if (value === undefined) return false;
		if (typeof value !== 'boolean') throw new RegistryValidationError(`${label}.${name} must be a boolean`);
		return value;
	};
	let s3: WorkloadRegistry['s3'] = null;
	if (raw.s3 !== undefined && raw.s3 !== null) {
		const s3raw = record(raw.s3, `${label}.s3`);
		const endpoint = String(s3raw.endpoint ?? '');
		const bucket = String(s3raw.bucket ?? '');
		const region = String(s3raw.region ?? '');
		if (!HOST_PATTERN.test(endpoint)) throw new RegistryValidationError(`${label}.s3.endpoint must be host[:port]`);
		if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new RegistryValidationError(`${label}.s3.bucket is not a bucket name`);
		if (!/^[a-z0-9-]{1,64}$/.test(region)) throw new RegistryValidationError(`${label}.s3.region is not a region`);
		if (typeof s3raw.secure !== 'boolean') throw new RegistryValidationError(`${label}.s3.secure must be a boolean`);
		s3 = { endpoint, bucket, region, secure: s3raw.secure };
	}
	const cve = flag('cve');
	if (cve && s3) throw new RegistryValidationError('zot cannot scan for CVEs with S3 storage');
	return { engine, version, service, realm: url.toString(), keepTags, mirrors: mirrors as RegistryMirrorUpstream[], trust: flag('trust'), cve, s3 };
}

export function registryImage(registry: Pick<WorkloadRegistry, 'engine' | 'version'>): string {
	const image = REGISTRY_ENGINES[registry.engine].images[registry.version];
	if (!image) throw new RegistryValidationError(`No pinned image for ${registry.engine} ${registry.version}`);
	return image;
}

export function assertRegistryId(value: string, label = 'workload.id'): string {
	if (!value.startsWith(REGISTRY_ID_PREFIX) || value.length === REGISTRY_ID_PREFIX.length)
		throw new RegistryValidationError(`${label} must start with "${REGISTRY_ID_PREFIX}"`);
	return value;
}

/** The PEM certificate the tokens are verified with; nothing else is accepted. */
export function assertCertificatePem(value: string | undefined): string {
	const pem = (value ?? '').trim();
	if (!/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----$/.test(pem) || pem.length > 8192)
		throw new RegistryValidationError(`${REGISTRY_CERT_ENV} must be one PEM certificate`);
	return `${pem}\n`;
}

/** `yoal-admin:<bcrypt>`: one htpasswd line for the admin user, nothing else. */
export function assertAdminHtpasswd(value: string | undefined): string | null {
	if (!value) return null;
	if (!new RegExp(`^${REGISTRY_ADMIN_USER}:\\$2[aby]\\$\\d{2}\\$[./A-Za-z0-9]{53}$`).test(value))
		throw new RegistryValidationError(`${REGISTRY_ADMIN_HTPASSWD_ENV} must be one bcrypt htpasswd line for ${REGISTRY_ADMIN_USER}`);
	return `${value}\n`;
}

/** The push-event sink: a plain http(s) URL on the control plane, or none. */
export function assertEventsUrl(value: string | undefined): string | null {
	if (!value) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new RegistryValidationError(`${REGISTRY_EVENTS_ENV} must be a URL`);
	}
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || value.length > 512)
		throw new RegistryValidationError(`${REGISTRY_EVENTS_ENV} must be a plain http(s) URL`);
	return url.toString();
}

/**
 * zot's `config.json`. Docker-format manifests are accepted (`docker2s2`; `docker push` of an
 * image pulled from Docker Hub sends them). GC runs online with a one-hour grace; retention keeps
 * every `yoal-d-*` pin (deployments, R11) and the newest `keepTags` tags, and deletes untagged
 * manifests after a day.
 */
export function renderZotConfig(registry: WorkloadRegistry, secretsOrEventsUrl: RegistrySecrets | string | null): string {
	const secrets: RegistrySecrets =
		typeof secretsOrEventsUrl === 'object' && secretsOrEventsUrl !== null
			? secretsOrEventsUrl
			: { certificatePem: '', eventsUrl: secretsOrEventsUrl, adminHtpasswd: null, s3: null };
	const eventsUrl = secrets.eventsUrl;
	if (registry.s3 && !secrets.s3) throw new RegistryValidationError('S3 storage needs its credentials and cache URL');
	if (registry.trust && !secrets.adminHtpasswd) throw new RegistryValidationError('Signature verification needs the admin htpasswd');
	const config = {
		distSpecVersion: '1.1.1',
		storage: {
			rootDirectory: '/var/lib/registry',
			dedupe: true,
			...(registry.s3 && secrets.s3
				? {
						remoteCache: true,
						cacheDriver: { name: 'redis', url: secrets.s3.cacheUrl, keyprefix: 'zot' },
						storageDriver: {
							name: 's3',
							rootdirectory: '/zot',
							region: registry.s3.region,
							regionendpoint: registry.s3.endpoint,
							bucket: registry.s3.bucket,
							forcepathstyle: true,
							secure: registry.s3.secure,
							skipverify: false,
							accesskey: secrets.s3.accessKey,
							secretkey: secrets.s3.secretKey,
						},
					}
				: {}),
			gc: true,
			gcDelay: '1h',
			gcInterval: '24h',
			retention: {
				dryRun: false,
				delay: '24h',
				policies: [
					{
						repositories: ['**'],
						deleteReferrers: false,
						deleteUntagged: true,
						keepTags: [{ patterns: ['^yoal-d-.*'] }, { mostRecentlyPushedCount: registry.keepTags }],
					},
				],
			},
		},
		http: {
			address: '0.0.0.0',
			port: String(REGISTRY_ENGINES[registry.engine].containerPort),
			realm: 'yoal',
			compat: ['docker2s2'],
			auth: {
				bearer: { realm: registry.realm, service: registry.service, cert: `${REGISTRY_CONFIG_MOUNT}/cert.pem` },
				// G5: Yoal's admin login (Basic) for the signing-key upload routes, which bearer
				// tokens can never reach. Everyone else keeps using tokens.
				...(registry.trust ? { htpasswd: { path: `${REGISTRY_CONFIG_MOUNT}/htpasswd` } } : {}),
			},
			...(registry.trust
				? { accessControl: { adminPolicy: { users: [REGISTRY_ADMIN_USER], actions: ['read', 'create', 'update', 'delete'] }, repositories: {} } }
				: {}),
		},
		log: { level: 'info' },
		extensions: {
			search: { enable: true, ...(registry.cve ? { cve: { updateInterval: '24h' } } : {}) },
			...(registry.trust ? { trust: { enable: true, cosign: true, notation: true } } : {}),
			...(registry.mirrors.length
				? {
						sync: {
							enable: true,
							// With S3 storage, sync stages downloads on local disk first.
							...(registry.s3 ? { downloadDir: '/var/lib/registry/.sync' } : {}),
							registries: registry.mirrors.map((upstream) => ({
								urls: [MIRROR_URLS[upstream]],
								content: [{ prefix: '**', destination: `/${upstream}` }],
								onDemand: true,
								tlsVerify: true,
								maxRetries: 2,
								retryDelay: '5s',
							})),
						},
					}
				: {}),
			...(eventsUrl ? { events: { enable: true, sinks: [{ type: 'http', address: eventsUrl }] } } : {}),
		},
	};
	return `${JSON.stringify(config, null, 2)}\n`;
}
