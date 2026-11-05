import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@skiff/contracts';
import { authSecret } from '../config';

/**
 * A signed, short-lived approval for one destructive assistant tool call. The chat UI shows the
 * exact tool and arguments; only a click that returns this token can execute it. The token binds
 * the action to the user (and org role) who was asked, and expires quickly.
 */

const TTL_MS = 10 * 60_000;

interface Claims {
	t: string;
	a: Record<string, unknown>;
	u: string;
	o: string;
	e: number;
}

function mac(payload: string): string {
	return createHmac('sha256', authSecret)
		.update(`skiff-assistant-confirm:${payload}`)
		.digest('base64url');
}

export function mintConfirmation(
	principal: Principal,
	tool: string,
	args: Record<string, unknown>
): string {
	const payload = Buffer.from(
		JSON.stringify({
			t: tool,
			a: args,
			u: principal.userId,
			o: principal.orgId,
			e: Date.now() + TTL_MS
		} satisfies Claims)
	).toString('base64url');
	return `${payload}.${mac(payload)}`;
}

export type ConfirmationResult =
	{ ok: true; tool: string; args: Record<string, unknown> } | { ok: false; reason: string };

export function verifyConfirmation(token: unknown, principal: Principal): ConfirmationResult {
	if (typeof token !== 'string' || token.length > 20_000)
		return { ok: false, reason: 'invalid token' };
	const [payload, signature] = token.split('.');
	if (!payload || !signature) return { ok: false, reason: 'invalid token' };
	const expected = Buffer.from(mac(payload));
	const given = Buffer.from(signature);
	if (expected.length !== given.length || !timingSafeEqual(expected, given))
		return { ok: false, reason: 'invalid token' };
	try {
		const claims = JSON.parse(
			Buffer.from(payload, 'base64url').toString('utf8')
		) as Partial<Claims>;
		if (
			typeof claims.t !== 'string' ||
			!claims.a ||
			typeof claims.a !== 'object' ||
			Array.isArray(claims.a)
		)
			return { ok: false, reason: 'invalid token' };
		if (claims.u !== principal.userId || claims.o !== principal.orgId)
			return { ok: false, reason: 'this confirmation belongs to another user' };
		if (typeof claims.e !== 'number' || claims.e <= Date.now())
			return { ok: false, reason: 'this confirmation has expired; ask again' };
		return { ok: true, tool: claims.t, args: claims.a as Record<string, unknown> };
	} catch {
		return { ok: false, reason: 'invalid token' };
	}
}
