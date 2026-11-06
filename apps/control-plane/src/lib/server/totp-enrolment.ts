import { auth } from './auth';
import { authErrorMessage } from './user-settings';

/**
 * Authenticator-app enrolment shared by `/two-factor`, the setup wizard and account settings.
 * Accounts without a password enrol without one; accounts with a password must re-enter it
 * (Better Auth's twoFactor rule, auth.ts).
 */

export interface TotpEnrolment {
	totpURI: string;
	/** The base32 secret from the URI, for typing into an app by hand. */
	secret: string;
	/** One-time backup codes; shown once. */
	backupCodes: string[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

export async function startTotpEnrolment(headers: Headers, password?: string): Promise<Result<TotpEnrolment>> {
	try {
		const result = await auth.api.enableTwoFactor({
			body: { issuer: 'Skiff', ...(password ? { password } : {}) },
			headers
		});
		if (!('totpURI' in result) || !result.totpURI) return { ok: false, message: 'Could not start authenticator setup.' };
		const secret = new URL(result.totpURI).searchParams.get('secret') ?? '';
		return { ok: true, value: { totpURI: result.totpURI, secret, backupCodes: result.backupCodes ?? [] } };
	} catch (error) {
		return { ok: false, message: authErrorMessage(error) };
	}
}

/** The re-entered password from a form, if any (never trimmed). */
export function formPassword(data: FormData): string | undefined {
	const value = data.get('password');
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A 6-digit code with spaces/dashes removed, or undefined when it isn't one. */
export function totpCode(data: FormData): string | undefined {
	const value = String(data.get('code') ?? '').replace(/[\s-]/g, '');
	return /^\d{6}$/.test(value) ? value : undefined;
}

/** Verify a code: finishes enrolment, or answers a challenge. Marks the session (auth.ts hook). */
export async function verifyTotpCode(headers: Headers, code: string): Promise<Result<true>> {
	try {
		await auth.api.verifyTOTP({ body: { code }, headers });
		return { ok: true, value: true };
	} catch (error) {
		return { ok: false, message: authErrorMessage(error) };
	}
}
