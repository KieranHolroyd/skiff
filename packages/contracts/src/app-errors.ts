import * as z from 'zod';

/**
 * App errors (docs/APP-ERRORS.md): the app-facing error tracker, Sentry-compatible at the ingest
 * edge and stored in Yoal's SQLite. Issues belong to a Yoal project; reads need `project:read`,
 * writes `project:update`.
 */

export const appErrorStatuses = ['unresolved', 'resolved', 'ignored'] as const;
export type AppErrorStatus = (typeof appErrorStatuses)[number];

export const appErrorLevels = ['fatal', 'error', 'warning', 'info', 'debug'] as const;
export type AppErrorLevel = (typeof appErrorLevels)[number];

/** The issue-list time window. `all` keeps quiet issues visible until retention removes them. */
export const appErrorRanges = ['24h', '7d', '30d', 'all'] as const;
export type AppErrorRange = (typeof appErrorRanges)[number];

export interface AppErrorFrameView {
	fn: string;
	file: string;
	line: number | null;
	column: number | null;
	inApp: boolean;
}

export interface AppErrorExceptionView {
	type: string;
	value: string;
	frames: AppErrorFrameView[];
}

export interface AppErrorEventView {
	id: string;
	issueId: string;
	/** The Sentry event id, 32 hex characters. */
	eventId: string;
	at: number;
	level: AppErrorLevel;
	message: string;
	exceptions: AppErrorExceptionView[];
	method: string | null;
	/** Path only: query strings are never stored. */
	path: string | null;
	release: string | null;
	environment: string | null;
	tags: Record<string, string>;
	/** Browser, OS and runtime only. */
	contexts: Record<string, string>;
	extra: unknown;
	userId: string | null;
	platform: string | null;
	sdk: string | null;
}

export interface AppErrorIssueView {
	id: string;
	projectId: string;
	platform: string;
	environment: string;
	/** The exception type, or `Message` for a message event. */
	name: string;
	message: string;
	/** Where it happened: the transaction, or the top in-app frame. */
	culprit: string | null;
	level: AppErrorLevel;
	status: AppErrorStatus;
	count: number;
	/** Events in the last 24 hours. */
	count24h: number;
	firstSeenAt: number;
	lastSeenAt: number;
	firstRelease: string | null;
	lastRelease: string | null;
	/** Set when a resolved issue happened again (it is unresolved now). */
	regressedAt: number | null;
	resolvedAt: number | null;
	resolvedBy: string | null;
}

export interface AppErrorSummary {
	unresolved: number;
	resolved: number;
	ignored: number;
	/** Events across every issue in the last 24 hours. */
	events24h: number;
}

export interface AppErrorListView {
	issues: AppErrorIssueView[];
	summary: AppErrorSummary;
	/** One bucket per hour for the last 24 hours, oldest first. */
	hourly: number[];
	/** Pass back as `before` for the next page; null on the last page. */
	nextBefore: number | null;
	/** Distinct environments seen in this project, most recent first. */
	environments: string[];
	/** Distinct releases seen in this project, most recent first. */
	releases: string[];
}

export interface AppErrorDetail {
	issue: AppErrorIssueView;
	events: AppErrorEventView[];
	/** Hourly counts for the last 24 hours, oldest first. */
	hourly: number[];
	/** Daily counts for the last 14 days, oldest first. */
	daily: number[];
}

export interface AppErrorUsageView {
	/** `YYYY-MM`. */
	month: string;
	accepted: number;
	dropped: number;
	ignored: number;
	/** Monthly accepted-event cap for the project. */
	limit: number;
}

export interface AppErrorSettingsView {
	enabled: boolean;
	/** `https://<public-key>@<origin>/ingest/<dsn-project-id>`, null until enabled. */
	dsn: string | null;
	publicKey: string | null;
	sampleRate: number;
	notify: boolean;
	usage: AppErrorUsageView;
}

export const appErrorListQuerySchema = z.object({
	status: z.enum([...appErrorStatuses, 'all']).default('unresolved'),
	environment: z.string().trim().max(40).optional(),
	release: z.string().trim().max(200).optional(),
	q: z.string().trim().max(200).optional(),
	range: z.enum(appErrorRanges).default('all'),
	before: z.coerce.number().int().positive().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AppErrorListQuery = z.input<typeof appErrorListQuerySchema>;

export const appErrorStatusUpdateSchema = z.object({
	ids: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
	status: z.enum(appErrorStatuses),
});
export type AppErrorStatusUpdate = z.infer<typeof appErrorStatusUpdateSchema>;

export const appErrorSettingsUpdateSchema = z.object({
	enabled: z.boolean().optional(),
	sampleRate: z.number().min(0).max(1).optional(),
	notify: z.boolean().optional(),
});
export type AppErrorSettingsUpdate = z.infer<typeof appErrorSettingsUpdateSchema>;

/** The default monthly cap; a policy can lower it later without a migration. */
export const APP_ERROR_MONTHLY_LIMIT = 100_000;
