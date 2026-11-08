/**
 * Email, Skiff's self-hosted SES (docs/EMAIL.md, D114–D120): the wire types the CLI reads, and
 * pure parsing and formatting for `skif email`. Types mirror `packages/contracts/src/email.ts`
 * under the same names; the CLI bundle stays free of runtime dependencies (D40), so keep them in
 * sync.
 */
import { UsageError } from './errors.ts';
import { formatTime, renderTable, truncate } from './output.ts';

// --- mirrored from @skiff/contracts -----------------------------------------------------------

/** Mirrors `EMAIL_MAX_RECIPIENTS` in @skiff/contracts. The server validates. */
export const EMAIL_MAX_RECIPIENTS = 50;
/** Mirrors `EMAIL_MAX_TAGS` in @skiff/contracts. */
export const EMAIL_MAX_TAGS = 10;
/** Mirrors `EMAIL_REPUTATION` in @skiff/contracts (rates are fractions). */
export const EMAIL_REPUTATION = {
	minMessages: 200,
	bounceWarn: 0.04,
	bouncePause: 0.08,
	complaintWarn: 0.001,
	complaintPause: 0.003,
} as const;
/** Reasons a person may add by hand; `bounce` and `complaint` come from delivery events. */
export const MANUAL_SUPPRESSION_REASONS = ['manual', 'unsubscribe'] as const;
export const DEFAULT_EMAIL_ENV_PREFIX = 'SMTP';

export type EmailOrgState = 'sandbox' | 'active' | 'paused';
export type EmailSuppressionReason = 'bounce' | 'complaint' | 'manual' | 'unsubscribe';
export type EmailDomainStatus = 'pending' | 'verified' | 'failed';
export type EmailEventKind =
	| 'accepted'
	| 'delivered'
	| 'deferred'
	| 'bounced'
	| 'complained'
	| 'rejected'
	| 'suppressed'
	| 'received'
	| 'dropped';

export interface EmailRecordCheck {
	purpose: 'dkim' | 'spf' | 'dmarc' | 'mx';
	type: 'TXT' | 'MX' | 'CNAME';
	name: string;
	value: string;
	priority?: number;
	required: boolean;
	ok: boolean;
	found: string[];
	managed: boolean;
	note: string | null;
}

export interface EmailDomainView {
	id: string;
	name: string;
	status: EmailDomainStatus;
	sending: boolean;
	receiving: boolean;
	dkimSelector: string;
	records: EmailRecordCheck[];
	lastCheckedAt: string | null;
	verifiedAt: string | null;
	failingSince: string | null;
	createdAt: string;
}

export type EmailRecipient = string | { name?: string; address: string };

export interface EmailSendInput {
	from: EmailRecipient;
	to?: EmailRecipient[];
	cc?: EmailRecipient[];
	bcc?: EmailRecipient[];
	replyTo?: EmailRecipient[];
	subject?: string;
	text?: string;
	html?: string;
	headers?: Record<string, string>;
	tags?: Record<string, string>;
	idempotencyKey?: string;
}

export interface EmailSendResult {
	id: string;
	accepted: string[];
	suppressed: string[];
}

export interface EmailMessageRecipientView {
	address: string;
	status: EmailEventKind;
	lastResponse: string | null;
	updatedAt: string;
}

export interface EmailMessageView {
	id: string;
	from: string;
	subject: string;
	projectId: string | null;
	source: 'api' | 'smtp' | 'binding';
	tags: Record<string, string>;
	status: EmailEventKind;
	recipients: EmailMessageRecipientView[];
	createdAt: string;
}

/** One delivery event, when `GET /email/messages/:id` includes them. Every field but kind is optional. */
export interface EmailMessageEvent {
	kind: string;
	at?: string;
	recipient?: string | null;
	response?: string | null;
	remoteHost?: string | null;
	bounceClass?: string | null;
	attempt?: number;
}

export interface EmailSuppressionView {
	address: string;
	reason: EmailSuppressionReason;
	messageId: string | null;
	createdAt: string;
}

export interface EmailCredentialView {
	id: string;
	name: string;
	username: string;
	projectId: string | null;
	projectSlug: string | null;
	allowedFromDomains: string[];
	lastUsedAt: string | null;
	createdAt: string;
}

export interface EmailCredentialSecret extends EmailCredentialView {
	password: string;
	smtp: { host: string; port: number; secure: 'starttls' | 'tls' };
}

export interface EmailOrgView {
	state: EmailOrgState;
	perSecond: number;
	perDay: number;
	sentToday: number;
	bounceRate: number | null;
	complaintRate: number | null;
	windowMessages: number;
	pausedReason: string | null;
}

/** Platform mail settings; only platform admins get them (null otherwise). */
export interface EmailSettingsView {
	nodeId?: string | null;
	paused?: boolean;
	mailDomain?: string;
	hostnames?: { submission?: string; mx?: string; bounce?: string };
}

export interface EmailDomainCreateInput {
	name: string;
	sending?: boolean;
	autoDns?: boolean;
}

export interface EmailCredentialCreateInput {
	name: string;
	project?: string;
	allowedFromDomains?: string[];
}

/** A sandbox recipient (EMAIL.md §4.3); mirrors `EmailSandboxAddressView`. */
export interface EmailSandboxAddressView {
	id: string;
	address: string;
	status: 'pending' | 'verified';
	verifiedAt: string | null;
	sentAt: string | null;
	expiresAt: string | null;
	createdAt: string;
}

export type EmailAccessRequestStatus = 'pending' | 'approved' | 'denied';

/** A request to leave the sandbox (EMAIL.md §7.3); mirrors `EmailAccessRequestView`. */
export interface EmailAccessRequestView {
	id: string;
	orgId: string;
	orgName: string | null;
	status: EmailAccessRequestStatus;
	useCase: string;
	expectedDailyVolume: number;
	website: string | null;
	requestedBy: { id: string; email: string | null };
	decidedBy: string | null;
	decidedAt: string | null;
	note: string | null;
	perDay: number | null;
	perSecond: number | null;
	createdAt: string;
}

/** Mirrors `emailAccessRequestCreateSchema` in @skiff/contracts. The server validates. */
export interface EmailAccessRequestInput {
	useCase: string;
	expectedDailyVolume: number;
	website?: string;
}

/** Mirrors `emailEnvNames` in @skiff/contracts (EMAIL.md §5.4). */
export function emailEnvNames(prefix: string): string[] {
	return ['HOST', 'PORT', 'SECURE', 'USER', 'PASSWORD', 'URL'].map((suffix) => `${prefix}_${suffix}`);
}

// --- response unwrapping ------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** A list endpoint answers either a bare array or `{ <key>: [...] }` (the brokers convention). */
export function listFrom<T>(raw: unknown, key: string): T[] {
	if (Array.isArray(raw)) return raw as T[];
	const value = asRecord(raw)?.[key];
	return (Array.isArray(value) ? value : []) as T[];
}

/**
 * A single-view endpoint answers either the view or `{ <key>: view }`. `field` is a property the
 * view must have, so a protocol mismatch fails clearly instead of printing `undefined`.
 */
export function viewFrom<T>(raw: unknown, key: string, field: string): T | null {
	const record = asRecord(raw);
	const wrapped = asRecord(record?.[key]);
	if (wrapped && field in wrapped) return wrapped as T;
	if (record && field in record) return record as T;
	return null;
}

// --- argument parsing -------------------------------------------------------------------------

/** `--to a@x.com,b@y.com --to c@z.com` → three addresses, trimmed, empties dropped. */
export function parseAddressList(values: string[]): string[] {
	return values
		.flatMap((value) => value.split(','))
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

/** `--tag k=v` (repeatable) → `{ k: 'v' }`. */
export function parseTags(values: string[]): Record<string, string> {
	const tags: Record<string, string> = {};
	for (const value of values) {
		const equals = value.indexOf('=');
		if (equals <= 0) throw new UsageError(`--tag expects key=value, got "${value}".`);
		const key = value.slice(0, equals);
		if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key))
			throw new UsageError(`Tag key "${key}" may use letters, digits, "_", "." and "-" (at most 64).`);
		tags[key] = value.slice(equals + 1);
	}
	if (Object.keys(tags).length > EMAIL_MAX_TAGS) throw new UsageError(`At most ${EMAIL_MAX_TAGS} tags.`);
	return tags;
}

// --- formatting --------------------------------------------------------------------------------

const check = (ok: boolean) => (ok ? '✓' : '✗');

function percent(rate: number | null, digits = 1): string {
	return rate === null ? '-' : `${(rate * 100).toFixed(digits)}%`;
}

export function emailDomainTable(domains: EmailDomainView[]): string {
	const rows = domains.map((domain) => {
		const required = domain.records.filter((record) => record.required);
		return [
			domain.name,
			domain.status,
			domain.sending ? 'yes' : 'no',
			`${required.filter((record) => record.ok).length}/${required.length}`,
			formatTime(domain.lastCheckedAt ?? undefined),
			formatTime(domain.createdAt),
		];
	});
	return renderTable(['DOMAIN', 'STATUS', 'SENDING', 'RECORDS OK', 'CHECKED', 'CREATED'], rows);
}

/**
 * The DNS records to paste into a DNS provider. VALUE is last and never truncated: DKIM keys are
 * long, and a clipped value is useless.
 */
export function emailRecordsTable(records: EmailRecordCheck[]): string {
	const rows = records.map((record) => [
		record.purpose.toUpperCase(),
		record.type === 'MX' && record.priority !== undefined ? `MX ${record.priority}` : record.type,
		record.name,
		record.required ? 'required' : 'recommended',
		check(record.ok),
		[record.managed ? 'managed by Skiff' : null, record.note].filter(Boolean).join('; ') || '-',
		record.value,
	]);
	return renderTable(['PURPOSE', 'TYPE', 'NAME', 'REQUIRED', 'OK', 'NOTE', 'VALUE'], rows);
}

/** Records that still need attention, with what public DNS returned. */
export function failingRecords(records: EmailRecordCheck[]): string[] {
	return records
		.filter((record) => !record.ok)
		.map(
			(record) =>
				`${record.purpose.toUpperCase()} ${record.name}: ${record.found.length ? `found ${record.found.map((value) => truncate(value, 60)).join(' | ')}` : 'not found'}`,
		);
}

/** The `skif email domains info|check` report. */
export function emailDomainDetails(domain: EmailDomainView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('Domain', domain.name);
	field('Status', domain.status);
	field('Sending', domain.sending ? 'on' : 'off');
	field('Receiving', domain.receiving ? 'on' : 'off');
	field('DKIM', domain.dkimSelector);
	field('Checked', formatTime(domain.lastCheckedAt ?? undefined));
	if (domain.verifiedAt) field('Verified', formatTime(domain.verifiedAt));
	if (domain.failingSince) field('Failing', `since ${formatTime(domain.failingSince)}`);
	field('Created', formatTime(domain.createdAt));
	lines.push('');
	lines.push(domain.records.length ? emailRecordsTable(domain.records) : 'No DNS records yet.');
	const failing = failingRecords(domain.records);
	if (failing.length > 0) lines.push('', 'Not matching yet:', ...failing.map((line) => `  ${line}`));
	return lines.join('\n');
}

function recipientSummary(message: EmailMessageView, max = 40): string {
	const [first, ...rest] = message.recipients.map((recipient) => recipient.address);
	if (!first) return '-';
	return truncate(rest.length ? `${first} +${rest.length}` : first, max);
}

export function emailMessageTable(messages: EmailMessageView[]): string {
	const rows = messages.map((message) => [
		message.id,
		message.status,
		truncate(message.from, 32),
		recipientSummary(message),
		truncate(message.subject || '(no subject)', 40),
		formatTime(message.createdAt),
	]);
	return renderTable(['ID', 'STATUS', 'FROM', 'TO', 'SUBJECT', 'CREATED'], rows);
}

/** One line per message for `skif email log --follow`. */
export function emailMessageLine(message: EmailMessageView): string {
	return [
		formatTime(message.createdAt),
		message.id,
		message.status.padEnd(10),
		`${message.from} → ${recipientSummary(message, 60)}`,
		truncate(message.subject || '(no subject)', 60),
	].join('  ');
}

/** The `skif email log <id>` report: the message, then each recipient's state and events. */
export function emailMessageDetails(message: EmailMessageView, events: EmailMessageEvent[] = []): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(8)}  ${value}`);
	field('Message', message.id);
	field('Status', message.status);
	field('From', message.from);
	field('Subject', message.subject || '(no subject)');
	field('Source', message.source);
	const tags = Object.entries(message.tags ?? {});
	if (tags.length) field('Tags', tags.map(([key, value]) => `${key}=${value}`).join(', '));
	field('Created', formatTime(message.createdAt));
	lines.push('', 'Recipients:');
	lines.push(
		renderTable(
			['ADDRESS', 'STATUS', 'UPDATED', 'RESPONSE'],
			message.recipients.map((recipient) => [
				recipient.address,
				recipient.status,
				formatTime(recipient.updatedAt),
				recipient.lastResponse ? truncate(recipient.lastResponse, 80) : '-',
			]),
		),
	);
	if (events.length > 0) {
		lines.push('', 'Timeline:');
		const sorted = [...events].sort((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''));
		lines.push(
			renderTable(
				['TIME', 'EVENT', 'RECIPIENT', 'DETAIL'],
				sorted.map((event) => [
					formatTime(event.at),
					event.kind,
					event.recipient ?? '-',
					truncate(
						[event.bounceClass, event.remoteHost, event.response].filter(Boolean).join(' · ') || '-',
						80,
					),
				]),
			),
		);
	}
	return lines.join('\n');
}

export function emailSuppressionTable(suppressions: EmailSuppressionView[]): string {
	return renderTable(
		['ADDRESS', 'REASON', 'MESSAGE', 'ADDED'],
		suppressions.map((item) => [item.address, item.reason, item.messageId ?? '-', formatTime(item.createdAt)]),
	);
}

export function emailCredentialTable(credentials: EmailCredentialView[]): string {
	return renderTable(
		['ID', 'NAME', 'USERNAME', 'PROJECT', 'FROM DOMAINS', 'LAST USED', 'CREATED'],
		credentials.map((item) => [
			item.id,
			truncate(item.name, 30),
			item.username,
			item.projectSlug ?? (item.projectId ? item.projectId : 'org-wide'),
			item.allowedFromDomains.length ? truncate(item.allowedFromDomains.join(', '), 30) : 'any',
			formatTime(item.lastUsedAt ?? undefined),
			formatTime(item.createdAt),
		]),
	);
}

/** The once-only credential printout for `skif email credentials create`. */
export function emailCredentialSecretDetails(secret: EmailCredentialSecret): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(9)}  ${value}`);
	field('ID', secret.id);
	field('Name', secret.name);
	field('Username', secret.username);
	field('Password', secret.password);
	field('Host', secret.smtp.host);
	field('Port', `${secret.smtp.port} (${secret.smtp.secure === 'tls' ? 'implicit TLS' : 'STARTTLS'})`);
	field('Scope', secret.projectSlug ? `project ${secret.projectSlug}` : 'org-wide');
	if (secret.allowedFromDomains.length) field('From', secret.allowedFromDomains.join(', '));
	lines.push('', 'Store the password now: it is shown only once. The same credential works as a Bearer token for');
	lines.push('POST /api/v1/email/send.');
	return lines.join('\n');
}

function rateLine(rate: number | null, warn: number, pause: number, digits: number): string {
	if (rate === null) return '-';
	const flag = rate >= pause ? ' (over the pause threshold)' : rate >= warn ? ' (over the warning threshold)' : '';
	return `${percent(rate, digits)}${flag}  (warn ${percent(warn, digits)}, pause ${percent(pause, digits)})`;
}

const stateNotes: Record<EmailOrgState, string> = {
	sandbox: 'only to your own verified domains and sandbox recipients; `skif email request-access` to leave it',
	active: 'sending to anyone',
	paused: 'every send is refused until a platform admin resumes the org',
};

/** Whether a pending address's link has run out (`now` in ms, for tests). */
function linkExpired(address: EmailSandboxAddressView, now: number): boolean {
	return address.expiresAt !== null && Date.parse(address.expiresAt) <= now;
}

export function emailAddressTable(addresses: EmailSandboxAddressView[], now = Date.now()): string {
	return renderTable(
		['ADDRESS', 'STATUS', 'VERIFIED', 'LINK EXPIRES', 'ADDED'],
		addresses.map((item) => [
			item.address,
			item.status === 'pending' && linkExpired(item, now) ? 'link expired' : item.status,
			formatTime(item.verifiedAt ?? undefined),
			item.status === 'pending' ? formatTime(item.expiresAt ?? undefined) : '-',
			formatTime(item.createdAt),
		]),
	);
}

/** The `skif email request-access` report for the org's latest request. */
export function emailAccessRequestDetails(request: EmailAccessRequestView): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(9)}  ${value}`);
	field('Request', request.id);
	field('Status', request.status);
	field('Sent', `${formatTime(request.createdAt)} by ${request.requestedBy.email ?? request.requestedBy.id}`);
	field('Volume', `${request.expectedDailyVolume.toLocaleString('en-US')} messages a day`);
	if (request.website) field('Website', request.website);
	field('Use case', truncate(request.useCase.replace(/\s+/g, ' '), 200));
	if (request.decidedAt) field('Decided', formatTime(request.decidedAt));
	if (request.status === 'approved' && request.perDay !== null)
		field('Granted', `${request.perSecond}/s, ${request.perDay.toLocaleString('en-US')}/day`);
	if (request.note) field(request.status === 'denied' ? 'Reason' : 'Note', request.note);
	return lines.join('\n');
}

/** Parse `--volume`: a whole number of messages a day; `10k`/`2m` shorthands are accepted. */
export function parseDailyVolume(value: string | undefined): number {
	if (value === undefined || value.trim() === '') throw new UsageError('--volume is required: the messages a day you expect to send.');
	const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(value.trim().replace(/[,_]/g, ''));
	const scale = match?.[2]?.toLowerCase() === 'k' ? 1_000 : match?.[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
	const volume = match ? Math.round(Number(match[1]) * scale) : Number.NaN;
	if (!Number.isInteger(volume) || volume < 1 || volume > 10_000_000)
		throw new UsageError(`--volume must be a whole number of messages a day between 1 and 10,000,000, got "${value}".`);
	return volume;
}

/** The `skif email status` report. */
export function emailStatusReport(org: EmailOrgView, settings: EmailSettingsView | null): string {
	const lines: string[] = [];
	const field = (label: string, value: string) => lines.push(`${label.padEnd(10)}  ${value}`);
	field('State', `${org.state} — ${stateNotes[org.state] ?? org.state}`);
	if (org.pausedReason) field('Paused', org.pausedReason);
	field('Limits', `${org.perSecond}/s, ${org.perDay.toLocaleString('en-US')}/day`);
	field('Sent today', `${org.sentToday.toLocaleString('en-US')} of ${org.perDay.toLocaleString('en-US')}`);
	if (org.windowMessages < EMAIL_REPUTATION.minMessages) {
		field('Bounces', `${percent(org.bounceRate)} (rates gate sending after ${EMAIL_REPUTATION.minMessages} messages; ${org.windowMessages} so far)`);
		field('Complaints', percent(org.complaintRate, 2));
	} else {
		field('Bounces', rateLine(org.bounceRate, EMAIL_REPUTATION.bounceWarn, EMAIL_REPUTATION.bouncePause, 1));
		field('Complaints', rateLine(org.complaintRate, EMAIL_REPUTATION.complaintWarn, EMAIL_REPUTATION.complaintPause, 2));
		field('Window', `last ${org.windowMessages.toLocaleString('en-US')} messages`);
	}
	if (settings) {
		lines.push('');
		if (!settings.nodeId) field('Mail node', 'not set up — choose one in Email → Mail server');
		else field('Mail node', `${settings.nodeId}${settings.paused ? ' (delivery paused platform-wide)' : ''}`);
		if (settings.hostnames?.submission) field('SMTP', `${settings.hostnames.submission}:587 (STARTTLS) or :465 (TLS)`);
	}
	return lines.join('\n');
}

/**
 * Follow mode: which messages to print after a poll. New ids and status changes, oldest first.
 * `seen` maps id → last printed status and is updated in place.
 */
export function takeNewMessages(messages: EmailMessageView[], seen: Map<string, string>): EmailMessageView[] {
	const out: EmailMessageView[] = [];
	for (const message of [...messages].reverse()) {
		if (seen.get(message.id) === message.status) continue;
		seen.set(message.id, message.status);
		out.push(message);
	}
	return out;
}
