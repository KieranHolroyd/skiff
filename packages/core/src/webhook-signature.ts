import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signatures on outbound webhooks (alert webhook, log drains). Stripe's scheme, so receivers can
 * reuse familiar code:
 *
 *   X-Yoal-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The timestamp is inside the MAC, so a receiver that rejects old `t` values (five minutes is
 * usual) also rejects replays.
 */
export const SIGNATURE_HEADER = 'x-yoal-signature';
const DEFAULT_TOLERANCE_SECONDS = 300;

export function signWebhookBody(secret: string, body: string, timestampSeconds: number): string {
	const t = Math.floor(timestampSeconds);
	const mac = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
	return `t=${t},v1=${mac}`;
}

/** The headers to add to a signed request; empty without a secret. */
export function signatureHeaders(secret: string | undefined, body: string, nowMs = Date.now()): Record<string, string> {
	if (!secret) return {};
	return { [SIGNATURE_HEADER]: signWebhookBody(secret, body, nowMs / 1000) };
}

/**
 * Check a signature header against the raw body (for receivers and tests). Accepts several `v1`
 * values, so a receiver can verify during a secret rotation.
 */
export function verifyWebhookSignature(
	secret: string,
	body: string,
	header: string | null | undefined,
	options: { nowMs?: number; toleranceSeconds?: number } = {},
): boolean {
	if (!header) return false;
	let t: number | null = null;
	const macs: string[] = [];
	for (const part of header.split(',')) {
		const [key, value] = part.trim().split('=', 2);
		if (key === 't' && value && /^\d+$/.test(value)) t = Number(value);
		else if (key === 'v1' && value) macs.push(value);
	}
	if (t === null || macs.length === 0) return false;
	const now = (options.nowMs ?? Date.now()) / 1000;
	if (Math.abs(now - t) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;
	const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
	return macs.some((mac) => {
		const given = Buffer.from(mac);
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}
