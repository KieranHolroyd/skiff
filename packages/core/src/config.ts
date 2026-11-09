import type { DatabasePitrRepoConfig, FeatureFlags, FeatureName } from '@skiff/contracts';
import { CONTAINER_CONSOLE_DEFAULT_PORT, FEATURE_FLAGS, parseFeatureFlags, STUDIO_DEFAULT_PORT } from '@skiff/contracts';
import type { ObjectStore } from './object-store.ts';
import { hmac } from './util.ts';

export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

/** SES SMTP in v1 (D22); the interface keeps webhooks and future transports symmetric. */
export interface EmailTransport {
	send(message: EmailMessage): Promise<void>;
}

/**
 * What a notifier receives. `status`, `url` and `labels` are set by metric alert rules
 * (docs/ALERTS.md); system alerts leave them out, and a notifier may ignore them.
 */
export interface AlertMessage {
	key: string;
	title: string;
	detail: string;
	severity: 'info' | 'warning' | 'critical';
	/** `resolved` arrives with severity `info`. Absent means firing. */
	status?: 'firing' | 'resolved';
	/** Deep link to the alert in the dashboard. */
	url?: string;
	/** Series labels, e.g. `{ host: 'shop.example.com' }`. */
	labels?: Record<string, string>;
}

export interface Notifier {
	name: string;
	notify(alert: AlertMessage): Promise<void>;
}

export interface CoreConfig {
	dataDir: string;
	/** Platform origin, e.g. `https://control.example.com`. */
	platformOrigin: string;
	/** Content domain, e.g. `examplecloud.com`. */
	contentDomain: string;
	objectStore: ObjectStore;
	/** 32-byte master key for envelope encryption (systemd-creds in production). */
	masterKey: Uint8Array;
	/** HMAC secret for host-only site cookies; agents receive per-project derived keys. */
	siteCookieSecret: string;
	/** Secret used to sign local object-store URLs. */
	objectStoreSecret: string;
	/** Prevents duplicate deploys of the same artifact within one project. */
	dedupeWindowSeconds?: number;
	/** Agent version nodes should run: the control plane's own release version (D99). */
	desiredAgentVersion?: string;
	/** GitHub repository signed releases are published in (`owner/name`), for node updates (D99). */
	releaseRepo?: string;
	email?: EmailTransport;
	notifiers?: Notifier[];
	/** Injected clock for tests. */
	now?: () => number;
	/** The node that terminates ingress; the first registered node if unset. */
	edgeNodeId?: string;
	/**
	 * Loopback port of the edge's internal S3 gateway (Caddy). The control plane reaches every
	 * managed instance through it to browse and manage objects (D82).
	 */
	storageGatewayPort?: number;
	/**
	 * Full URL of the S3 gateway, overriding `http://127.0.0.1:<storageGatewayPort>`. For a dev
	 * control plane that does not share a host with the edge Caddy: point it at a node's Caddy
	 * listener (e.g. `http://192.168.0.9:8080`), which routes `s3-<id>.storage.internal` itself.
	 */
	storageGatewayUrl?: string;
	/**
	 * Loopback port of the edge's internal database gateway (Caddy). The control plane reaches an
	 * on-demand studio on any node through it (D60), mirroring the S3 gateway (D82).
	 */
	databaseGatewayPort?: number;
	/**
	 * Loopback port of every node's native studio front (plan 22). One fixed port per node, so the
	 * gateway needs one route per node rather than one per session.
	 */
	studioPort?: number;
	/** Loopback port of each node's container console front (D127, `SKIFF_CONTAINER_CONSOLE_PORT`). */
	containerConsolePort?: number;
	/** Largest object a single dashboard/API upload may send, in bytes (default 100 MiB). */
	storageObjectMaxBytes?: number;
	/** Injected S3 transport for tests; production uses the global fetch. */
	storageFetch?: typeof fetch;
	/** Injected GitHub API transport for tests (plan 21); production uses the global fetch. */
	githubFetch?: typeof fetch;
	/** Injected GitLab/Gitea/Forgejo API transport for tests (docs/FORGES.md); production uses the global fetch. */
	forgeFetch?: typeof fetch;
	/**
	 * Injected container-registry transport for deploy-time digest pinning (docs/REGISTRY.md R1).
	 * Production uses the global fetch; under `bun test` pinning is skipped unless this is set.
	 */
	registryFetch?: typeof fetch;
	/**
	 * Resolved `SKIFF_FEATURE_*` flags. Optional so existing tests and embedders keep working;
	 * services must read them through `featureEnabled`, which falls back to the registry defaults.
	 */
	features?: FeatureFlags;
	/**
	 * pgBackRest repository for PITR. Only used when `features.PITR` is on. Credentials stay in the
	 * control-plane process and are handed to a node through the authenticated activation endpoint,
	 * never through desired state or the SQLite index.
	 */
	pitrRepository?: DatabasePitrRepoConfig;
}

/**
 * The service-layer config: `overrides` first, then `SKIFF_*` environment variables (docs/OPS.md §2),
 * then defaults. The control plane builds its config through this, so every variable read here
 * reaches the running platform; pass `env` to resolve against something other than `process.env`.
 */
export function coreConfigFromEnv(
	overrides: Partial<CoreConfig> & Pick<CoreConfig, 'objectStore' | 'masterKey' | 'dataDir'>,
	env: Record<string, string | undefined> = process.env,
): CoreConfig {
	const platformOrigin = (overrides.platformOrigin ?? env.SKIFF_PLATFORM_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '');
	const contentDomain = overrides.contentDomain ?? env.SKIFF_CONTENT_DOMAIN ?? 'localhost';
	const siteCookieSecret =
		overrides.siteCookieSecret ?? env.SKIFF_SITE_COOKIE_SECRET ?? env.BETTER_AUTH_SECRET ?? 'dev-site-cookie-secret-change-me';
	const objectStoreSecret =
		overrides.objectStoreSecret ?? env.SKIFF_OBJECT_STORE_SECRET ?? env.BETTER_AUTH_SECRET ?? 'dev-object-store-secret-change-me';
	return {
		...overrides,
		platformOrigin,
		contentDomain,
		siteCookieSecret,
		objectStoreSecret,
		desiredAgentVersion: overrides.desiredAgentVersion ?? env.SKIFF_AGENT_VERSION ?? '0.1.0',
		releaseRepo: overrides.releaseRepo ?? env.SKIFF_REPO ?? 'KieranHolroyd/skiff',
		// The installer writes `SKIFF_EDGE_NODE_ID=` before enrolment; empty means unset.
		edgeNodeId: overrides.edgeNodeId ?? (env.SKIFF_EDGE_NODE_ID || undefined),
		storageGatewayPort:
			overrides.storageGatewayPort ?? positiveInteger(env.SKIFF_STORAGE_GATEWAY_PORT, 8081),
		storageGatewayUrl: overrides.storageGatewayUrl ?? (env.SKIFF_STORAGE_GATEWAY_URL?.replace(/\/+$/, '') || undefined),
		databaseGatewayPort:
			overrides.databaseGatewayPort ?? positiveInteger(env.SKIFF_DATABASE_GATEWAY_PORT, 8082),
		studioPort: overrides.studioPort ?? positiveInteger(env.SKIFF_STUDIO_PORT, STUDIO_DEFAULT_PORT),
		containerConsolePort:
			overrides.containerConsolePort ?? positiveInteger(env.SKIFF_CONTAINER_CONSOLE_PORT, CONTAINER_CONSOLE_DEFAULT_PORT),
		storageObjectMaxBytes:
			overrides.storageObjectMaxBytes ?? positiveInteger(env.SKIFF_STORAGE_OBJECT_MAX_BYTES, 104_857_600),
		features: overrides.features ?? parseFeatureFlags(env),
		pitrRepository: overrides.pitrRepository ?? pitrRepositoryFromEnv(env),
	};
}

/**
 * A complete pgBackRest repository from environment variables. Incomplete configuration returns
 * undefined: PITR then fails closed with a clear "repository not configured" error rather than
 * writing a half-valid config. Endpoint is optional (AWS S3); path-style defaults on because
 * RustFS/MinIO/Garage need it.
 */
function pitrRepositoryFromEnv(env: Record<string, string | undefined>): DatabasePitrRepoConfig | undefined {
	const bucket = env.SKIFF_PITR_REPO_BUCKET?.trim();
	const accessKeyId = env.SKIFF_PITR_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.SKIFF_PITR_SECRET_ACCESS_KEY?.trim();
	if (!bucket || !accessKeyId || !secretAccessKey) return undefined;
	return {
		kind: 's3',
		endpoint: env.SKIFF_PITR_REPO_ENDPOINT?.trim() || null,
		bucket,
		region: env.SKIFF_PITR_REPO_REGION?.trim() || 'us-east-1',
		pathPrefix: env.SKIFF_PITR_REPO_PREFIX?.trim() || 'skiff/pitr',
		forcePathStyle: !['0', 'false', 'off', 'no'].includes(
			(env.SKIFF_PITR_REPO_FORCE_PATH_STYLE ?? 'true').trim().toLowerCase(),
		),
		accessKeyId,
		secretAccessKey,
	};
}

/** Resolve a flag for a CoreConfig, using the registry default when no flags were injected. */
export function featureEnabled(config: Pick<CoreConfig, 'features'>, name: FeatureName): boolean {
	return config.features?.[name] ?? FEATURE_FLAGS[name].default;
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Per-project HMAC key for the agent's host-only cookie (never the platform session key).
 *
 * `epoch` is the project's visitor-session epoch: "sign out everyone" bumps it, which rotates the
 * key so every cookie and callback token signed under the old one stops verifying. Epoch 0 keeps
 * the original derivation, so cookies issued before epochs existed stay valid.
 *
 * A Skiff Access host passes its policy id and revocation version instead. Once the policy has been
 * revoked (`version > 0`) the key is derived from `(project, epoch, policy, version)`, so revoking
 * one policy leaves visitors on other policies for the same project signed in while "sign out
 * everyone" still rotates every key. Version 0 falls back to the project epoch, preserving cookies
 * issued before per-policy versions existed.
 */
export interface SiteKeyPolicy {
	id: string;
	version: number;
}

export function siteKeyFor(
	secret: string,
	projectId: string,
	epoch = 0,
	policy?: SiteKeyPolicy | null,
): string {
	if (policy && policy.version > 0)
		return hmac(secret, `site-key:${projectId}:${epoch}:policy:${policy.id}:${policy.version}`);
	return hmac(secret, epoch > 0 ? `site-key:${projectId}:${epoch}` : `site-key:${projectId}`);
}
