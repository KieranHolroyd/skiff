import * as z from 'zod';

/**
 * Container images and registries (docs/REGISTRY.md).
 *
 * - Image references follow the Docker/containers-image normalisation: a first path segment with a
 *   `.` or `:` (or `localhost`) is a registry host, anything else is Docker Hub, and a single-name
 *   Docker Hub image lives under `library/`.
 * - Deploys pin a tag to its digest (R1): the node runs `<registry>/<repository>@sha256:…`, never a
 *   tag and digest together (containers/image refuses that combination).
 * - Registry credentials (R2) are org-owned, sealed, and reach a node only through the
 *   authenticated activation endpoint, as a per-workload `AuthFile=`.
 */

export const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const imageDigestSchema = z.string().regex(IMAGE_DIGEST_PATTERN, 'Expected sha256:<64 hex>');

export const DOCKER_HUB = 'docker.io';
/** Hostnames that all mean Docker Hub; stored and matched as `docker.io`. */
const DOCKER_HUB_ALIASES = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']);

export interface ImageReference {
	/** Registry host (and port), normalised: Docker Hub is `docker.io`. */
	registry: string;
	/** Repository path inside the registry, e.g. `library/nginx`. */
	repository: string;
	tag: string | null;
	digest: string | null;
}

const REGISTRY_HOST_PATTERN = /^(?:localhost|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::[0-9]{1,5})?$/;
const REPOSITORY_PATTERN = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Docker Hub aliases collapse to `docker.io`; every host is lowercase. */
export function normalizeRegistryHost(host: string): string {
	const lower = host.trim().toLowerCase();
	return DOCKER_HUB_ALIASES.has(lower) ? DOCKER_HUB : lower;
}

/** The host that serves the registry API for a normalised registry (`docker.io` has its own). */
export function registryApiHost(registry: string): string {
	return registry === DOCKER_HUB ? 'registry-1.docker.io' : registry;
}

/** Parse an image reference; null when it is not one. */
export function parseImageReference(input: string): ImageReference | null {
	const ref = input.trim();
	if (!ref || ref.length > 512 || /\s/.test(ref)) return null;
	let rest = ref;
	let digest: string | null = null;
	const at = rest.indexOf('@');
	if (at >= 0) {
		digest = rest.slice(at + 1);
		rest = rest.slice(0, at);
		if (!IMAGE_DIGEST_PATTERN.test(digest)) return null;
	}
	let tag: string | null = null;
	const lastSlash = rest.lastIndexOf('/');
	const colon = rest.lastIndexOf(':');
	if (colon > lastSlash) {
		tag = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
		if (!TAG_PATTERN.test(tag)) return null;
	}
	const firstSlash = rest.indexOf('/');
	let registry = DOCKER_HUB;
	let repository = rest;
	if (firstSlash > 0) {
		const first = rest.slice(0, firstSlash);
		if (first === 'localhost' || first.includes('.') || first.includes(':')) {
			registry = normalizeRegistryHost(first);
			repository = rest.slice(firstSlash + 1);
		}
	}
	if (!REGISTRY_HOST_PATTERN.test(registry)) return null;
	if (registry === DOCKER_HUB && !repository.includes('/')) repository = `library/${repository}`;
	if (!REPOSITORY_PATTERN.test(repository) || repository.length > 255) return null;
	return { registry, repository, tag, digest };
}

/** `registry/repository@digest`, the form a node runs once a deploy is pinned (R1). */
export function pinnedImageReference(image: string, digest: string): string {
	const parsed = parseImageReference(image);
	if (!parsed || !IMAGE_DIGEST_PATTERN.test(digest)) return image;
	return `${parsed.registry}/${parsed.repository}@${digest}`;
}

/**
 * Images that exist only in a node's local store (`localhost/…`, loaded with `podman load`). They
 * cannot be resolved against a registry, so a deploy runs them by tag, as before.
 */
export function isLocalImage(image: string): boolean {
	return parseImageReference(image)?.registry === 'localhost';
}

export const registryHostSchema = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(253)
	.regex(REGISTRY_HOST_PATTERN, 'Use a registry host such as ghcr.io or registry.example.com:5000')
	.refine((host) => host !== 'localhost', 'localhost images are never pulled, so they need no credential')
	.transform(normalizeRegistryHost);

export const REGISTRY_CREDENTIAL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const MAX_REGISTRY_CREDENTIALS_PER_ORG = 50;

export const registryCredentialCreateSchema = z.object({
	name: z
		.string()
		.trim()
		.regex(REGISTRY_CREDENTIAL_NAME_PATTERN, 'Use 3–40 lowercase letters, digits and dashes'),
	registry: registryHostSchema,
	username: z.string().trim().min(1).max(256),
	/** A password or access token (a GitHub PAT with `read:packages`, a Docker Hub token, …). */
	password: z.string().min(1).max(4096),
});
export type RegistryCredentialCreate = z.input<typeof registryCredentialCreateSchema>;

export const registryCredentialUpdateSchema = z
	.object({
		registry: registryHostSchema.optional(),
		username: z.string().trim().min(1).max(256).optional(),
		password: z.string().min(1).max(4096).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, 'Change at least one field');
export type RegistryCredentialUpdate = z.input<typeof registryCredentialUpdateSchema>;

export interface RegistryCredentialView {
	id: string;
	name: string;
	registry: string;
	username: string;
	createdAt: number;
	updatedAt: number;
	lastUsedAt: number | null;
}

/** One `auths` entry handed to the helper, which writes it into the workload's auth file. */
export const registryAuthEntrySchema = z.object({
	registry: z.string().min(1).max(253),
	username: z.string().min(1).max(256),
	password: z.string().min(1).max(4096),
});
export type RegistryAuthEntry = z.infer<typeof registryAuthEntrySchema>;
export const MAX_REGISTRY_AUTH_ENTRIES = 8;

// ------------------------------------------------------------------ the platform registry (G1)

export const REGISTRY_ENGINE = 'zot';
export const REGISTRY_VERSIONS = ['2.1.23'] as const;
export const REGISTRY_DEFAULT_VERSION = '2.1.23';
/** The tag the control plane sends; the helper runs only its own digest-pinned copy (D61). */
export const registryImageTag = (version: string) => `ghcr.io/project-zot/zot:v${version}`;
/** Workload ids of the registry carry this prefix. */
export const REGISTRY_ID_PREFIX = 'reg_';
/** Deployment pins (R11): kept by retention, hidden from lists, refused for user pushes. */
export const REGISTRY_PIN_TAG_PREFIX = 'skiff-d-';
/** Host loopback port the registry container publishes (CLUSTERING §4.3 range table). */
export const REGISTRY_DEFAULT_PORT = 15000;

/** Upstreams the registry can mirror on demand (G4); each lives under `<host>/<upstream>/…`. */
export const REGISTRY_MIRROR_UPSTREAMS = ['docker.io', 'ghcr.io', 'quay.io'] as const;
export type RegistryMirrorUpstream = (typeof REGISTRY_MIRROR_UPSTREAMS)[number];

/** The desired-state profile the helper renders zot from. Secrets arrive through activation. */
export const workloadRegistrySchema = z.object({
	engine: z.literal(REGISTRY_ENGINE),
	version: z.enum(REGISTRY_VERSIONS),
	/** Registry hostname: zot's token `service` and the JWT `aud`. */
	service: z.string().min(1).max(253),
	/** The control plane's token endpoint. */
	realm: z.string().url().max(512),
	keepTags: z.number().int().min(1).max(1000).default(20),
	/** G4: upstreams synced on demand into `<upstream>/…` repositories. */
	mirrors: z.array(z.enum(REGISTRY_MIRROR_UPSTREAMS)).max(3).default([]),
	/** G5: cosign/notation signature verification (keys uploaded by Skiff as the zot admin). */
	trust: z.boolean().default(false),
	/** G5: Trivy CVE scanning (downloads the vulnerability DB; local storage only). */
	cve: z.boolean().default(false),
	/** G6: blobs in an S3 bucket with a Redis/Valkey cache instead of the node's disk. */
	s3: z
		.object({ endpoint: z.string().min(1).max(255), bucket: z.string().min(3).max(63), region: z.string().min(1).max(64), secure: z.boolean() })
		.nullable()
		.default(null),
});
export type WorkloadRegistry = z.infer<typeof workloadRegistrySchema>;

export const registrySettingsUpdateSchema = z
	.object({
		enabled: z.boolean().optional(),
		/** Node name or id the registry runs on. */
		node: z.string().trim().min(1).max(100).optional(),
		/** Registry hostname, e.g. `registry.example.com`; must resolve to the ingress. */
		host: registryHostSchema.optional(),
		/** Tags kept per repository by push time; deployment pins are always kept. */
		keepTags: z.number().int().min(1).max(1000).optional(),
		memoryMb: z.number().int().min(128).max(4096).optional(),
		/** G4: pull-through cache for these upstreams; nodes pull them through the registry. */
		mirrors: z.array(z.enum(REGISTRY_MIRROR_UPSTREAMS)).max(3).optional(),
		/** G5: signature verification; `enforce` refuses deploys of unsigned own-registry images. */
		signatures: z.enum(['off', 'warn', 'enforce']).optional(),
		/** G5: cosign public keys (PEM) trusted for signatures. Replaces the list. */
		cosignKeys: z.array(z.string().trim().min(40).max(8192)).max(20).optional(),
		/** G5: Trivy CVE scanning (needs local storage). */
		cveScanning: z.boolean().optional(),
		/**
		 * G6: store blobs in S3 (any S3-compatible endpoint, e.g. a Skiff storage instance) with a
		 * Redis/Valkey cache, so the registry can move to another node without copying data.
		 * `null` returns to the node's disk (data is not migrated).
		 */
		s3: z
			.object({
				endpoint: z.string().trim().url().max(255),
				bucket: z.string().trim().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
				region: z.string().trim().min(1).max(64).default('us-east-1'),
				accessKeyId: z.string().trim().min(3).max(128),
				secretAccessKey: z.string().min(8).max(256),
				/** `redis://` or `rediss://` URL of the dedupe/metadata cache (a managed Valkey works). */
				cacheUrl: z.string().trim().regex(/^rediss?:\/\//, 'Use a redis:// or rediss:// URL').max(512),
			})
			.nullable()
			.optional(),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (input.cveScanning && input.s3)
			ctx.addIssue({ code: 'custom', path: ['cveScanning'], message: 'zot cannot scan for CVEs with S3 storage; turn one off.' });
	});
export type RegistrySettingsUpdate = z.input<typeof registrySettingsUpdateSchema>;

export interface RegistryView {
	enabled: boolean;
	/** Registry hostname clients push to and pull from. */
	host: string;
	node: { id: string; name: string } | null;
	status: string;
	engine: string;
	version: string;
	keepTags: number;
	memoryMb: number;
	/** The token endpoint (`WWW-Authenticate` realm). */
	realm: string;
	mirrors: RegistryMirrorUpstream[];
	signatures: 'off' | 'warn' | 'enforce';
	/** How many cosign keys are trusted, and whether they reached the registry yet. */
	cosignKeys: number;
	cosignKeysPending: boolean;
	cveScanning: boolean;
	/** S3 storage (endpoint and bucket only; credentials are never returned). */
	s3: { endpoint: string; bucket: string; region: string } | null;
}

/** A pull-through mirror a node configures in `registries.conf.d` (G4). */
export const registryMirrorDesiredSchema = z.object({
	host: z.string().min(1).max(253),
	upstreams: z.array(z.enum(REGISTRY_MIRROR_UPSTREAMS)).max(3),
});
export type RegistryMirrorDesired = z.infer<typeof registryMirrorDesiredSchema>;

export interface RegistryRepositoryView {
	/** `<org>/<name>`, as pushed. */
	name: string;
	projectSlug: string | null;
	pushes: number;
	lastTag: string | null;
	lastDigest: string | null;
	lastPushAt: number | null;
	createdAt: number;
	/** Sampled size of its images (hourly); 0 until the first sample. */
	bytes: number;
	/** Deploy on push: a push of `tag` deploys to `project`. */
	deploy: { project: string | null; tag: string } | null;
}

export const registryAutoDeploySchema = z
	.object({
		repository: z.string().min(3).max(255),
		/** Container project slug; null turns deploy on push off. */
		project: z.string().min(1).max(40).nullable(),
		tag: z.string().min(1).max(128).optional(),
	})
	.strict();
export type RegistryAutoDeployInput = z.input<typeof registryAutoDeploySchema>;

export interface RegistryTagView {
	tag: string;
	digest: string | null;
}

/** A deployment that pins one of a repository's digests, so retention keeps it (§6.2). */
export interface RegistryPinView {
	deploymentId: string;
	shortId: string;
	projectSlug: string | null;
	digest: string;
	status: 'pending' | 'active' | 'inactive' | 'failed' | 'deleted';
	/** The project's production deployment right now. */
	production: boolean;
	createdAt: number;
}

/** An org's sampled registry storage against its `registryBytes` quota (null: no limit). */
export interface RegistryUsageView {
	usedBytes: number;
	limitBytes: number | null;
}

/** Repository paths inside the org namespace: lowercase OCI path segments, at most three. */
export const REGISTRY_REPOSITORY_PATTERN = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*){1,3}$/;

// ------------------------------------------------------------- CI identities (G3: OIDC)

/** The Basic-auth username a GitHub Actions OIDC token is presented under. */
export const REGISTRY_GITHUB_OIDC_USER = 'github-oidc';
/** The Basic-auth username a GitLab CI ID token (`id_tokens`) is presented under (D178). */
export const REGISTRY_GITLAB_OIDC_USER = 'gitlab-oidc';
export const GITLAB_DEFAULT_ISSUER = 'https://gitlab.com';

export const registryOidcTrustCreateSchema = z
	.object({
		/** `github` (Actions OIDC) or `gitlab` (CI `id_tokens`, docs/FORGES.md §8). */
		provider: z.enum(['github', 'gitlab']).default('github'),
		/** The GitHub repository, `owner/repo`, exactly as the token's `repository` claim names it. */
		githubRepository: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'Use owner/repo')
			.optional(),
		/** The GitLab project path (`group/sub/project`), as the token's `project_path` claim names it. */
		gitlabProject: z
			.string()
			.trim()
			.max(512)
			.regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/, 'Use group/project')
			.optional(),
		/** GitLab instance that issues the tokens; https://gitlab.com when absent. */
		issuer: z
			.string()
			.trim()
			.max(512)
			.url()
			.refine((value) => value.startsWith('https://'), 'The issuer must be an https URL')
			.transform((value) => value.replace(/\/+$/, ''))
			.optional(),
		/** Optional glob on the token's `ref`: `refs/heads/main`, `refs/tags/*`. Absent = any ref. */
		ref: z.string().trim().min(1).max(255).optional(),
		/** `<org>/<name>` or `<org>/*` in your organisation's namespace. */
		repository: z.string().trim().min(3).max(255),
		/** Push as well as pull (default true). */
		push: z.boolean().default(true),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.provider === 'github' && !value.githubRepository)
			ctx.addIssue({ code: 'custom', path: ['githubRepository'], message: 'Enter the GitHub repository (owner/repo).' });
		if (value.provider === 'gitlab' && !value.gitlabProject)
			ctx.addIssue({ code: 'custom', path: ['gitlabProject'], message: 'Enter the GitLab project path (group/project).' });
		if (value.provider === 'github' && value.issuer)
			ctx.addIssue({ code: 'custom', path: ['issuer'], message: 'GitHub Actions has one issuer; leave it blank.' });
	});
export type RegistryOidcTrustCreate = z.input<typeof registryOidcTrustCreateSchema>;

export interface RegistryOidcTrustView {
	id: string;
	provider: 'github' | 'gitlab';
	/** The trusted repository (GitHub `owner/repo` or GitLab project path); named for GitHub for compatibility. */
	githubRepository: string;
	/** Same as `githubRepository`, under a provider-neutral name. */
	subject: string;
	/** Token issuer for GitLab trusts; null for GitHub. */
	issuer: string | null;
	ref: string | null;
	repository: string;
	push: boolean;
	createdAt: number;
}
