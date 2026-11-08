import * as z from 'zod';

/**
 * Server errors (docs/SERVER-ERRORS.md, D171): the control plane's own built-in error tracker.
 * Platform admins see it under Settings → Server errors; `/api/v1/platform/errors` serves the same
 * views.
 */

/** Where an error was caught. */
export const serverErrorSources = ['request', 'api', 'response', 'background'] as const;
export type ServerErrorSource = (typeof serverErrorSources)[number];

export const serverErrorStatuses = ['unresolved', 'resolved', 'ignored'] as const;
export type ServerErrorStatus = (typeof serverErrorStatuses)[number];

export const serverErrorSourceLabels: Record<ServerErrorSource, string> = {
	request: 'Dashboard',
	api: 'REST API',
	response: '5xx response',
	background: 'Background',
};

export interface ServerErrorIssueView {
	id: string;
	source: ServerErrorSource;
	/** The error's class name (`TypeError`), or `HTTP 502` for a bare 5xx response. */
	name: string;
	message: string;
	/** Where it happened: the route id, the background task, or the top stack frame. */
	culprit: string | null;
	status: ServerErrorStatus;
	count: number;
	/** Events in the last 24 hours. */
	count24h: number;
	firstSeenAt: number;
	lastSeenAt: number;
	firstVersion: string | null;
	lastVersion: string | null;
	/** Set when a resolved issue happened again (it is unresolved now). */
	regressedAt: number | null;
	resolvedAt: number | null;
	resolvedBy: string | null;
}

export interface ServerErrorEventView {
	id: string;
	issueId: string;
	at: number;
	message: string;
	stack: string | null;
	method: string | null;
	/** Path only: query strings are never stored. */
	path: string | null;
	routeId: string | null;
	status: number | null;
	userId: string | null;
	orgId: string | null;
	version: string | null;
	/** Small, scrubbed extras (`task`, `requestId`, `principalKind`). */
	context: Record<string, string | number | boolean | null>;
}

export interface ServerErrorSummary {
	unresolved: number;
	resolved: number;
	ignored: number;
	/** Events across every issue in the last 24 hours. */
	events24h: number;
}

export interface ServerErrorListView {
	issues: ServerErrorIssueView[];
	summary: ServerErrorSummary;
	/** One bucket per hour for the last 24 hours, oldest first. */
	hourly: number[];
	/** Pass back as `before` for the next page; null on the last page. */
	nextBefore: number | null;
}

export const serverErrorListQuerySchema = z.object({
	status: z.enum([...serverErrorStatuses, 'all']).default('unresolved'),
	source: z.enum(serverErrorSources).optional(),
	q: z.string().trim().max(200).optional(),
	before: z.coerce.number().int().positive().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ServerErrorListQuery = z.input<typeof serverErrorListQuerySchema>;

export const serverErrorUpdateSchema = z.object({
	status: z.enum(serverErrorStatuses),
});
export type ServerErrorUpdate = z.infer<typeof serverErrorUpdateSchema>;
