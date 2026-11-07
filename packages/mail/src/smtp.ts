import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { SMTPServer, type SMTPServerOptions, type SMTPServerSession } from 'smtp-server';
import {
	EMAIL_MAX_INBOUND_BYTES,
	EMAIL_MAX_MESSAGE_BYTES,
	EMAIL_MAX_RECIPIENTS,
	EMAIL_MESSAGE_ID_PREFIX,
	HARD_BOUNCE_CLASSES,
	parseAddress,
	parseVerp,
	type EmailRejectCode,
	type MailHostnames,
} from '@skiff/contracts';
import { headerFromAddress, prepareHeaders, signMessage, splitHeaders } from './message.ts';
import type { MailPolicy } from './policy.ts';
import { dsnOutcome, parseReport, textBounceOutcome } from './reports.ts';
import type { EventInput, Spool } from './spool.ts';

/**
 * The three listeners (EMAIL.md §3.2):
 * - submission (587 STARTTLS, 465 implicit TLS): AUTH required, TLS before AUTH, policy in-process;
 * - inbound (25): only our VERP bounce addresses and the report mailboxes; never a relay.
 */

export const newMessageId = (): string => `${EMAIL_MESSAGE_ID_PREFIX}${randomUUID().replace(/-/g, '')}`;

export interface SmtpTls {
	key: Buffer;
	cert: Buffer;
}

interface SmtpError extends Error {
	responseCode?: number;
}

function smtpError(responseCode: number, message: string): SmtpError {
	const error: SmtpError = new Error(message);
	error.responseCode = responseCode;
	return error;
}

const REJECT_REPLY: Record<EmailRejectCode, number> = {
	email_paused: 550,
	sandbox_recipient: 550,
	from_not_verified: 550,
	from_not_allowed: 550,
	too_many_recipients: 452,
	no_recipients: 554,
	message_too_large: 552,
	daily_quota: 451,
	rate_limited: 451,
	all_suppressed: 550,
	invalid_address: 553,
};

function readStream(stream: Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk: Buffer) => chunks.push(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

export interface SubmissionDeps {
	policy: MailPolicy;
	spool: Spool;
	hostname: () => string;
	onAccepted: () => void;
	now?: () => number;
	log?: (message: string) => void;
}

export function createSubmissionServer(deps: SubmissionDeps, tls: SmtpTls | null, secure: boolean): SMTPServer {
	const now = deps.now ?? Date.now;
	const options: SMTPServerOptions = {
		name: deps.hostname(),
		banner: 'Skiff mail submission',
		secure,
		...(tls ? { key: tls.key, cert: tls.cert } : {}),
		authMethods: ['PLAIN', 'LOGIN'],
		authOptional: false,
		allowInsecureAuth: false,
		size: EMAIL_MAX_MESSAGE_BYTES,
		maxClients: 200,
		socketTimeout: 120_000,
		disabledCommands: [],
		logger: false,
		onAuth(auth, _session, callback) {
			const credential = auth.username && auth.password ? deps.policy.authenticate(auth.username, auth.password) : null;
			if (!credential) return callback(smtpError(535, '5.7.8 Authentication credentials invalid'));
			callback(null, { user: credential.username });
		},
		onRcptTo(_address, session, callback) {
			if (session.envelope.rcptTo.length >= EMAIL_MAX_RECIPIENTS)
				return callback(smtpError(452, `4.5.3 At most ${EMAIL_MAX_RECIPIENTS} recipients per message`));
			callback();
		},
		onData(stream, session, callback) {
			void accept(stream, session)
				.then((reply) => callback(null, reply))
				.catch((error: SmtpError) => {
					if (!error.responseCode) deps.log?.(`submission failed: ${error.message}`);
					callback(error.responseCode ? error : smtpError(451, '4.3.0 Temporary failure, try again'));
				});
		},
	};

	async function accept(stream: Readable & { sizeExceeded?: boolean }, session: SMTPServerSession): Promise<string> {
		const raw = await readStream(stream);
		if (stream.sizeExceeded) throw smtpError(552, '5.3.4 Message too large');
		const state = deps.policy.state;
		if (!state) throw smtpError(451, '4.3.0 Mail service is starting, try again shortly');
		const username = typeof session.user === 'string' ? session.user : null;
		const credential = username ? state.credentials.find((entry) => entry.username === username) : null;
		if (!credential) throw smtpError(535, '5.7.8 Credential no longer valid');

		const header = splitHeaders(raw);
		const fromHeader = header.values.get('from');
		const from = fromHeader?.length === 1 ? headerFromAddress(fromHeader[0]) : null;
		if (!from) throw smtpError(550, '5.6.0 The message needs exactly one From: address');

		const recipients = session.envelope.rcptTo.map((entry) => entry.address);
		const decision = deps.policy.authorize(credential, { from, recipients, sizeBytes: raw.byteLength });
		if (!decision.ok) {
			const code = REJECT_REPLY[decision.code];
			throw smtpError(code, `${code >= 500 ? '5' : '4'}.7.1 ${decision.message}`);
		}
		const domain = deps.policy.domain(domainOf(from));
		if (!domain || domain.dkim.length === 0) throw smtpError(451, `4.3.0 No signing key for ${domainOf(from)} yet`);

		const messageId = newMessageId();
		const at = new Date(now());
		const signed = await signMessage(prepareHeaders(raw, messageId, from, at), domain);
		const suppressedEvents: EventInput[] = decision.suppressed.map((address) => ({
			kind: 'suppressed',
			messageId,
			orgId: credential.orgId,
			projectId: credential.projectId,
			recipient: address,
			recipientIndex: null,
			at: at.toISOString(),
			attempt: 0,
			severity: null,
			bounceClass: null,
			remoteHost: null,
			response: 'on the suppression list',
			tls: null,
			source: 'smtp',
			feedbackType: null,
			tags: {},
		}));
		const subject = header.values.get('subject')?.[0]?.slice(0, 998) ?? null;
		deps.spool.accept(
			{ id: messageId, orgId: credential.orgId, projectId: credential.projectId, from, subject, source: 'smtp', tags: {} },
			signed,
			decision.deliver,
			suppressedEvents,
			at.getTime(),
		);
		deps.policy.record(credential.orgId);
		deps.onAccepted();
		return `2.0.0 Queued as ${messageId}`;
	}

	return new SMTPServer(options);
}

export interface InboundDeps {
	policy: MailPolicy;
	spool: Spool;
	hostnames: () => MailHostnames | null;
	now?: () => number;
	log?: (message: string) => void;
}

const REPORT_MAILBOXES = new Set(['fbl', 'abuse', 'postmaster', 'dmarc']);

/**
 * Port 25. Accepts mail only for VERP bounce addresses and the report mailboxes on our own
 * hostnames; everything else is refused at RCPT, so the node is never a relay (EMAIL.md §12).
 * Receiving domains and routes join in phase E2.
 */
export function createInboundServer(deps: InboundDeps, tls: SmtpTls | null): SMTPServer {
	const now = deps.now ?? Date.now;
	const ourHosts = () => {
		const names = deps.hostnames();
		return names ? new Set([names.bounce, names.mx, names.helo].map((name) => name.toLowerCase())) : new Set<string>();
	};
	return new SMTPServer({
		name: deps.hostnames()?.mx ?? 'localhost',
		banner: 'Skiff mail',
		...(tls ? { key: tls.key, cert: tls.cert } : {}),
		authOptional: true,
		disabledCommands: ['AUTH'],
		size: EMAIL_MAX_INBOUND_BYTES,
		maxClients: 200,
		socketTimeout: 120_000,
		logger: false,
		onRcptTo(address, _session, callback) {
			const parsed = parseAddress(address.address);
			const names = deps.hostnames();
			if (!parsed || !names) return callback(smtpError(550, '5.1.1 No such user here'));
			if (parsed.domain === names.bounce.toLowerCase() && parseVerp(parsed.address, names.bounce)) return callback();
			if (ourHosts().has(parsed.domain) && REPORT_MAILBOXES.has(parsed.local.toLowerCase())) return callback();
			callback(smtpError(550, '5.1.1 No such user here'));
		},
		onData(stream, session, callback) {
			void readStream(stream)
				.then(async (raw) => {
					if ((stream as { sizeExceeded?: boolean }).sizeExceeded) throw smtpError(552, '5.3.4 Message too large');
					await handleReport(raw, session.envelope.rcptTo.map((entry) => entry.address));
					callback(null, '2.0.0 Thanks');
				})
				.catch((error: SmtpError) => {
					if (error.responseCode) return callback(error);
					// Never bounce a bounce: log and accept rather than generate backscatter.
					deps.log?.(`inbound report not understood: ${error.message}`);
					callback(null, '2.0.0 Thanks');
				});
		},
	});

	async function handleReport(raw: Buffer, rcpts: string[]): Promise<void> {
		const names = deps.hostnames();
		if (!names) return;
		const verp = rcpts.map((rcpt) => parseVerp(rcpt, names.bounce)).find((value) => value !== null) ?? null;
		const report = await parseReport(raw);
		const at = new Date(now()).toISOString();

		if (report.kind === 'arf') {
			const messageId = report.skiffId ?? verp?.messageId ?? null;
			const sent = messageId ? deps.spool.sent(messageId, verp && verp.messageId === messageId ? verp.recipientIndex : null) : null;
			if (!sent) {
				deps.log?.(`complaint report for an unknown message (${messageId ?? 'no id'})`);
				return;
			}
			deps.policy.suppress(sent.orgId, sent.address);
			deps.spool.emit({
				kind: 'complained',
				messageId: sent.messageId,
				orgId: sent.orgId,
				projectId: sent.projectId,
				recipient: sent.address,
				recipientIndex: sent.index,
				at,
				attempt: 0,
				severity: null,
				bounceClass: null,
				remoteHost: null,
				response: report.sourceIp ? `reported from ${report.sourceIp}` : null,
				tls: null,
				source: 'inbound',
				feedbackType: report.feedbackType,
				tags: sent.tags,
			});
			return;
		}

		if (!verp) return; // Mail to postmaster/abuse that isn't a report: accepted and dropped.
		const sent = deps.spool.sent(verp.messageId, verp.recipientIndex);
		if (!sent) {
			deps.log?.(`bounce for an unknown message ${verp.messageId}`);
			return;
		}
		let outcome = null;
		let response: string | null = null;
		if (report.kind === 'dsn') {
			const block =
				report.recipients.find((entry) => entry.finalRecipient?.toLowerCase() === sent.address.toLowerCase()) ??
				report.recipients[0];
			if (block) {
				outcome = dsnOutcome(block);
				response = [block.status, block.diagnostic].filter(Boolean).join(' ') || null;
			} else {
				outcome = textBounceOutcome(report.fallbackText);
				response = report.fallbackText.slice(0, 1000);
			}
		} else {
			outcome = textBounceOutcome(report.text);
			response = report.text.trim().slice(0, 1000);
		}
		if (!outcome || outcome.kind !== 'permanent') return; // delayed / delivered notices
		if (HARD_BOUNCE_CLASSES.has(outcome.bounceClass)) deps.policy.suppress(sent.orgId, sent.address);
		deps.spool.emit({
			kind: 'bounced',
			messageId: sent.messageId,
			orgId: sent.orgId,
			projectId: sent.projectId,
			recipient: sent.address,
			recipientIndex: sent.index,
			at,
			attempt: 0,
			severity: 'hard',
			bounceClass: outcome.bounceClass,
			remoteHost: null,
			response: response?.replace(/\s+/g, ' ').trim().slice(0, 1000) ?? null,
			tls: null,
			source: 'inbound',
			feedbackType: null,
			tags: sent.tags,
		});
	}
}
