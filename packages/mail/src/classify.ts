import type { EmailBounceClass } from '@skiff/contracts';

/**
 * SMTP reply classification (EMAIL.md §3.2, §7.1).
 *
 * Every remote answer becomes one of three outcomes: delivered, transient (retry later) or
 * permanent (stop). Failures also get a bounce class, which drives suppression: only
 * `invalid-recipient` and `bad-domain` suppress on the first permanent failure.
 *
 * The rules lean on the enhanced status code (RFC 3463) when the server sends one and fall back to
 * reply text, which is what most large providers put their real reason in.
 */

export type ReplyOutcome =
	| { kind: 'delivered' }
	| { kind: 'transient'; bounceClass: EmailBounceClass }
	| { kind: 'permanent'; bounceClass: EmailBounceClass };

const ENHANCED = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

const TEXT_RULES: Array<{ pattern: RegExp; bounceClass: EmailBounceClass }> = [
	{ pattern: /(user|recipient|mailbox|address|account)\s*(name\s*)?(is\s*)?(unknown|not found|does not exist|doesn't exist|invalid|unavailable|disabled|inactive|no longer|not exist)|no such (user|recipient|mailbox|address)|unknown (user|recipient|mailbox)|undeliverable address|invalid recipient|recipient rejected|user doesn.t have/i, bounceClass: 'invalid-recipient' },
	{ pattern: /(mailbox|quota|storage|inbox).{0,20}(full|exceeded|over quota)|over quota|insufficient (system )?storage/i, bounceClass: 'mailbox-full' },
	{ pattern: /(message|mail).{0,20}(too (large|big)|size exceed)|exceeds (the )?(maximum|size)/i, bounceClass: 'message-too-large' },
	{ pattern: /spamhaus|blocklist|blacklist|block list|black list|listed (at|on|in)|spam|unsolicited|reputation|poor reputation|junk|rbl|dnsbl|barracuda|spamcop/i, bounceClass: 'spam-block' },
	{ pattern: /dmarc|dkim|spf|authenticat|unauthenticated|not authorized to send|ptr|reverse dns|rdns/i, bounceClass: 'auth' },
	// Only explicit rate wording counts as throttling: it backs off the whole provider. A bare
	// "try again later" is usually greylisting, which is per recipient.
	{ pattern: /rate limit|ratelimit|rate-limit|too many (messages|connections|recipients|concurrent)|throttl|slow down|sending rate|exceeded .*(rate|limit)/i, bounceClass: 'throttled' },
	{ pattern: /domain.{0,20}(not found|does not exist|doesn't exist|invalid)|no mx|host not found|unrouteable|unroutable|bad destination/i, bounceClass: 'bad-domain' },
	{ pattern: /policy|rejected|blocked|denied|refused|not allowed|prohibited/i, bounceClass: 'policy' },
];

function classFromEnhanced(klass: string, subject: number, detail: number): EmailBounceClass | null {
	if (subject === 1) {
		if (detail === 1 || detail === 0 || detail === 6 || detail === 10) return 'invalid-recipient';
		if (detail === 2) return 'bad-domain';
		return 'other';
	}
	if (subject === 2) {
		if (detail === 2) return 'mailbox-full';
		if (detail === 3) return 'message-too-large';
		if (detail === 1) return 'invalid-recipient';
		return 'other';
	}
	if (subject === 3 && detail === 4) return 'message-too-large';
	if (subject === 4) {
		// Microsoft answers 5.4.1 "Recipient address rejected: Access denied" for addresses that do
		// not exist in the tenant (directory-based edge blocking).
		if (detail === 1 && klass === '5') return 'invalid-recipient';
		if (detail === 4) return klass === '5' ? 'bad-domain' : 'connection';
		return 'connection';
	}
	if (subject === 5) return 'protocol';
	if (subject === 7) {
		// 7.23 SPF, 7.25 reverse DNS, 7.26 unauthenticated, 7.27 SPF/null MX sender, 7.30 DKIM.
		if (detail === 23 || detail === 25 || detail === 26 || detail === 27 || detail === 30) return 'auth';
		// Gmail's 7.28: an unusual rate of unsolicited mail from this IP.
		if (detail === 28) return 'spam-block';
		return null; // 5.7.1 is used for everything from spam to policy; let the text decide.
	}
	return null;
}

/** Classify one SMTP reply (`code` is the three-digit reply, `text` the full reply text). */
export function classifyReply(code: number, text: string): ReplyOutcome {
	if (code >= 200 && code < 300) return { kind: 'delivered' };
	const enhanced = ENHANCED.exec(text);
	const permanent = code >= 500 || (enhanced?.[1] === '5' && code === 0);
	let bounceClass: EmailBounceClass | null = null;
	if (enhanced) bounceClass = classFromEnhanced(enhanced[1]!, Number(enhanced[2]), Number(enhanced[3]));
	if (!bounceClass || bounceClass === 'other') {
		const byText = TEXT_RULES.find((rule) => rule.pattern.test(text))?.bounceClass;
		if (byText) bounceClass = byText;
	}
	if (!bounceClass) bounceClass = code === 421 ? 'throttled' : 'other';
	// A 4xx throttle that says "mailbox full" is still transient; a 5xx is final whatever the text.
	return permanent ? { kind: 'permanent', bounceClass } : { kind: 'transient', bounceClass };
}

/** Network-level failures before any SMTP reply. */
export function classifyNetworkError(code: string | undefined): ReplyOutcome {
	switch (code) {
		case 'ENOTFOUND':
		case 'ENODATA':
		case 'EBADDOMAIN':
			return { kind: 'permanent', bounceClass: 'bad-domain' };
		case 'EPROTOCOL':
			return { kind: 'transient', bounceClass: 'protocol' };
		default:
			return { kind: 'transient', bounceClass: 'connection' };
	}
}
