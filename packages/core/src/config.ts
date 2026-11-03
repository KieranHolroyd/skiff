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
	};
}

/** Per-project HMAC key for the agent's host-only cookie (never the platform session key). */
export function siteKeyFor(secret: string, projectId: string): string {
	return hmac(secret, `site-key:${projectId}`);
}
