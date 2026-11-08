import * as z from 'zod';

/**
 * Email: Skiff's self-hosted SES (docs/EMAIL.md, D114–D120).
 *
 * This module is shared by the control plane (`EmailService`), the agent (the mail bridge) and
 * `skiff-mail` (the MTA in `packages/mail`). It holds the wire shapes between them and the one
 * policy function every send path runs (`authorizeSend`, D117). Nothing here does I/O, so it is
 * safe in the dashboard bundle too.
 */

// --- ids -----------------------------------------------------------------------------------

export const EMAIL_DOMAIN_ID_PREFIX = 'ed_';
export const EMAIL_MESSAGE_ID_PREFIX = 'em_';
export const EMAIL_CREDENTIAL_ID_PREFIX = 'ec_';
export const EMAIL_ADDRESS_ID_PREFIX = 'ea_';
export const EMAIL_WEBHOOK_ID_PREFIX = 'ew_';
export const EMAIL_ROUTE_ID_PREFIX = 'er_';
export const EMAIL_ACCESS_REQUEST_ID_PREFIX = 'ear_';

/** SMTP usernames are `skf_<credential id hex>`; the prefix makes them easy to spot in logs. */
export const EMAIL_USERNAME_PREFIX = 'skf_';

// --- limits (EMAIL.md §5.1) -----------------------------------------------------------------

export const EMAIL_MAX_RECIPIENTS = 50;
export const EMAIL_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
export const EMAIL_MAX_INBOUND_BYTES = 25 * 1024 * 1024;
export const EMAIL_MAX_TAGS = 10;
export const EMAIL_MAX_BATCH = 100;
/** Retry schedule for transient failures, in seconds after the previous attempt (EMAIL.md §3.2). */
export const EMAIL_RETRY_SCHEDULE_SECONDS = [60, 300, 900, 1800, 3600] as const;
/** After this long a still-deferred recipient bounces with class `expired`. */
export const EMAIL_EXPIRY_SECONDS = 3 * 24 * 3600;
/** Outbox rows the mail node never picked up fail after this long (D117). */
export const EMAIL_OUTBOX_TTL_SECONDS = 24 * 3600;

/** Sandbox and default active limits (EMAIL.md §7.3). */
export const EMAIL_SANDBOX_LIMITS = { perSecond: 1, perDay: 200 } as const;
export const EMAIL_ACTIVE_DEFAULT_LIMITS = { perSecond: 10, perDay: 10_000 } as const;

/**
 * Sandbox recipients (EMAIL.md §4.3): a verification link lasts a day; it can be re-sent after a
 * minute, at most `maxSends` times per link; an org holds at most `maxAddresses`, `maxPending` of
 * them unverified at once. Verification mail goes through the platform's own SMTP (D22).
 */
export const EMAIL_SANDBOX_ADDRESS_LIMITS = {
	linkTtlSeconds: 24 * 3600,
	resendAfterSeconds: 60,
	maxSends: 5,
	maxAddresses: 50,
	maxPending: 10,
} as const;

/** Auto-pause thresholds (EMAIL.md §7.2, D119). Rates are fractions, not percentages. */
export const EMAIL_REPUTATION = {
	minMessages: 200,
	windowMessages: 10_000,
	windowDays: 14,
	bounceWarn: 0.04,
	bouncePause: 0.08,
	complaintWarn: 0.001,
	complaintPause: 0.003,
} as const;

// --- names and addresses --------------------------------------------------------------------

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A DNS name an org can send from or receive on: lowercase, at least two labels, no wildcard. */
export const emailDomainNameSchema = z
	.string()
	.trim()
	.toLowerCase()
	.min(3)
	.max(253)
	.refine((value) => {
		const labels = value.split('.');
		return labels.length >= 2 && labels.every((label) => HOST_LABEL.test(label)) && !/^\d+$/.test(labels.at(-1)!);
	}, 'Use a domain name such as example.com or mail.example.com.');

/**
 * A pragmatic address check: one `@`, a local part of printable ASCII without spaces or angle
 * brackets (≤ 64), and a valid domain. SMTPUTF8 local parts are not accepted in v1.
 */
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;

export function parseAddress(value: string): { local: string; domain: string; address: string } | null {
	const trimmed = value.trim();
	const at = trimmed.lastIndexOf('@');
	if (at <= 0 || at === trimmed.length - 1) return null;
	const local = trimmed.slice(0, at);
	const domain = trimmed.slice(at + 1).toLowerCase();
	if (!LOCAL_PART.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
	if (!emailDomainNameSchema.safeParse(domain).success) return null;
	return { local, domain, address: `${local}@${domain}` };
}

/** Lowercased address used for suppression and sandbox lookups (local parts compared case-insensitively). */
export function normalizeAddress(value: string): string {
	return value.trim().toLowerCase();
}

export const emailAddressSchema = z
	.string()
	.trim()
	.max(320)
	.refine((value) => parseAddress(value) !== null, 'Not a valid email address.')
	.transform((value) => parseAddress(value)!.address);

const displayNameSchema = z
	.string()
	.max(200)
	.refine((value) => !/[\r\n]/.test(value), 'Names cannot contain line breaks.');

export const emailRecipientSchema = z.union([
	emailAddressSchema,
	z.object({ name: displayNameSchema.optional(), address: emailAddressSchema }),
]);
export type EmailRecipient = z.input<typeof emailRecipientSchema>;

export function recipientAddress(recipient: z.infer<typeof emailRecipientSchema>): string {
	return typeof recipient === 'string' ? recipient : recipient.address;
}

// --- send input (EMAIL.md §5.1) ---------------------------------------------------------------

/** Headers a caller may never set; Skiff owns them. Compared lowercased. */
export const EMAIL_RESERVED_HEADERS = new Set([
	'from',
	'sender',
	'to',
	'cc',
	'bcc',
	'subject',
	'reply-to',
	'message-id',
	'date',
	'return-path',
	'dkim-signature',
	'arc-seal',
	'arc-message-signature',
	'arc-authentication-results',
	'authentication-results',
	'received',
	'mime-version',
	'content-type',
	'content-transfer-encoding',
	'list-unsubscribe',
	'list-unsubscribe-post',
]);

const headerNameSchema = z.string().regex(/^[A-Za-z0-9-]{1,76}$/, 'Header names are letters, digits and hyphens.');
const headerValueSchema = z
	.string()
	.max(998)
	.refine((value) => !/[\r\n]/.test(value), 'Header values cannot contain line breaks.');

const tagKeySchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
const tagValueSchema = z.string().max(256).refine((value) => !/[\r\n]/.test(value));

export const emailAttachmentSchema = z.object({
	filename: z.string().min(1).max(255).refine((value) => !/[\r\n/\\]/.test(value), 'Not a valid file name.'),
	contentType: z.string().max(255).default('application/octet-stream'),
	/** Base64 content. */
	content: z.string().max(Math.ceil((EMAIL_MAX_MESSAGE_BYTES * 4) / 3) + 4),
	/** Set for inline images referenced as `cid:<contentId>` in the HTML. */
	contentId: z.string().max(255).optional(),
});

export const emailSendSchema = z
	.object({
		from: emailRecipientSchema,
		to: z.array(emailRecipientSchema).max(EMAIL_MAX_RECIPIENTS).default([]),
		cc: z.array(emailRecipientSchema).max(EMAIL_MAX_RECIPIENTS).default([]),
		bcc: z.array(emailRecipientSchema).max(EMAIL_MAX_RECIPIENTS).default([]),
		replyTo: z.array(emailRecipientSchema).max(10).default([]),
		subject: z.string().max(998).refine((value) => !/[\r\n]/.test(value), 'Subjects cannot contain line breaks.').default(''),
		text: z.string().optional(),
		html: z.string().optional(),
		attachments: z.array(emailAttachmentSchema).max(50).default([]),
		headers: z.record(headerNameSchema, headerValueSchema).default({}),
		tags: z.record(tagKeySchema, tagValueSchema).default({}),
		unsubscribe: z.object({ url: z.url().max(2048), oneClick: z.boolean().default(false) }).optional(),
		idempotencyKey: z.string().min(1).max(255).optional(),
		/** Full RFC 5322 message instead of the fields above; envelope recipients still come from to/cc/bcc. */
		raw: z.string().max(EMAIL_MAX_MESSAGE_BYTES).optional(),
	})
	.superRefine((input, ctx) => {
		const total = input.to.length + input.cc.length + input.bcc.length;
		if (total === 0) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Add at least one recipient.' });
		if (total > EMAIL_MAX_RECIPIENTS)
			ctx.addIssue({ code: 'custom', path: ['to'], message: `At most ${EMAIL_MAX_RECIPIENTS} recipients in total.` });
		if (!input.raw && input.text === undefined && input.html === undefined)
			ctx.addIssue({ code: 'custom', path: ['text'], message: 'Give text, html or raw.' });
		if (input.raw && (input.text !== undefined || input.html !== undefined || input.attachments.length > 0))
			ctx.addIssue({ code: 'custom', path: ['raw'], message: 'raw replaces text, html and attachments.' });
		if (Object.keys(input.tags).length > EMAIL_MAX_TAGS)
			ctx.addIssue({ code: 'custom', path: ['tags'], message: `At most ${EMAIL_MAX_TAGS} tags.` });
		for (const name of Object.keys(input.headers))
			if (EMAIL_RESERVED_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('x-skiff-'))
				ctx.addIssue({ code: 'custom', path: ['headers', name], message: `${name} is set by Skiff.` });
	});
export type EmailSendInput = z.input<typeof emailSendSchema>;
export type EmailSend = z.infer<typeof emailSendSchema>;

export const emailSendBatchSchema = z.object({
	messages: z.array(emailSendSchema).min(1).max(EMAIL_MAX_BATCH),
});

/** The batch envelope only; each message is validated (and fails) on its own. */
export const emailSendBatchEnvelopeSchema = z.object({
	messages: z.array(z.unknown()).min(1).max(EMAIL_MAX_BATCH),
});


// --- org state and policy (EMAIL.md §5.3, §7) ----------------------------------------------

export const emailOrgStates = ['sandbox', 'active', 'paused'] as const;
export type EmailOrgState = (typeof emailOrgStates)[number];

/** Platform-admin org update (EMAIL.md §7.3). */
export const emailOrgStateUpdateSchema = z
	.object({
		state: z.enum(emailOrgStates).optional(),
		perSecond: z.number().int().min(1).max(1000).optional(),
		perDay: z.number().int().min(1).max(10_000_000).optional(),
	})
	.strict();

/** Platform-admin email settings (EMAIL.md §3.3). */
export const emailSettingsUpdateSchema = z
	.object({
		nodeId: z.string().min(1).max(64).nullable().optional(),
		/** The mail node's public IPv4; found automatically for the edge when left out. */
		ip: z.string().trim().max(15).nullable().optional(),
		paused: z.boolean().optional(),
		/** A custom domain (or URL) for the mail hostnames; null puts them back on the content domain. */
		mailDomain: z.string().trim().max(2048).nullable().optional(),
	})
	.strict();

export const emailSuppressionReasons = ['bounce', 'complaint', 'manual', 'unsubscribe'] as const;
export type EmailSuppressionReason = (typeof emailSuppressionReasons)[number];

/** Everything `authorizeSend` needs about one org, from SQLite or from the pushed mail state. */
export interface EmailPolicyOrg {
	orgId: string;
	state: EmailOrgState;
	perSecond: number;
	perDay: number;
	/** Verified domains with sending on; lowercased. */
	sendingDomains: readonly string[];
	/** Verified single addresses (sandbox recipients); lowercased. */
	verifiedAddresses: readonly string[];
}

export interface EmailPolicyEnvelope {
	from: string;
	recipients: readonly string[];
	sizeBytes: number;
	/** The credential's from-domain allowlist; empty means any of the org's sending domains. */
	allowedFromDomains?: readonly string[];
}

export interface EmailPolicyUsage {
	/** Messages accepted for the org today (UTC), before this one. */
	sentToday: number;
	/** Messages accepted for the org in the last second, before this one. */
	sentLastSecond: number;
}

export type EmailRejectCode =
	| 'email_paused'
	| 'sandbox_recipient'
	| 'from_not_verified'
	| 'from_not_allowed'
	| 'too_many_recipients'
	| 'no_recipients'
	| 'message_too_large'
	| 'daily_quota'
	| 'rate_limited'
	| 'all_suppressed'
	| 'invalid_address';

export type EmailAuthorization =
	| { ok: true; deliver: string[]; suppressed: string[] }
	| { ok: false; code: EmailRejectCode; message: string; temporary: boolean };

/**
 * The one send policy (D117). Pure: the caller supplies the org, the suppression lookup and the
 * usage counters. Checks run in the documented order so every path refuses the same message for
 * the same reason. Suppressed recipients are dropped, not refused, unless every one is.
 */
export function authorizeSend(
	org: EmailPolicyOrg,
	envelope: EmailPolicyEnvelope,
	usage: EmailPolicyUsage,
	isSuppressed: (address: string) => boolean,
): EmailAuthorization {
	const refuse = (code: EmailRejectCode, message: string, temporary = false): EmailAuthorization => ({
		ok: false,
		code,
		message,
		temporary,
	});
	if (org.state === 'paused')
		return refuse('email_paused', 'Sending is paused for this organisation. A platform admin can resume it.');

	const from = parseAddress(envelope.from);
	if (!from) return refuse('invalid_address', `"${envelope.from}" is not a valid sender address.`);

	const recipients: string[] = [];
	for (const raw of envelope.recipients) {
		const parsed = parseAddress(raw);
		if (!parsed) return refuse('invalid_address', `"${raw}" is not a valid recipient address.`);
		recipients.push(parsed.address);
	}
	const unique = [...new Map(recipients.map((address) => [normalizeAddress(address), address])).values()];
	if (unique.length === 0) return refuse('no_recipients', 'Add at least one recipient.');
	if (unique.length > EMAIL_MAX_RECIPIENTS)
		return refuse('too_many_recipients', `At most ${EMAIL_MAX_RECIPIENTS} recipients per message.`);

	const sending = new Set(org.sendingDomains.map((domain) => domain.toLowerCase()));
	if (!sending.has(from.domain))
		return refuse('from_not_verified', `${from.domain} is not a verified sending domain for this organisation.`);
	if (envelope.allowedFromDomains && envelope.allowedFromDomains.length > 0) {
		const allowed = new Set(envelope.allowedFromDomains.map((domain) => domain.toLowerCase()));
		if (!allowed.has(from.domain))
			return refuse('from_not_allowed', `This credential may not send from ${from.domain}.`);
	}

	if (org.state === 'sandbox') {
		const verified = new Set(org.verifiedAddresses.map(normalizeAddress));
		const blocked = unique.find((address) => {
			const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
			return !sending.has(domain) && !verified.has(normalizeAddress(address));
		});
		if (blocked)
			return refuse(
				'sandbox_recipient',
				`In the sandbox you can only send to your own verified domains and verified addresses; ${blocked} is neither.`,
			);
	}

	if (envelope.sizeBytes > EMAIL_MAX_MESSAGE_BYTES)
		return refuse('message_too_large', `Messages are limited to ${EMAIL_MAX_MESSAGE_BYTES / 1024 / 1024} MB.`);
	if (usage.sentToday >= org.perDay)
		return refuse('daily_quota', `The daily limit of ${org.perDay} messages is reached.`, true);
	if (usage.sentLastSecond >= org.perSecond)
		return refuse('rate_limited', `At most ${org.perSecond} messages a second.`, true);

	const deliver: string[] = [];
	const suppressed: string[] = [];
	for (const address of unique) (isSuppressed(normalizeAddress(address)) ? suppressed : deliver).push(address);
	if (deliver.length === 0)
		return refuse('all_suppressed', 'Every recipient is on the suppression list.');
	return { ok: true, deliver, suppressed };
}

// --- VERP return path (D116) ----------------------------------------------------------------

/**
 * Envelope sender for one recipient of one message: `b-<messageId>-<index>@<bounceHost>`. A DSN
 * that comes back to it names the exact recipient without parsing the DSN body.
 */
export function verpAddress(messageId: string, recipientIndex: number, bounceHost: string): string {
	return `b-${messageId}-${recipientIndex}@${bounceHost}`;
}

export function parseVerp(address: string, bounceHost: string): { messageId: string; recipientIndex: number } | null {
	const parsed = parseAddress(address);
	if (!parsed || parsed.domain !== bounceHost.toLowerCase()) return null;
	const match = /^b-(em_[a-z0-9]{8,64})-(\d{1,3})$/i.exec(parsed.local);
	if (!match) return null;
	return { messageId: match[1]!.toLowerCase(), recipientIndex: Number(match[2]) };
}

// --- DNS records (EMAIL.md §4.2) -----------------------------------------------------------

export const emailRecordPurposes = ['dkim', 'spf', 'dmarc', 'mx'] as const;
export type EmailRecordPurpose = (typeof emailRecordPurposes)[number];

export interface EmailDnsRecord {
	purpose: EmailRecordPurpose;
	type: 'TXT' | 'MX' | 'CNAME';
	name: string;
	value: string;
	priority?: number;
	/** `required` records gate verification or sending; `recommended` ones only warn. */
	required: boolean;
}

export function dkimRecordName(selector: string, domain: string): string {
	return `${selector}._domainkey.${domain}`;
}

/** `v=DKIM1; k=rsa; p=<base64 SPKI>`. */
export function dkimRecordValue(publicKeyBase64: string, algorithm: 'rsa' | 'ed25519' = 'rsa'): string {
	return `v=DKIM1; k=${algorithm}; p=${publicKeyBase64}`;
}

/** Selector for a key generated in a given month: `skf202611`. */
export function dkimSelector(date: Date): string {
	return `skf${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function spfInclude(platformDomain: string): string {
	return `include:_spf.${platformDomain}`;
}

/**
 * Merge Skiff's include into an existing SPF record without duplicating it, keeping the
 * record's own `all` qualifier (or `~all` when there is none). With no SPF record it returns a
 * fresh one.
 */
export function mergeSpf(existing: string | null, include: string): string {
	if (!existing || !/^v=spf1(\s|$)/i.test(existing.trim())) return `v=spf1 ${include} ~all`;
	const terms = existing.trim().split(/\s+/);
	if (terms.some((term) => term.toLowerCase() === include.toLowerCase())) return terms.join(' ');
	const allIndex = terms.findIndex((term) => /^[+\-~?]?all$/i.test(term) || /^redirect=/i.test(term));
	if (allIndex === -1) return [...terms, include, '~all'].join(' ');
	return [...terms.slice(0, allIndex), include, ...terms.slice(allIndex)].join(' ');
}

/** Whether an SPF record already carries Skiff's include. */
export function spfIncludes(record: string, include: string): boolean {
	return record
		.trim()
		.split(/\s+/)
		.some((term) => term.toLowerCase() === include.toLowerCase() || term.toLowerCase() === `+${include.toLowerCase()}`);
}

export function suggestedDmarc(domain: string): string {
	return `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`;
}

/** Platform hostnames the mail node answers for (EMAIL.md §3.3). */
export function mailHostnames(platformDomain: string): MailHostnames {
	return {
		helo: `mx1.${platformDomain}`,
		mx: `mx.${platformDomain}`,
		submission: `smtp.${platformDomain}`,
		bounce: `bounces.${platformDomain}`,
		spf: `_spf.${platformDomain}`,
	};
}

export const mailHostnamesSchema = z.object({
	helo: z.string().min(3).max(253),
	mx: z.string().min(3).max(253),
	submission: z.string().min(3).max(253),
	bounce: z.string().min(3).max(253),
	spf: z.string().min(3).max(253),
});
export type MailHostnames = z.infer<typeof mailHostnamesSchema>;

// --- desired state and the pushed mail state (EMAIL.md §3.5) --------------------------------

/**
 * `DesiredState.mail`: only present on the node holding the `mail` role. It carries no secrets;
 * the agent fetches the full state (keys, credential hashes) from `/api/agent/email-state` when
 * `generation` moves, the same way activations keep secrets out of desired state (D43).
 */
export const mailDesiredSchema = z.object({
	generation: z.number().int().nonnegative(),
	hostnames: mailHostnamesSchema,
});
export type MailDesired = z.infer<typeof mailDesiredSchema>;

export const mailStateDomainSchema = z.object({
	id: z.string(),
	orgId: z.string(),
	name: z.string(),
	sending: z.boolean(),
	receiving: z.boolean(),
	dkim: z.array(
		z.object({
			selector: z.string().min(1).max(63),
			algorithm: z.enum(['rsa-sha256', 'ed25519-sha256']),
			/** PEM. Present only in the pushed state, never in desired state or logs. */
			privateKey: z.string().min(1),
		}),
	),
});

export const mailStateCredentialSchema = z.object({
	id: z.string(),
	orgId: z.string(),
	projectId: z.string().nullable(),
	username: z.string(),
	/** `scrypt$<salt>$<hash>` (packages/core util `hashPassword`). */
	hash: z.string(),
	allowedFromDomains: z.array(z.string()).default([]),
});

export const mailStateOrgSchema = z.object({
	orgId: z.string(),
	state: z.enum(emailOrgStates),
	perSecond: z.number().int().positive(),
	perDay: z.number().int().positive(),
	/** Accepted today (UTC) according to the control plane when the state was built. */
	sentToday: z.number().int().nonnegative().default(0),
	verifiedAddresses: z.array(z.string()).default([]),
	/** Lowercased suppressed addresses for this org (EMAIL.md §7.1). */
	suppressed: z.array(z.string()).default([]),
});

export const mailStateSchema = z.object({
	generation: z.number().int().nonnegative(),
	hostnames: mailHostnamesSchema,
	/** Delivery globally paused by a platform admin: spool, but do not attempt. */
	paused: z.boolean().default(false),
	domains: z.array(mailStateDomainSchema).default([]),
	credentials: z.array(mailStateCredentialSchema).default([]),
	orgs: z.array(mailStateOrgSchema).default([]),
	/** Platform suppression list (cross-org hard bounces), lowercased. */
	platformSuppressed: z.array(z.string()).default([]),
});
export type MailState = z.infer<typeof mailStateSchema>;

/** Policy view of one org in the pushed state. */
export function policyOrgFromState(state: MailState, orgId: string): EmailPolicyOrg | null {
	const org = state.orgs.find((entry) => entry.orgId === orgId);
	if (!org) return null;
	return {
		orgId,
		state: org.state,
		perSecond: org.perSecond,
		perDay: org.perDay,
		sendingDomains: state.domains.filter((domain) => domain.orgId === orgId && domain.sending).map((domain) => domain.name),
		verifiedAddresses: org.verifiedAddresses,
	};
}

// --- outbox and injection (D117) ------------------------------------------------------------

/** One message handed to `skiff-mail`: already rendered MIME, not yet DKIM-signed. */
export const mailInjectSchema = z.object({
	messageId: z.string().regex(/^em_[a-z0-9]{8,64}$/),
	orgId: z.string(),
	projectId: z.string().nullable().default(null),
	from: z.string(),
	/** Envelope recipients after policy and suppression, in index order (VERP uses the index). */
	recipients: z.array(z.string()).min(1).max(EMAIL_MAX_RECIPIENTS),
	/** RFC 5322 message, base64. */
	raw: z.string(),
	tags: z.record(z.string(), z.string()).default({}),
});
export type MailInject = z.infer<typeof mailInjectSchema>;

// --- events (D120) ----------------------------------------------------------------------------

export const emailEventKinds = [
	'accepted',
	'delivered',
	'deferred',
	'bounced',
	'complained',
	'rejected',
	'suppressed',
	'received',
	'dropped',
] as const;
export type EmailEventKind = (typeof emailEventKinds)[number];

export const emailBounceClasses = [
	'invalid-recipient',
	'bad-domain',
	'mailbox-full',
	'message-too-large',
	'spam-block',
	'policy',
	'auth',
	'throttled',
	'connection',
	'protocol',
	'expired',
	'other',
] as const;
export type EmailBounceClass = (typeof emailBounceClasses)[number];

/** Bounce classes that suppress the address on the first permanent failure (EMAIL.md §7.1). */
export const HARD_BOUNCE_CLASSES: ReadonlySet<EmailBounceClass> = new Set(['invalid-recipient', 'bad-domain']);

export const emailEventSchema = z.object({
	/** Monotonic per mail node; the agent's ack cursor. */
	seq: z.number().int().nonnegative(),
	kind: z.enum(emailEventKinds),
	messageId: z.string(),
	orgId: z.string(),
	projectId: z.string().nullable().default(null),
	recipient: z.string().nullable().default(null),
	recipientIndex: z.number().int().nonnegative().nullable().default(null),
	at: z.string(),
	attempt: z.number().int().nonnegative().default(0),
	/** `hard` for permanent failures, `soft` for transient ones. */
	severity: z.enum(['hard', 'soft']).nullable().default(null),
	bounceClass: z.enum(emailBounceClasses).nullable().default(null),
	remoteHost: z.string().nullable().default(null),
	/** The remote reply (or our own reason), trimmed to 1000 characters. */
	response: z.string().nullable().default(null),
	tls: z.boolean().nullable().default(null),
	/** `smtp` for submission, `api` for outbox injection, `inbound` for port 25. */
	source: z.enum(['smtp', 'api', 'inbound']).default('api'),
	feedbackType: z.string().nullable().default(null),
	tags: z.record(z.string(), z.string()).default({}),
	/** Set on `accepted`: SMTP-submitted mail reaches the control plane's message log this way. */
	from: z.string().nullable().default(null),
	subject: z.string().max(998).nullable().default(null),
});
export type EmailEvent = z.infer<typeof emailEventSchema>;
export type EmailEventInput = z.input<typeof emailEventSchema>;

/** Agent → control plane: events pulled from `skiff-mail`, in seq order. */
export const mailEventsBatchSchema = z.object({ events: z.array(emailEventSchema).max(1000) });

/** Agent → control plane: outbox messages `skiff-mail` has spooled. */
export const mailOutboxAckSchema = z.object({
	messageIds: z.array(z.string().regex(/^em_[a-z0-9]{8,64}$/)).max(500),
});

/** What `skiff-mail` returns from `GET /health` (the agent pushes state when `generation` is null or behind). */
export const mailHealthSchema = z.object({
	ok: z.boolean(),
	generation: z.number().int().nullable(),
	queued: z.number().int().nonnegative(),
	deferred: z.number().int().nonnegative(),
	oldestQueuedAt: z.string().nullable(),
	pendingEvents: z.number().int().nonnegative(),
	listeners: z.array(z.object({ name: z.string(), port: z.number().int(), ok: z.boolean() })),
	tls: z.boolean(),
});
export type MailHealth = z.infer<typeof mailHealthSchema>;

// --- domain views (surfaces) ------------------------------------------------------------------

export const emailDomainStatuses = ['pending', 'verified', 'failed'] as const;
export type EmailDomainStatus = (typeof emailDomainStatuses)[number];

export const emailDomainCreateSchema = z.object({
	name: emailDomainNameSchema,
	sending: z.boolean().default(true),
	/** Receiving lands in phase E2; accepted now so clients don't change shape later. */
	receiving: z.boolean().default(false),
	/** Create records through Cloudflare when the zone is reachable (default true). */
	autoDns: z.boolean().default(true),
});
export type EmailDomainCreate = z.input<typeof emailDomainCreateSchema>;

export const emailDomainUpdateSchema = z.object({
	sending: z.boolean().optional(),
	receiving: z.boolean().optional(),
	replaceMx: z.boolean().optional(),
});

export interface EmailRecordCheck extends EmailDnsRecord {
	ok: boolean;
	/** What public DNS returned, for the dashboard's "found" column. */
	found: string[];
	/** Set when Skiff created or updated the record through Cloudflare. */
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

export const emailCredentialCreateSchema = z.object({
	name: z.string().min(1).max(80),
	/** Project scope (slug); omitted means org-wide. */
	project: z.string().min(1).max(64).optional(),
	allowedFromDomains: z.array(emailDomainNameSchema).max(20).default([]),
});

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

/** Returned once, at creation. */
export interface EmailCredentialSecret extends EmailCredentialView {
	password: string;
	smtp: { host: string; port: number; secure: 'starttls' | 'tls' };
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

export interface EmailSendResult {
	id: string;
	accepted: string[];
	suppressed: string[];
}

export const emailSuppressionCreateSchema = z.object({
	address: emailAddressSchema,
	reason: z.enum(emailSuppressionReasons).default('manual'),
});

export interface EmailSuppressionView {
	address: string;
	reason: EmailSuppressionReason;
	messageId: string | null;
	createdAt: string;
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

// --- sandbox recipients and production access (EMAIL.md §4.3, §7.3) -------------------------

export const emailSandboxAddressCreateSchema = z.object({ address: emailAddressSchema }).strict();

export type EmailSandboxAddressStatus = 'pending' | 'verified';

/** A single address the org may send to while in the sandbox, once its owner clicked the link. */
export interface EmailSandboxAddressView {
	id: string;
	address: string;
	status: EmailSandboxAddressStatus;
	verifiedAt: string | null;
	/** When the last verification link went out (pending only). */
	sentAt: string | null;
	/** When that link stops working (pending only). */
	expiresAt: string | null;
	createdAt: string;
}

export const emailAccessRequestStatuses = ['pending', 'approved', 'denied'] as const;
export type EmailAccessRequestStatus = (typeof emailAccessRequestStatuses)[number];

/** An org owner asks to leave the sandbox. */
export const emailAccessRequestCreateSchema = z
	.object({
		useCase: z
			.string()
			.trim()
			.min(20, 'Describe what you send and to whom in at least 20 characters.')
			.max(2000),
		expectedDailyVolume: z.number().int().min(1).max(10_000_000),
		website: z
			.string()
			.trim()
			.max(500)
			.url('A full URL, e.g. https://example.com.')
			.refine((value) => /^https?:\/\//i.test(value), 'An http(s) URL.')
			.optional(),
	})
	.strict();
export type EmailAccessRequestCreate = z.input<typeof emailAccessRequestCreateSchema>;

/** A platform admin's answer. Approving moves the org to `active` with these limits (defaults otherwise). */
export const emailAccessRequestDecisionSchema = z
	.object({
		decision: z.enum(['approve', 'deny']),
		note: z.string().trim().max(1000).optional(),
		perDay: z.number().int().min(1).max(10_000_000).optional(),
		perSecond: z.number().int().min(1).max(1000).optional(),
	})
	.strict();
export type EmailAccessRequestDecision = z.input<typeof emailAccessRequestDecisionSchema>;

export interface EmailAccessRequestView {
	id: string;
	orgId: string;
	/** The organisation's display name, for the platform admin's queue. */
	orgName: string | null;
	status: EmailAccessRequestStatus;
	useCase: string;
	expectedDailyVolume: number;
	website: string | null;
	requestedBy: { id: string; email: string | null };
	decidedBy: string | null;
	decidedAt: string | null;
	note: string | null;
	/** Limits granted on approval. */
	perDay: number | null;
	perSecond: number | null;
	createdAt: string;
}

/** Env names an email attachment injects (EMAIL.md §5.4). */
export function emailEnvNames(prefix: string): string[] {
	return ['HOST', 'PORT', 'SECURE', 'USER', 'PASSWORD', 'URL'].map((suffix) => `${prefix}_${suffix}`);
}
