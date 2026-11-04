import { auditLog } from '@skiff/db';
import { desc, eq, and, gte, lte, type SQL } from 'drizzle-orm';
import { requirePermission, type Principal } from '@skiff/contracts';
import type { CoreContext } from './context.ts';
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
	 * Org audit entries. Pass `principal` from every user-facing surface: it requires `project:read`
	 * (API.md) and scopes the query to the principal's org. A bare `orgId` is for internal callers.
	 */
	list(
		options: {
			limit?: number;
			action?: string;
			resource?: string;
			from?: number;
			to?: number;
		} & ({ principal: Principal; orgId?: string } | { principal?: undefined; orgId: string }),
	) {
		let orgId = options.orgId!;
		if (options.principal) {
			requirePermission(options.principal, 'project:read');
			orgId = options.principal.orgId;
		}
		const filters: SQL[] = [eq(auditLog.orgId, orgId)];
		if (options.action) filters.push(eq(auditLog.action, options.action));
		if (options.resource) filters.push(eq(auditLog.resource, options.resource));
		if (options.from) filters.push(gte(auditLog.createdAt, options.from));
		if (options.to) filters.push(lte(auditLog.createdAt, options.to));
		return this.ctx.db
			.select()
			.from(auditLog)
			.where(and(...filters))
			.orderBy(desc(auditLog.createdAt))
			.limit(Math.min(options.limit ?? 50, 200))
			.all();
	}
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
