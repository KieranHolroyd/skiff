import type { DatabasePitrRepoConfig, FeatureFlags, FeatureName } from '@skiff/contracts';
import { FEATURE_FLAGS, parseFeatureFlags, STUDIO_DEFAULT_PORT } from '@skiff/contracts';
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

export interface Notifier {
	name: string;
	notify(alert: { key: string; title: string; detail: string; severity: 'info' | 'warning' | 'critical' }): Promise<void>;
}

export interface CoreConfig {
	dataDir: string;
	/** Platform origin, e.g. `https://control.kieran.dev`. */
	platformOrigin: string;
	/** Content domain, e.g. `kierancloud.dev`. */
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
	desiredAgentVersion?: string;
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
	 * Loopback port of the edge's internal database gateway (Caddy). The control plane reaches an
	 * on-demand studio on any node through it (D60), mirroring the S3 gateway (D82).
	 */
	databaseGatewayPort?: number;
	/**
	 * Loopback port of every node's native studio front (plan 22). One fixed port per node, so the
	 * gateway needs one route per node rather than one per session.
	 */
	studioPort?: number;
	/** Largest object a single dashboard/API upload may send, in bytes (default 100 MiB). */
	storageObjectMaxBytes?: number;
	/** Injected S3 transport for tests; production uses the global fetch. */
	storageFetch?: typeof fetch;
	/** Injected GitHub API transport for tests (plan 21); production uses the global fetch. */
	githubFetch?: typeof fetch;
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

export function coreConfigFromEnv(overrides: Partial<CoreConfig> & Pick<CoreConfig, 'objectStore' | 'masterKey' | 'dataDir'>): CoreConfig {
	const env = process.env;
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
		edgeNodeId: overrides.edgeNodeId ?? env.SKIFF_EDGE_NODE_ID,
		storageGatewayPort:
			overrides.storageGatewayPort ?? positiveInteger(env.SKIFF_STORAGE_GATEWAY_PORT, 8081),
		databaseGatewayPort:
			overrides.databaseGatewayPort ?? positiveInteger(env.SKIFF_DATABASE_GATEWAY_PORT, 8082),
		studioPort: overrides.studioPort ?? positiveInteger(env.SKIFF_STUDIO_PORT, STUDIO_DEFAULT_PORT),
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

/** Per-project HMAC key for the agent's host-only cookie (never the platform session key). */
export function siteKeyFor(secret: string, projectId: string): string {
	return hmac(secret, `site-key:${projectId}`);
}
