import { z } from 'zod';

/**
 * Log drains (DESIGN §8 "Logs"): forward stored log lines to an external endpoint.
 *
 * Two targets, both plain HTTPS so the control plane ships them with `fetch`:
 *  - `webhook`: NDJSON (one line object per line) or a JSON array, signed with HMAC-SHA256 in
 *    `X-Skiff-Signature` (the same scheme as the alert webhook).
 *  - `otlp`: OpenTelemetry OTLP/HTTP logs, JSON encoding (`/v1/logs`). Grafana Loki, Grafana Cloud,
 *    Datadog, Honeycomb, New Relic, Axiom, SigNoz and any OpenTelemetry Collector accept it, and
 *    the Collector can re-export to syslog, Splunk, Elasticsearch and the rest.
 *
 * Header values (API keys, `Authorization`) are write-only: sealed with the org key and never
 * returned. Views carry only the header names.
 */

export const logDrainKinds = ['webhook', 'otlp'] as const;
export type LogDrainKind = (typeof logDrainKinds)[number];

export const logDrainFormats = ['ndjson', 'json'] as const;
export type LogDrainFormat = (typeof logDrainFormats)[number];

/**
 * What a drain forwards. `build`, `runtime` and `system` are project log sources; `services` is
 * managed databases, object storage and brokers (org-wide drains only). Empty means all of them.
 */
export const logDrainSources = ['build', 'runtime', 'system', 'services'] as const;
export type LogDrainSource = (typeof logDrainSources)[number];

export const logDrainLevels = ['debug', 'info', 'warn', 'error'] as const;

/** At most this many drains per org: each one is a full copy of the org's log stream. */
export const MAX_LOG_DRAINS_PER_ORG = 10;
export const MAX_LOG_DRAIN_HEADERS = 10;

/** RFC 9110 token; the value is one printable line. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HEADER_VALUE = /^[\x20-\x7e]{1,4096}$/;
/** Headers Skiff sets itself (or the transport owns); a drain can't override them. */
const RESERVED_HEADERS = new Set([
	'host',
	'content-type',
	'content-length',
	'content-encoding',
	'transfer-encoding',
	'connection',
	'keep-alive',
	'upgrade',
	'te',
	'trailer',
	'user-agent',
]);

export function logDrainHeaderError(name: string, value: string): string | null {
	if (!HEADER_NAME.test(name)) return `"${name}" is not a valid header name.`;
	const lower = name.toLowerCase();
	if (RESERVED_HEADERS.has(lower) || lower.startsWith('x-skiff-')) return `${name} is set by Skiff and can't be overridden.`;
	if (!HEADER_VALUE.test(value)) return `The ${name} value must be one line of printable ASCII (at most 4096 characters).`;
	return null;
}

const headersSchema = z
	.record(z.string(), z.string())
	.superRefine((headers, ctx) => {
		const entries = Object.entries(headers);
		if (entries.length > MAX_LOG_DRAIN_HEADERS)
			ctx.addIssue({ code: 'custom', message: `At most ${MAX_LOG_DRAIN_HEADERS} headers.` });
		const seen = new Set<string>();
		for (const [name, value] of entries) {
			const error = logDrainHeaderError(name, value);
			if (error) ctx.addIssue({ code: 'custom', path: [name], message: error });
			if (seen.has(name.toLowerCase())) ctx.addIssue({ code: 'custom', path: [name], message: `${name} is listed twice.` });
			seen.add(name.toLowerCase());
		}
	});

/** Returns an error, or null for an acceptable drain URL. Network checks happen at delivery. */
export function logDrainUrlError(value: string, options: { allowHttp?: boolean } = {}): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return 'Enter a full URL, e.g. https://logs.example.com/ingest.';
	}
	if (value.length > 2048) return 'The URL is longer than 2048 characters.';
	if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:'))
		return options.allowHttp ? 'The URL must be http:// or https://.' : 'The URL must be https://.';
	if (url.username || url.password) return 'Put credentials in a header, not in the URL.';
	if (url.hash) return 'The URL must not have a #fragment.';
	return null;
}

const name = z.string().trim().min(1, 'Give the drain a name.').max(64);

export const logDrainCreateSchema = z
	.object({
		name,
		kind: z.enum(logDrainKinds),
		/** Webhook: the URL that receives POSTs. OTLP: the receiver; `/v1/logs` is added to a bare origin. */
		url: z.string().trim().min(1).max(2048),
		/** Webhook only: `ndjson` (default) or a `json` array. */
		format: z.enum(logDrainFormats).optional(),
		/** One project (slug); absent means every project in the org (and managed services). */
		project: z.string().trim().min(1).max(64).optional(),
		sources: z.array(z.enum(logDrainSources)).max(logDrainSources.length).default([]),
		/** Forward this level and above; absent forwards everything. */
		minLevel: z.enum(logDrainLevels).optional(),
		/** Sent with every request, e.g. `{ "Authorization": "Bearer …" }`. Write-only. */
		headers: headersSchema.optional(),
		/** Let the drain reach private, loopback and link-local addresses. Platform admins only. */
		allowPrivateNetwork: z.boolean().default(false),
		enabled: z.boolean().default(true),
	})
	.superRefine((input, ctx) => {
		const error = logDrainUrlError(input.url, { allowHttp: input.allowPrivateNetwork });
		if (error) ctx.addIssue({ code: 'custom', path: ['url'], message: error });
		if (input.kind === 'otlp' && input.format)
			ctx.addIssue({ code: 'custom', path: ['format'], message: 'OTLP drains always send OTLP/JSON; leave format out.' });
		if (input.project && input.sources.includes('services'))
			ctx.addIssue({ code: 'custom', path: ['sources'], message: 'A project drain has no managed-service logs; services is for org-wide drains.' });
	});
export type LogDrainCreate = z.input<typeof logDrainCreateSchema>;

export const logDrainUpdateSchema = z
	.object({
		name: name.optional(),
		url: z.string().trim().min(1).max(2048).optional(),
		format: z.enum(logDrainFormats).optional(),
		sources: z.array(z.enum(logDrainSources)).max(logDrainSources.length).optional(),
		/** `null` forwards every level again. */
		minLevel: z.enum(logDrainLevels).nullable().optional(),
		/** Replaces every header; `null` removes them all. Absent keeps the current ones. */
		headers: headersSchema.nullable().optional(),
		allowPrivateNetwork: z.boolean().optional(),
		/** Re-enabling resumes from now: lines logged while the drain was off are not sent. */
		enabled: z.boolean().optional(),
		/** Webhook only: issue a new signing secret (returned once). */
		rotateSigningSecret: z.boolean().optional(),
	})
	.refine((input) => Object.keys(input).length > 0, 'Nothing to change.');
export type LogDrainUpdate = z.input<typeof logDrainUpdateSchema>;

export type LogDrainStatus = 'healthy' | 'failing' | 'disabled' | 'pending';

export interface LogDrainView {
	id: string;
	name: string;
	kind: LogDrainKind;
	/** Query-string values are masked: a token there is a credential. */
	url: string;
	format: LogDrainFormat | null;
	projectId: string | null;
	/** Project slug, or null for an org-wide drain. */
	project: string | null;
	sources: LogDrainSource[];
	minLevel: (typeof logDrainLevels)[number] | null;
	/** Names only; values are write-only. */
	headerNames: string[];
	/** Webhook requests carry `X-Skiff-Signature`. */
	signed: boolean;
	allowPrivateNetwork: boolean;
	enabled: boolean;
	status: LogDrainStatus;
	delivery: {
		deliveredLines: number;
		deliveredBatches: number;
		/** Dead letters: lines in batches that were given up on (or that the receiver rejected). */
		droppedLines: number;
		droppedBatches: number;
		/** Consecutive failed attempts on the current batch. */
		attempts: number;
		nextAttemptAt: string | null;
		lastDeliveredAt: string | null;
		lastError: string | null;
		lastErrorAt: string | null;
		failingSince: string | null;
	};
	createdAt: string;
	updatedAt: string;
}

export interface LogDrainMutationResult {
	drain: LogDrainView;
	/** Webhook signing secret: present once, on create or rotation; never stored in a view. */
	signingSecret: string | null;
}

export interface LogDrainTestResult {
	ok: boolean;
	/** HTTP status, when the receiver answered. */
	status: number | null;
	message: string;
}
