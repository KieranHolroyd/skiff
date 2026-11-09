import { simpleParser, type Attachment } from 'mailparser';
import { classifyReply, type ReplyOutcome } from './classify.ts';

/**
 * Parsing what comes back on port 25 (EMAIL.md §6.4): delivery status notifications (RFC 3464)
 * to our VERP return paths, and ARF complaint reports (RFC 5965) from feedback loops.
 */

export interface DsnRecipient {
	finalRecipient: string | null;
	action: string;
	status: string | null;
	diagnostic: string | null;
	remoteMta: string | null;
}

export type ParsedReport =
	| { kind: 'dsn'; recipients: DsnRecipient[]; fallbackText: string }
	| { kind: 'arf'; feedbackType: string; yoalId: string | null; originalRecipient: string | null; sourceIp: string | null }
	| { kind: 'other'; text: string; yoalId: string | null };

/** `Name: value` blocks separated by blank lines, continuation lines unfolded. */
export function parseFieldBlocks(text: string): Array<Map<string, string>> {
	const blocks: Array<Map<string, string>> = [];
	for (const chunk of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
		const fields = new Map<string, string>();
		for (const line of chunk.replace(/\n[ \t]+/g, ' ').split('\n')) {
			const colon = line.indexOf(':');
			if (colon <= 0) continue;
			fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
		}
		if (fields.size > 0) blocks.push(fields);
	}
	return blocks;
}

const typeless = (value: string | undefined) => (value ? value.replace(/^[a-z0-9-]+\s*;\s*/i, '').trim() : null);

function attachmentText(attachments: Attachment[], ...types: string[]): string | null {
	const match = attachments.find((attachment) => types.includes(attachment.contentType.toLowerCase()));
	return match ? match.content.toString('utf8') : null;
}

const YOAL_ID = /^X-Yoal-Id:\s*(em_[a-z0-9]{8,64})\s*$/im;

export async function parseReport(raw: Buffer): Promise<ParsedReport> {
	const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextLinks: true, skipImageLinks: true });
	const attachments = parsed.attachments ?? [];
	const reportType = ((parsed.headers.get('content-type') as { params?: Record<string, string> } | undefined)?.params?.['report-type'] ?? '').toLowerCase();

	const feedback = attachmentText(attachments, 'message/feedback-report');
	if (feedback || reportType === 'feedback-report') {
		const fields = parseFieldBlocks(feedback ?? '')[0] ?? new Map<string, string>();
		const original = attachmentText(attachments, 'message/rfc822', 'text/rfc822-headers') ?? raw.toString('utf8');
		return {
			kind: 'arf',
			feedbackType: (fields.get('feedback-type') ?? 'abuse').toLowerCase(),
			yoalId: YOAL_ID.exec(original)?.[1]?.toLowerCase() ?? null,
			originalRecipient: typeless(fields.get('original-rcpt-to')) ?? null,
			sourceIp: fields.get('source-ip') ?? null,
		};
	}

	const status = attachmentText(attachments, 'message/delivery-status', 'message/global-delivery-status');
	if (status || reportType === 'delivery-status') {
		const blocks = parseFieldBlocks(status ?? '');
		const recipients = blocks
			.filter((block) => block.has('action') || block.has('final-recipient'))
			.map((block) => ({
				finalRecipient: typeless(block.get('final-recipient')),
				action: (block.get('action') ?? 'failed').toLowerCase(),
				status: block.get('status') ?? null,
				diagnostic: typeless(block.get('diagnostic-code')),
				remoteMta: typeless(block.get('remote-mta')),
			}));
		return { kind: 'dsn', recipients, fallbackText: parsed.text ?? '' };
	}

	const text = `${parsed.subject ?? ''}\n${parsed.text ?? ''}`;
	return { kind: 'other', text, yoalId: YOAL_ID.exec(raw.toString('utf8'))?.[1]?.toLowerCase() ?? null };
}

/** The outcome a DSN recipient block reports, or null for `delayed`/`delivered`/`relayed`. */
export function dsnOutcome(recipient: DsnRecipient): ReplyOutcome | null {
	if (recipient.action !== 'failed') return null;
	const text = [recipient.status, recipient.diagnostic].filter(Boolean).join(' ');
	const code = /\b([245]\d\d)\b/.exec(recipient.diagnostic ?? '')?.[1];
	const outcome = classifyReply(code ? Number(code) : recipient.status?.startsWith('4') ? 450 : 550, text);
	// A DSN with Action: failed is final whatever the code says.
	return outcome.kind === 'delivered' ? { kind: 'permanent', bounceClass: 'other' } : { kind: 'permanent', bounceClass: outcome.bounceClass };
}

/** A plain-text bounce without a delivery-status part (old or odd MTAs). */
export function textBounceOutcome(text: string): ReplyOutcome {
	const code = /\b(5\d\d)\b/.exec(text)?.[1];
	const outcome = classifyReply(code ? Number(code) : 550, text);
	return outcome.kind === 'delivered' ? { kind: 'permanent', bounceClass: 'other' } : { kind: 'permanent', bounceClass: outcome.bounceClass };
}
