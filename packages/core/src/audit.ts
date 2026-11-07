import { auditLog } from '@skiff/db';
import { desc, eq, and, gte, lt, lte, or, type SQL } from 'drizzle-orm';
import { requirePermission, type Principal } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
import { ValidationError } from './errors.ts';
import { newId } from './util.ts';

export interface AuditInput {
	principal?: Principal;
	action: string;
	resource: string;
	resourceId?: string;
	args?: unknown;
	result: 'ok' | 'error';
	error?: string;
	orgId?: string;
	/** Set when the entry is one item of a mass operation (docs/OPERATIONS.md §7). */
	operationId?: string;
}

/** Every mutating surface writes here; MCP calls include the client id (DESIGN §6.3). */
export class AuditService {
	constructor(private readonly ctx: CoreContext) {}

	record(input: AuditInput): void {
		const principal = input.principal;
		this.ctx.db
			.insert(auditLog)
			.values({
				id: newId('aud_'),
				orgId: input.orgId ?? principal?.orgId ?? null,
				actorType:
					principal?.kind === 'apiKey'
						? 'apiKey'
						: principal?.kind === 'mcp'
							? 'mcp'
							: principal?.kind === 'system'
								? 'system'
								: 'user',
				actorId: principal?.userId ?? null,
				clientId: principal?.clientId ?? principal?.keyId ?? null,
				action: input.action,
				resource: input.resource,
				resourceId: input.resourceId ?? null,
				argsJson: input.args === undefined ? null : JSON.stringify(redact(input.args)),
				result: input.result,
				error: input.error ?? null,
				ipHash: principal?.ipHash ?? null,
				operationId: input.operationId ?? null,
			})
			.run();
	}

	/** Run a mutation and record both success and failure, keeping tool code clean. */
	async wrap<T>(input: Omit<AuditInput, 'result'>, fn: () => Promise<T> | T): Promise<T> {
		try {
			const value = await fn();
			this.record({ ...input, result: 'ok' });
			return value;
		} catch (error) {
			this.record({ ...input, result: 'error', error: (error as Error).message });
			throw error;
		}
	}

	/**
	 * Org audit entries, newest first. Pass `principal` from every user-facing surface: it requires
	 * `project:read` (API.md) and scopes the query to the principal's org. A bare `orgId` is for
	 * internal callers. `from` and `to` are inclusive epoch-millisecond bounds.
	 */
	list(options: AuditListOptions): AuditEntry[] {
		return this.page(options).entries;
	}

	/**
	 * One page of `list` plus the cursor for the next (older) page. The cursor is the last row's
	 * `(created_at, id)`, so paging is stable while new entries arrive at the top.
	 */
	page(options: AuditListOptions & { cursor?: string | null }): { entries: AuditEntry[]; nextCursor: string | null } {
		let orgId = options.orgId!;
		if (options.principal) {
			requirePermission(options.principal, 'project:read');
			orgId = options.principal.orgId;
		}
		if (options.from !== undefined && options.to !== undefined && options.from > options.to)
			throw new ValidationError('The start of the range is after its end.');
		const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50) || 50, MAX_AUDIT_PAGE));
		const filters: SQL[] = [eq(auditLog.orgId, orgId)];
		if (options.action) filters.push(eq(auditLog.action, options.action));
		if (options.resource) filters.push(eq(auditLog.resource, options.resource));
		if (options.from !== undefined) filters.push(gte(auditLog.createdAt, options.from));
		if (options.to !== undefined) filters.push(lte(auditLog.createdAt, options.to));
		if (options.cursor) {
			const after = decodeAuditCursor(options.cursor);
			filters.push(
				or(
					lt(auditLog.createdAt, after.createdAt),
					and(eq(auditLog.createdAt, after.createdAt), lt(auditLog.id, after.id)),
				)!,
			);
		}
		const rows = this.ctx.db
			.select()
			.from(auditLog)
			.where(and(...filters))
			.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
			.limit(limit + 1)
			.all();
		const entries = rows.slice(0, limit);
		const last = entries.at(-1);
		return {
			entries,
			nextCursor: rows.length > limit && last ? encodeAuditCursor(last.createdAt, last.id) : null,
		};
	}
}

export type AuditEntry = typeof auditLog.$inferSelect;

export type AuditListOptions = {
	limit?: number;
	action?: string;
	resource?: string;
	/** Inclusive lower bound, epoch ms. */
	from?: number;
	/** Inclusive upper bound, epoch ms. */
	to?: number;
} & ({ principal: Principal; orgId?: string } | { principal?: undefined; orgId: string });

/** A page holds at most this many entries; walk further with the cursor. */
export const MAX_AUDIT_PAGE = 200;

function encodeAuditCursor(createdAt: number, id: string): string {
	return Buffer.from(`${createdAt}.${id}`).toString('base64url');
}

function decodeAuditCursor(cursor: string): { createdAt: number; id: string } {
	const text = /^[A-Za-z0-9_-]{1,200}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString() : '';
	const match = /^(\d{1,16})\.(aud_[A-Za-z0-9_-]{1,64})$/.exec(text);
	if (!match) throw new ValidationError('That audit cursor is not valid. Start again without one.');
	return { createdAt: Number(match[1]), id: match[2]! };
}

/**
 * Parse a range bound from a query string or tool argument: epoch milliseconds, an ISO 8601
 * timestamp, or a calendar date (`2026-11-07`, UTC). A date as the upper bound means the end of
 * that day, so `from=2026-11-01&to=2026-11-07` covers seven whole days. Returns undefined for an
 * empty value and throws a ValidationError for anything else.
 */
export function parseAuditTime(value: string | number | null | undefined, bound: 'from' | 'to'): number | undefined {
	if (value === null || value === undefined || value === '') return undefined;
	if (typeof value === 'number' || /^\d{1,16}$/.test(value)) {
		const ms = Number(value);
		if (Number.isSafeInteger(ms) && ms >= 0) return ms;
	} else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const start = Date.parse(`${value}T00:00:00.000Z`);
		if (Number.isFinite(start)) return bound === 'to' ? start + 86_400_000 - 1 : start;
	} else if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return ms;
	}
	throw new ValidationError(`"${String(value)}" is not a date. Use 2026-11-07, an ISO timestamp or epoch milliseconds.`);
}

const SECRET_KEYS = /secret|password|token|key|authorization/i;
function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(entry);
		return out;
	}
	if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
	return value;
}
