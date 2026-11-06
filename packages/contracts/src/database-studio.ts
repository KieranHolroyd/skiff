/**
 * Native database studio (plan 22, D96). The control plane mints a per-user session; the node's
 * agent fronts an on-demand `skiff-studio` process that runs the engine plugin. The session
 * token reaches the node only in a request header and in the node-authenticated activation
 * fetch, never in desired state.
 */
import * as z from 'zod';
import {
	DATABASE_CONSOLE_DEFAULT_IDLE_MINUTES,
	DATABASE_CONSOLE_DEFAULT_TTL_MINUTES,
	DATABASE_CONSOLE_MAX_IDLE_MINUTES,
	DATABASE_CONSOLE_MAX_TTL_MINUTES,
	DATABASE_CONSOLE_MIN_IDLE_MINUTES,
	DATABASE_CONSOLE_MIN_TTL_MINUTES,
	databaseEngines,
} from './database.ts';

/** Loopback port the agent's studio front listens on, on every node. */
export const STUDIO_DEFAULT_PORT = 8083;
/** Internal host suffix the gateway matches for a node's studio (never public DNS). */
export const STUDIO_GATEWAY_SUFFIX = 'studio.internal';
/** Request headers the control plane adds on the gateway hop. Never sent by a browser. */
export const STUDIO_SESSION_HEADER = 'x-skiff-studio-session';
export const STUDIO_TOKEN_HEADER = 'x-skiff-studio-token';
/** Wire protocol version; both hops reject other versions. */
export const STUDIO_PROTOCOL_VERSION = 1;

/** The gateway host for one node's studio front. */
export function databaseStudioHost(nodeId: string): string {
	const label = nodeId.replace(/^node_/, '').toLowerCase().replace(/[^a-z0-9-]/g, '');
	return `n-${label}.${STUDIO_GATEWAY_SUFFIX}`;
}

export const studioSessionIdPattern = /^dss_[A-Za-z0-9]{16,40}$/;

export const databaseStudioOpenSchema = z.object({
	/**
	 * Read-only sessions connect as the read-only principal (plan 22 Phase 3) and run every
	 * statement in a read-only transaction. Write sessions need `database:update`.
	 */
	readOnly: z.boolean().default(true),
	ttlMinutes: z
		.number()
		.int()
		.min(DATABASE_CONSOLE_MIN_TTL_MINUTES)
		.max(DATABASE_CONSOLE_MAX_TTL_MINUTES)
		.default(DATABASE_CONSOLE_DEFAULT_TTL_MINUTES),
	idleMinutes: z
		.number()
		.int()
		.min(DATABASE_CONSOLE_MIN_IDLE_MINUTES)
		.max(DATABASE_CONSOLE_MAX_IDLE_MINUTES)
		.default(DATABASE_CONSOLE_DEFAULT_IDLE_MINUTES),
});
export type DatabaseStudioOpen = z.input<typeof databaseStudioOpenSchema>;

/** Per-session limits, enforced in the studio process (plan 22 "Safety and limits"). */
export const studioLimitsSchema = z.object({
	/** Rows per result set before `truncated: true`. */
	maxRows: z.number().int().min(1).max(10_000).default(1_000),
	/** Encoded bytes per response before `truncated: true`. */
	maxBytes: z.number().int().min(1_024).max(64 * 1_048_576).default(16 * 1_048_576),
	/** Server-side statement timeout. */
	statementTimeoutMs: z.number().int().min(100).max(600_000).default(30_000),
});
export type StudioLimits = z.infer<typeof studioLimitsSchema>;
export const DEFAULT_STUDIO_LIMITS: StudioLimits = studioLimitsSchema.parse({});

/** One user's studio session, as the dashboard sees it. Never carries the token. */
export interface DatabaseStudioView {
	sessionId: string | null;
	active: boolean;
	readOnly: boolean;
	/** ISO 8601. */
	expiresAt: string | null;
	idleMinutes: number;
	lastUsedAt: string | null;
	/** Dashboard path of the studio workspace. */
	path: string;
}

/**
 * What the agent receives from `GET /api/agent/database-studio/:sessionId` (node bearer plus
 * the session token). It holds the database credential, so it lives only in the agent's and the
 * studio process's memory.
 */
export const databaseStudioActivationSchema = z.object({
	v: z.literal(STUDIO_PROTOCOL_VERSION),
	sessionId: z.string().regex(studioSessionIdPattern),
	databaseId: z.string().min(1).max(100),
	engine: z.enum(databaseEngines),
	version: z.string().min(1).max(20),
	host: z.literal('127.0.0.1'),
	port: z.number().int().positive().max(65_535),
	/** Database (or Mongo auth database / Redis db index) to open. */
	database: z.string().min(1).max(100),
	user: z.string().min(1).max(100),
	password: z.string().min(1).max(500),
	/** TLS to the database; `caPem: null` means encrypt without pinning. */
	tls: z.object({ caPem: z.string().max(16_384).nullable() }).nullable(),
	readOnly: z.boolean(),
	limits: studioLimitsSchema,
	/** ISO 8601; the agent and studio process drop the session after this. */
	expiresAt: z.string().min(1).max(40),
});
export type DatabaseStudioActivation = z.infer<typeof databaseStudioActivationSchema>;

/** Desired state for a node's studio front. `null` means the front must not listen. */
export const nodeStudioDesiredSchema = z.object({
	port: z.number().int().positive().max(65_535),
	/** Session ids still live on this node; the agent drops any other cached session. */
	sessions: z.array(z.string().regex(studioSessionIdPattern)).max(500),
});
export type NodeStudioDesired = z.infer<typeof nodeStudioDesiredSchema>;
