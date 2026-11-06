import { and, desc, eq, isNull } from 'drizzle-orm';
import { databases, databaseStudioSessions } from '@skiff/db';
import {
	DATABASE_CONSOLE_DEFAULT_IDLE_MINUTES,
	DEFAULT_STUDIO_LIMITS,
	STUDIO_DEFAULT_PORT,
	STUDIO_PROTOCOL_VERSION,
	databaseStudioHost,
	databaseStudioOpenSchema,
	requirePermission,
	studioSessionIdPattern,
	type DatabaseEngine,
	type DatabaseStudioActivation,
	type DatabaseStudioView,
	type NodeStudioDesired,
	type Principal,
} from '@skiff/contracts';
import { featureEnabled } from './config.ts';
import type { CoreContext } from './context.ts';
import type { DatabaseRow } from './databases.ts';
import { ConflictError, CoreError, NotFoundError, ValidationError } from './errors.ts';
import { randomBytes, randomToken, safeEqual, sha256Hex } from './util.ts';

export type DatabaseStudioSessionRow = typeof databaseStudioSessions.$inferSelect;

export type DatabaseStudioActivity =
	| { op: 'run'; fingerprint: string; readOnly: boolean }
	| {
			op: 'apply';
			/** A dotted name, or the studio protocol's object ref (normalised to its dotted path). */
			object: string | { path: readonly string[]; kind: string };
			inserted: number;
			updated: number;
			deleted: number;
			applied: number;
	  };

export interface DatabaseStudioEndpoint {
	sessionId: string;
	token: string;
	host: string;
	nodeId: string;
	engine: DatabaseEngine;
	readOnly: boolean;
	expiresAt: string;
}

type CloseReason = 'closed' | 'mode-change' | 'moved' | 'expired' | 'idle' | 'deleted';

const SESSION_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
/** Last-used writes are coalesced so a busy grid does not write a row per request. */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * One alternation so comments inside strings (and quotes inside comments) are handled in a
 * single left-to-right pass: strings (single, double, Postgres dollar-quoted), comments, numbers.
 */
const FINGERPRINT_TOKENS =
	/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\/|\b0x[0-9a-f]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\.\d+\b/gi;

/**
 * A normalised hash of an editor input for the audit log (plan 22 "Audit", as plan 20 does):
 * literals become `?`, comments go, whitespace collapses and case folds. Raw input and values are
 * never stored. Double-quoted SQL identifiers fold to `?` too; that is coarser but never leaks a
 * Mongo or Redis value.
 */
export function studioFingerprint(input: string): string {
	const normalised = input
		.replace(FINGERPRINT_TOKENS, (token) => (token.startsWith('--') || token.startsWith('/*') ? ' ' : '?'))
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
	return sha256Hex(normalised).slice(0, 16);
}

function newSessionId(): string {
	const bytes = randomBytes(24);
	let out = 'dss_';
	for (const byte of bytes) out += SESSION_ALPHABET[byte % SESSION_ALPHABET.length];
	return out;
}

function requireInteractive(principal: Principal): void {
	if (principal.kind !== 'user')
		throw new CoreError('forbidden', 'The database studio needs an interactive user session.', 403);
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * Native database studio sessions (plan 22, D96). The control plane owns who may open what; the
 * node's agent front pulls the activation with the session token and never sees a credential in
 * desired state. Lifecycle audit keeps the DBGate `database.console.*` names.
 */
export class DatabaseStudioService {
	constructor(private readonly ctx: CoreContext) {}

	/** The caller's own session, or an inactive view. Never carries the token. */
	view(principal: Principal, name: string): DatabaseStudioView {
		requirePermission(principal, 'database:read');
		requirePermission(principal, 'database:console');
		const row = this.ctx.databases.requireRow(principal, name, { includeDeleted: true });
		return this.toView(row, this.openSessionOf(row.id, principal.userId));
	}

	/**
	 * Open (or extend) the caller's session. The same mode extends the window and keeps the token;
	 * a mode change closes the old session so a read-only token can never become writable.
	 */
	open(principal: Principal, name: string, raw: unknown = {}): DatabaseStudioView {
		requirePermission(principal, 'database:console');
		this.requireEnabled();
		requireInteractive(principal);
		const input = databaseStudioOpenSchema.parse(raw ?? {});
		if (!input.readOnly) requirePermission(principal, 'database:update');
		const row = this.ctx.databases.requireRow(principal, name, { includeDeleted: true });
		this.ctx.databases.assertStudioOpenable(row);

		const now = this.ctx.now();
		const expiresAt = now + input.ttlMinutes * 60_000;
		const idleMs = input.idleMinutes * 60_000;
		const auditArgs = { name, studio: 'native', readOnly: input.readOnly, ttlMinutes: input.ttlMinutes };
		let existing = this.openSessionOf(row.id, principal.userId);
		if (existing) {
			const lapsed = this.lapsed(existing, now);
			if (lapsed) {
				this.closeSession(existing, lapsed, now, row.name, undefined);
				existing = undefined;
			} else if (existing.nodeId !== row.nodeId) {
				this.closeSession(existing, 'moved', now, row.name, principal);
				existing = undefined;
			} else if (existing.readOnly !== input.readOnly) {
				this.closeSession(existing, 'mode-change', now, row.name, principal);
				existing = undefined;
			}
		}

		if (existing) {
			this.ctx.db
				.update(databaseStudioSessions)
				.set({ expiresAt, idleMs, lastUsedAt: now })
				.where(eq(databaseStudioSessions.id, existing.id))
				.run();
		} else {
			this.ctx.db
				.insert(databaseStudioSessions)
				.values({
					id: newSessionId(),
					databaseId: row.id,
					orgId: row.orgId,
					nodeId: row.nodeId,
					userId: principal.userId,
					tokenSealed: this.ctx.secrets.seal(row.orgId, randomToken(32)),
					readOnly: input.readOnly,
					expiresAt,
					idleMs,
					lastUsedAt: now,
					createdAt: now,
				})
				.run();
		}
		this.ctx.audit.record({
			principal,
			action: 'database.console.open',
			resource: 'database',
			resourceId: row.id,
			args: existing ? { ...auditArgs, extended: true } : auditArgs,
			result: 'ok',
		});
		// Desired state carries the live session ids and the node's gateway route.
		this.ctx.projects.bump(row.orgId);
		return this.toView(row, this.openSessionOf(row.id, principal.userId));
	}

	/** Close the caller's session now. Closing works with the flag off so nothing is stranded. */
	close(principal: Principal, name: string): DatabaseStudioView {
		requirePermission(principal, 'database:console');
		requireInteractive(principal);
		const row = this.ctx.databases.requireRow(principal, name, { includeDeleted: true });
		const existing = this.openSessionOf(row.id, principal.userId);
		if (existing) {
			this.closeSession(existing, 'closed', this.ctx.now(), row.name, principal);
			this.ctx.projects.bump(row.orgId);
		}
		return this.toView(row, undefined);
	}

	/**
	 * What the control-plane proxy needs to reach the caller's session through the gateway. The
	 * token is opened here and in `activation` only; views and audit stay token-free.
	 */
	endpoint(principal: Principal, name: string): DatabaseStudioEndpoint {
		requirePermission(principal, 'database:console');
		this.requireEnabled();
		// The studio is a human surface (D60). An API key must not reuse an open session.
		requireInteractive(principal);
		const row = this.ctx.databases.requireRow(principal, name);
		const session = this.openSessionOf(row.id, principal.userId);
		if (!session) throw new ConflictError('The database studio is not open. Open it first.');
		const now = this.ctx.now();
		const lapsed = this.lapsed(session, now);
		if (lapsed) {
			this.closeSession(session, lapsed, now, row.name, undefined);
			this.ctx.projects.bump(row.orgId);
			throw new ConflictError('The database studio session has expired. Open it again.');
		}
		// A role change after opening must not keep a writable session usable.
		if (!session.readOnly) requirePermission(principal, 'database:update');
		if (now - session.lastUsedAt >= TOUCH_INTERVAL_MS)
			this.ctx.db
				.update(databaseStudioSessions)
				.set({ lastUsedAt: now })
				.where(eq(databaseStudioSessions.id, session.id))
				.run();
		return {
			sessionId: session.id,
			token: this.ctx.secrets.open(session.orgId, session.tokenSealed),
			host: databaseStudioHost(session.nodeId),
			nodeId: session.nodeId,
			engine: row.engine,
			readOnly: session.readOnly,
			expiresAt: iso(session.expiresAt),
		};
	}

	/**
	 * Node-authenticated activation (`GET /api/agent/database-studio/:sessionId`). Answers only
	 * for a live session of a database on the calling node whose token matches.
	 */
	activation(nodeId: string, sessionId: string, token: string): DatabaseStudioActivation {
		if (!studioSessionIdPattern.test(sessionId)) throw new NotFoundError('Studio session');
		const session = this.ctx.db
			.select()
			.from(databaseStudioSessions)
			.where(eq(databaseStudioSessions.id, sessionId))
			.get();
		if (!session) throw new NotFoundError('Studio session');
		const row = this.ctx.db.select().from(databases).where(eq(databases.id, session.databaseId)).get();
		if (!row || row.deletedAt) throw new NotFoundError('Database');
		if (row.nodeId !== nodeId || session.nodeId !== nodeId)
			throw new CoreError('forbidden', 'This database is placed on another node.', 403);
		// Compare the token before revealing anything about the session's state.
		if (!safeEqual(this.ctx.secrets.open(session.orgId, session.tokenSealed), token))
			throw new CoreError('forbidden', 'The studio session token does not match.', 403);
		if (!featureEnabled(this.ctx.config, 'DB_STUDIO'))
			throw new ConflictError('The native database studio is disabled on this control plane.');
		if (session.closedAt !== null) throw new ConflictError('The database studio session is closed.');
		if (this.lapsed(session, this.ctx.now())) throw new ConflictError('The database studio session has expired.');

		const connection = this.ctx.databases.studioConnection(row);
		return {
			v: STUDIO_PROTOCOL_VERSION,
			sessionId: session.id,
			databaseId: row.id,
			engine: row.engine,
			version: row.version,
			host: '127.0.0.1',
			port: connection.hostPort,
			database: connection.database,
			user: connection.user,
			// INTERIM: every session connects as the owner until the read-only principal ships
			// (plan 22 Phase 3, helper `credentials/studio-readonly`). Read-only is enforced only
			// by the studio's session flags until then.
			password: connection.ownerPassword,
			tls: connection.tls,
			readOnly: session.readOnly,
			limits: DEFAULT_STUDIO_LIMITS,
			expiresAt: iso(session.expiresAt),
		};
	}

	/** The node's studio front: `null` (do not listen) when the flag is off. */
	desiredForNode(nodeId: string): NodeStudioDesired | null {
		if (!featureEnabled(this.ctx.config, 'DB_STUDIO')) return null;
		const sessions = this.liveSessions()
			.filter((session) => session.nodeId === nodeId)
			.map((session) => session.id)
			.sort()
			.slice(0, 500);
		return { port: this.port(), sessions };
	}

	/**
	 * One gateway route per node with a live session, mirroring `DatabaseService.gatewayForNode`:
	 * a node serves its own front on loopback, the edge proxies the rest to the node's address.
	 */
	gatewayRoutes(
		nodeId: string,
		isEdge: boolean,
		publicAddressOf: (nodeId: string) => string | null,
	): Array<{ host: string; upstream: string }> {
		if (!featureEnabled(this.ctx.config, 'DB_STUDIO')) return [];
		const nodeIds = new Set(this.liveSessions().map((session) => session.nodeId));
		const routes: Array<{ host: string; upstream: string }> = [];
		for (const target of nodeIds) {
			const host = databaseStudioHost(target);
			if (target === nodeId) routes.push({ host, upstream: `127.0.0.1:${this.port()}` });
			else if (isEdge) routes.push({ host, upstream: `http://${publicAddressOf(target) ?? '127.0.0.1:1'}` });
		}
		return routes.sort((a, b) => a.host.localeCompare(b.host));
	}

	/** Maintenance: close sessions that have expired or gone idle. Returns how many were closed. */
	tick(now = this.ctx.now()): number {
		const rows = this.ctx.db
			.select({ session: databaseStudioSessions, name: databases.name })
			.from(databaseStudioSessions)
			.innerJoin(databases, eq(databases.id, databaseStudioSessions.databaseId))
			.where(isNull(databaseStudioSessions.closedAt))
			.all();
		let closed = 0;
		for (const { session, name } of rows) {
			const lapsed = this.lapsed(session, now);
			if (!lapsed) continue;
			this.closeSession(session, lapsed, now, name, undefined);
			closed += 1;
		}
		if (closed > 0) this.ctx.projects.bump();
		return closed;
	}

	/**
	 * Audit one editor run or grid apply. Only a fingerprint and counts are recorded, never the
	 * statement or any value (plan 22 "Audit").
	 */
	recordActivity(principal: Principal, name: string, entry: DatabaseStudioActivity): void {
		requirePermission(principal, 'database:console');
		const row = this.ctx.databases.requireRow(principal, name);
		if (entry.op === 'run') {
			if (!FINGERPRINT_PATTERN.test(entry.fingerprint))
				throw new ValidationError('A studio run is audited by its fingerprint, not its text.');
			this.ctx.audit.record({
				principal,
				action: 'database.studio.run',
				resource: 'database',
				resourceId: row.id,
				args: { name, fingerprint: entry.fingerprint, readOnly: entry.readOnly },
				result: 'ok',
			});
			return;
		}
		this.ctx.audit.record({
			principal,
			action: 'database.studio.write',
			resource: 'database',
			resourceId: row.id,
			args: {
				name,
				object: (typeof entry.object === 'string' ? entry.object : entry.object.path.join('.')).slice(0, 200),
				...(typeof entry.object === 'string' ? {} : { kind: entry.object.kind }),
				inserted: entry.inserted,
				updated: entry.updated,
				deleted: entry.deleted,
				applied: entry.applied,
			},
			result: 'ok',
		});
	}

	/** Close every open session of a database (trash or delete). Returns how many were closed. */
	closeForDatabase(databaseId: string, reason: CloseReason, principal?: Principal): number {
		const name =
			this.ctx.db.select({ name: databases.name }).from(databases).where(eq(databases.id, databaseId)).get()?.name ??
			databaseId;
		const open = this.ctx.db
			.select()
			.from(databaseStudioSessions)
			.where(and(eq(databaseStudioSessions.databaseId, databaseId), isNull(databaseStudioSessions.closedAt)))
			.all();
		const now = this.ctx.now();
		for (const session of open) this.closeSession(session, reason, now, name, principal);
		if (open.length > 0) this.ctx.projects.bump(open[0]!.orgId);
		return open.length;
	}

	// ---------------------------------------------------------------- internals

	private requireEnabled(): void {
		if (!featureEnabled(this.ctx.config, 'DB_STUDIO'))
			throw new ConflictError('The native database studio is disabled on this control plane.');
	}

	private port(): number {
		return this.ctx.config.studioPort ?? STUDIO_DEFAULT_PORT;
	}

	private openSessionOf(databaseId: string, userId: string): DatabaseStudioSessionRow | undefined {
		return this.ctx.db
			.select()
			.from(databaseStudioSessions)
			.where(
				and(
					eq(databaseStudioSessions.databaseId, databaseId),
					eq(databaseStudioSessions.userId, userId),
					isNull(databaseStudioSessions.closedAt),
				),
			)
			.orderBy(desc(databaseStudioSessions.createdAt))
			.get();
	}

	/** Why an open session is no longer usable, or null while it is live. */
	private lapsed(session: DatabaseStudioSessionRow, now: number): 'expired' | 'idle' | null {
		if (session.expiresAt <= now) return 'expired';
		if (session.lastUsedAt + session.idleMs <= now) return 'idle';
		return null;
	}

	/** Open, unexpired sessions for databases that are not in the trash. */
	private liveSessions(): DatabaseStudioSessionRow[] {
		const now = this.ctx.now();
		return this.ctx.db
			.select({ session: databaseStudioSessions })
			.from(databaseStudioSessions)
			.innerJoin(databases, eq(databases.id, databaseStudioSessions.databaseId))
			.where(and(isNull(databaseStudioSessions.closedAt), isNull(databases.deletedAt)))
			.all()
			.map((item) => item.session)
			.filter((session) => this.lapsed(session, now) === null);
	}

	/**
	 * Close one session and audit it. Expiry and idle are `database.console.expired`; everything
	 * else is `database.console.close` with the reason. The caller bumps desired state.
	 */
	private closeSession(
		session: DatabaseStudioSessionRow,
		reason: CloseReason,
		now: number,
		name: string,
		principal: Principal | undefined,
	): void {
		this.ctx.db
			.update(databaseStudioSessions)
			.set({ closedAt: now, closeReason: reason })
			.where(eq(databaseStudioSessions.id, session.id))
			.run();
		const expired = reason === 'expired' || reason === 'idle';
		this.ctx.audit.record({
			...(principal ? { principal } : { orgId: session.orgId }),
			action: expired ? 'database.console.expired' : 'database.console.close',
			resource: 'database',
			resourceId: session.databaseId,
			args: { name, studio: 'native', readOnly: session.readOnly, reason },
			result: 'ok',
		});
	}

	private toView(row: DatabaseRow, session: DatabaseStudioSessionRow | undefined): DatabaseStudioView {
		const now = this.ctx.now();
		const active = session !== undefined && session.closedAt === null && this.lapsed(session, now) === null;
		return {
			sessionId: active ? session.id : null,
			active,
			readOnly: session?.readOnly ?? true,
			expiresAt: active ? iso(session.expiresAt) : null,
			idleMinutes: session
				? Math.max(1, Math.round(session.idleMs / 60_000))
				: DATABASE_CONSOLE_DEFAULT_IDLE_MINUTES,
			lastUsedAt: session ? iso(session.lastUsedAt) : null,
			path: `/databases/${encodeURIComponent(row.name)}/studio`,
		};
	}
}
