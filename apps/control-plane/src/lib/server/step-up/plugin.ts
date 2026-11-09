import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { deleteSessionCookie } from 'better-auth/cookies';
import * as z from 'zod';
import { STEP_UP_WINDOW_MS, type Principal } from '@yoal/contracts';
import { platformOrigin, smtp } from '../config';
import { core } from '../core';
import { emailTransport } from '../email';
import { sqlite } from '../db';
import { verificationFromSession, markSessionStepUp, strongestStepUpClass } from '../step-up';
import { StepUpFailureBudget } from './failures';
import {
	emailChallengeUsable,
	emailCodeMatches,
	emailIdentifier,
	hashEmailCode,
	newEmailCode,
	parseEmailChallenge,
	passkeyIdentifier,
	StepUpResendThrottle,
	verifyTotpStep,
	totpIdentifier,
} from './challenge';
import {
	chooseMethods,
	freshUntil,
	isTotpReplay,
	isVerificationFresh,
	MAX_STEP_UP_FAILURES,
	maskEmail,
	methodClass,
	STEP_UP_CHALLENGE_TTL_MS,
	STEP_UP_EMAIL_TTL_MS,
	type StepUpEnrolment,
	type StepUpMethod,
} from './policy';
import { webAuthnServer, type StepUpAuthenticationResponse } from './webauthn';

/**
 * The step-up verification plugin (STEP-UP.md §5).
 *
 * Every verify endpoint re-checks the same-class rule against the person's *current* enrolment, so
 * `/step-up/password` with a passkey enrolled is a 403 and the rule cannot be bypassed by calling
 * the API directly. Challenges are `verification` rows bound to the session id; email codes are
 * stored hashed with a per-session resend limit. Five failed attempts across methods revoke the
 * session.
 */

const failures = new StepUpFailureBudget(MAX_STEP_UP_FAILURES);
const resendThrottle = new StepUpResendThrottle();

interface PluginSession {
	session: {
		id: string;
		userId: string;
		activeOrganizationId?: string | null;
	};
	user: {
		id: string;
		email: string;
		twoFactorEnabled?: boolean;
	};
}

function current(ctx: { context?: { session?: PluginSession } }): PluginSession {
	const session = ctx.context?.session;
	if (!session) throw new APIError('UNAUTHORIZED', { message: 'Sign in first.' });
	return session;
}

interface AdapterLike {
	// The Better Auth adapter is generic and model-typed; step-up only needs these two reads.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	findMany(input: any): Promise<unknown[]>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	findOne(input: any): Promise<unknown>;
}

async function enrolmentFor(
	ctx: { context: { adapter: AdapterLike; session: PluginSession } },
	userId: string,
): Promise<StepUpEnrolment> {
	const context = ctx.context;
	const passkeys = await context.adapter.findMany({
		model: 'passkey',
		where: [{ field: 'userId', value: userId }],
	});
	const twoFactor = (await context.adapter.findOne({
		model: 'twoFactor',
		where: [{ field: 'userId', value: userId }],
	})) as { verified?: boolean } | null;
	const accounts = await context.adapter.findMany({
		model: 'account',
		where: [{ field: 'userId', value: userId }],
	});
	const password = (accounts as Array<{ providerId?: string; password?: string | null }>).some(
		(account) => account.providerId === 'credential' && Boolean(account.password),
	);
	return {
		passkey: passkeys.length > 0,
		totp: Boolean(twoFactor && twoFactor.verified !== false) || Boolean(context.session.user.twoFactorEnabled),
		password,
		email: Boolean(smtp),
	};
}

function audit(
	userId: string,
	orgId: string | null | undefined,
	action: 'auth.step_up.succeeded' | 'auth.step_up.failed',
	outcome: 'ok' | 'error',
	args: Record<string, unknown>,
): void {
	try {
		if (orgId) {
			const principal: Principal = {
				kind: 'user',
				userId,
				orgId,
				role: 'viewer',
				permissions: new Set(),
			};
			core.audit.record({
				principal,
				action,
				resource: 'auth',
				args,
				result: outcome,
			});
			return;
		}
		// A person with no organisation has no org audit log to write to (for example an invitee).
		core.audit.record({ action, resource: 'auth', args, result: outcome });
	} catch (error) {
		console.error('[step-up] could not write the audit entry:', error);
	}
}

function orgFor(userId: string, activeOrganizationId: string | null | undefined): string | null {
	if (activeOrganizationId) return activeOrganizationId;
	try {
		const row = sqlite
			.query<{ organizationId: string }, [string]>(
				'SELECT organizationId FROM member WHERE userId = ? LIMIT 1',
			)
			.get(userId);
		return row?.organizationId ?? null;
	} catch {
		return null;
	}
}

function rejectMethod(method: StepUpMethod, choice: ReturnType<typeof chooseMethods>): never {
	throw new APIError('FORBIDDEN', {
		message: `Step-up with ${method} is not available for this account. Use ${choice.preferred ?? 'another enrolled method'}.`,
		code: 'STEP_UP_METHOD_NOT_ALLOWED',
	});
}

function revoke(cxt: unknown, sessionId: string): void {
	sqlite.run('DELETE FROM session WHERE id = ?', [sessionId]);
	failures.clear(sessionId);
	try {
		deleteSessionCookie(cxt as never);
	} catch {
		// A direct API call may not carry a cookie; the deleted row is enough.
	}
}

/** Count a failed credential attempt and revoke the session once the budget is spent. */
function failedAttempt(
	ctx: unknown,
	sessionId: string,
	userId: string,
	orgId: string | null,
	method: StepUpMethod,
	action: string | undefined,
	message: string,
): never {
	const { exhausted } = failures.record(sessionId);
	audit(userId, orgId, 'auth.step_up.failed', 'error', {
		method,
		class: methodClass(method),
		...(action ? { action } : {}),
	});
	if (exhausted) {
		revoke(ctx, sessionId);
		throw new APIError('TOO_MANY_REQUESTS', {
			message: 'Too many incorrect verification attempts. Sign in again to retry.',
			code: 'STEP_UP_FAILURES_EXHAUSTED',
		});
	}
	throw new APIError('UNAUTHORIZED', {
		message,
		code: 'STEP_UP_INVALID',
	});
}

function verified(
	ctx: { context: { session: PluginSession } },
	method: StepUpMethod,
	action: string | undefined,
): void {
	const { session, user } = ctx.context.session;
	failures.clear(session.id);
	markSessionStepUp(session.id, user.id, methodClass(method));
	audit(user.id, orgFor(user.id, session.activeOrganizationId), 'auth.step_up.succeeded', 'ok', {
		method,
		class: methodClass(method),
		...(action ? { action } : {}),
	});
}

function statusFor(ctx: { context: { session: PluginSession } }, choice: ReturnType<typeof chooseMethods>) {
	const { session, user } = ctx.context.session;
	const verification = verificationFromSession(session);
	const fresh = verification ? isVerificationFresh(verification, Date.now(), STEP_UP_WINDOW_MS) : false;
	return {
		fresh,
		class: verification?.class ?? null,
		strongest: choice.class,
		windowMs: STEP_UP_WINDOW_MS,
		freshUntil: fresh && verification ? freshUntil(verification, STEP_UP_WINDOW_MS) : null,
		preferred: choice.preferred,
		alternatives: choice.alternatives,
		email: maskEmail(user.email),
	};
}

async function sendEmailCode(userEmail: string, code: string, action: string | undefined): Promise<void> {
	const forAction = action ? `to ${action.replace(/[_-]/g, ' ')}` : 'for a sensitive action';
	await emailTransport().send({
		to: userEmail,
		subject: 'Your Yoal verification code',
		text:
			`Your Yoal verification code is ${code}.\n\n` +
			`Enter it ${forAction}. It expires in ${STEP_UP_EMAIL_TTL_MS / 60_000} minutes and can be used once. ` +
			`If you didn't ask to verify, ignore this email; nobody can continue without the code.`,
	});
}

export function stepUp(): BetterAuthPlugin {
	return {
		id: 'yoal-step-up',
		endpoints: {
			stepUpStatus: createAuthEndpoint(
				'/step-up/status',
				{ method: 'GET', use: [sessionMiddleware] },
				async (ctx) => {
					const session = current(ctx);
					const enrolment = await enrolmentFor(ctx, session.user.id);
					const choice = chooseMethods(enrolment);
					// Repair `strongest` for sessions created before a factor was added or removed.
					const strongest = strongestStepUpClass(session.user.id);
					if (strongest !== choice.class) sqlite.run('UPDATE session SET strongest = ? WHERE id = ?', [strongest, session.session.id]);
					return ctx.json(statusFor(ctx, choice));
				},
			),

			stepUpPasskeyOptions: createAuthEndpoint(
				'/step-up/passkey/options',
				{ method: 'POST', use: [sessionMiddleware] },
				async (ctx) => {
					const session = current(ctx);
					const enrolment = await enrolmentFor(ctx, session.user.id);
					const choice = chooseMethods(enrolment);
					if (!choice.methods.includes('passkey')) rejectMethod('passkey', choice);

					const passkeys = (await ctx.context.adapter.findMany({
						model: 'passkey',
						where: [{ field: 'userId', value: session.user.id }],
					})) as Array<{ credentialID: string; transports?: string | null }>;
					const options = await webAuthnServer().generateAuthenticationOptions({
						rpID: new URL(platformOrigin).hostname,
						userVerification: 'required',
						allowCredentials: passkeys.map((passkey) => ({
							id: passkey.credentialID,
							...(passkey.transports ? { transports: passkey.transports.split(',').filter(Boolean) } : {}),
						})),
					});
					const identifier = passkeyIdentifier(session.session.id);
					await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
					await ctx.context.internalAdapter.createVerificationValue({
						identifier,
						value: JSON.stringify({ challenge: options.challenge, userId: session.user.id }),
						expiresAt: new Date(Date.now() + STEP_UP_CHALLENGE_TTL_MS),
					});
					return ctx.json(options);
				},
			),

			stepUpPasskeyVerify: createAuthEndpoint(
				'/step-up/passkey/verify',
				{
					method: 'POST',
					use: [sessionMiddleware],
					body: z.object({ response: z.record(z.string(), z.any()) }),
				},
				async (ctx) => {
					const session = current(ctx);
					const enrolment = await enrolmentFor(ctx, session.user.id);
					const choice = chooseMethods(enrolment);
					if (!choice.methods.includes('passkey')) rejectMethod('passkey', choice);

					const identifier = passkeyIdentifier(session.session.id);
					const row = await ctx.context.internalAdapter.consumeVerificationValue(identifier);
					const challenge = row ? (JSON.parse(row.value) as { challenge: string; userId: string }) : null;
					if (!challenge || challenge.userId !== session.user.id)
						throw new APIError('BAD_REQUEST', {
							message: 'That passkey challenge expired. Try again.',
							code: 'STEP_UP_CHALLENGE_EXPIRED',
						});

					const response = ctx.body.response as unknown as StepUpAuthenticationResponse;
					const passkey = (await ctx.context.adapter.findOne({
						model: 'passkey',
						where: [{ field: 'credentialID', value: response.id }],
					})) as
						| { id: string; userId: string; credentialID: string; publicKey: string; counter: number; transports?: string | null }
						| null;
					if (!passkey || passkey.userId !== session.user.id)
						throw new APIError('FORBIDDEN', {
							message: 'That passkey does not belong to this account.',
							code: 'STEP_UP_PASSKEY_MISMATCH',
						});

					let verification: { verified: boolean; authenticationInfo: { newCounter: number } } | undefined;
					try {
						verification = await webAuthnServer().verifyAuthenticationResponse({
							response,
							expectedChallenge: challenge.challenge,
							expectedOrigin: platformOrigin,
							expectedRPID: new URL(platformOrigin).hostname,
							credential: {
								id: passkey.credentialID,
								publicKey: Buffer.from(passkey.publicKey, 'base64'),
								counter: passkey.counter,
								...(passkey.transports
									? { transports: passkey.transports.split(',').filter(Boolean) }
									: {}),
							},
							requireUserVerification: true,
						});
					} catch {
						failedAttempt(
							ctx,
							session.session.id,
							session.user.id,
							orgFor(session.user.id, session.session.activeOrganizationId),
							'passkey',
							undefined,
							'That passkey could not be verified. Try again.',
						);
					}
					if (!verification || !verification.verified)
						failedAttempt(
							ctx,
							session.session.id,
							session.user.id,
							orgFor(session.user.id, session.session.activeOrganizationId),
							'passkey',
							undefined,
							'That passkey could not be verified. Try again.',
						);

					await ctx.context.adapter.update({
						model: 'passkey',
						where: [{ field: 'id', value: passkey.id }],
						update: { counter: verification.authenticationInfo.newCounter },
					});
					verified(ctx, 'passkey', undefined);
					return ctx.json({ ok: true, class: 'strong', method: 'passkey' });
				},
			),

			stepUpTotp: createAuthEndpoint(
				'/step-up/totp',
				{ method: 'POST', use: [sessionMiddleware], body: z.object({ code: z.string() }) },
				async (ctx) => {
					const session = current(ctx);
					const enrolment = await enrolmentFor(ctx, session.user.id);
					const choice = chooseMethods(enrolment);
					if (!choice.methods.includes('totp')) rejectMethod('totp', choice);
					const row = (await ctx.context.adapter.findOne({
						model: 'twoFactor',
						where: [{ field: 'userId', value: session.user.id }],
					})) as { secret: string } | null;
					if (!row)
						throw new APIError('BAD_REQUEST', {
							message: 'No authenticator app is set up.',
							code: 'STEP_UP_TOTP_NOT_ENROLLED',
						});
					const secret = await symmetricDecrypt({ key: ctx.context.secretConfig, data: row.secret });
					const step = verifyTotpStep(secret, ctx.body.code);
					if (step === null)
						failedAttempt(
							ctx,
							session.session.id,
							session.user.id,
							orgFor(session.user.id, session.session.activeOrganizationId),
							'totp',
							undefined,
							'That code is not valid. Try the current code from your app.',
						);
					const lastStepRow = await ctx.context.internalAdapter.findVerificationValue(
						totpIdentifier(session.session.id),
					);
					const lastStep = lastStepRow ? Number(lastStepRow.value) : null;
					if (isTotpReplay(Number.isInteger(lastStep) ? lastStep : null, step))
						failedAttempt(
							ctx,
							session.session.id,
							session.user.id,
							orgFor(session.user.id, session.session.activeOrganizationId),
							'totp',
							undefined,
							'That code was already used. Wait for the next one.',
						);
					await ctx.context.internalAdapter.deleteVerificationByIdentifier(
						totpIdentifier(session.session.id),
					);
					await ctx.context.internalAdapter.createVerificationValue({
						identifier: totpIdentifier(session.session.id),
						value: String(step),
						expiresAt: new Date(Date.now() + STEP_UP_CHALLENGE_TTL_MS),
					});
					verified(ctx, 'totp', undefined);
					return ctx.json({ ok: true, class: 'strong', method: 'totp' });
				},
			),

			stepUpBackupCode: createAuthEndpoint(
				'/step-up/backup-code',
				{ method: 'POST', use: [sessionMiddleware], body: z.object({ code: z.string() }) },
				async (ctx) => {
					const session = current(ctx);
					const enrolment = await enrolmentFor(ctx, session.user.id);
					const choice = chooseMethods(enrolment);
					if (!choice.methods.includes('backup-code')) rejectMethod('backup-code', choice);
					const row = (await ctx.context.adapter.findOne({
						model: 'twoFactor',
						where: [{ field: 'userId', value: session.user.id }],
					})) as { id: string; backupCodes: string } | null;
					if (!row)
						throw new APIError('BAD_REQUEST', {
							message: 'No backup codes are stored for this account.',
							code: 'STEP_UP_BACKUP_CODES_NOT_ENROLLED',
						});
					let codes: string[];
					try {
						const parsed = JSON.parse(
							await symmetricDecrypt({ key: ctx.context.secretConfig, data: row.backupCodes }),
						) as unknown;
						codes = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
					} catch {
						codes = [];
					}
					const code = ctx.body.code.trim();
					if (!codes.includes(code))
						failedAttempt(
							ctx,
							session.session.id,
							session.user.id,
							orgFor(session.user.id, session.session.activeOrganizationId),
							'backup-code',
							undefined,
							'That backup code is not valid.',
						);
					const remaining = codes.filter((entry) => entry !== code);
					await ctx.context.adapter.update({
						model: 'twoFactor',
						where: [{ field: 'id', value: row.id }],
						update: {
							backupCodes: await symmetricEncrypt({
								key: ctx.context.secretConfig,
								data: JSON.stringify(remaining),
							}),
						},
					});
					verified(ctx, 'backup-code', undefined);
					return ctx.json({ ok: true, class: 'strong', method: 'backup-code', remaining: remaining.length });
				},
			),

			stepUpPassword: createAuthEndpoint(
				'/step-up/password',
				{ method: 'POST', use: [sessionMiddleware], body: z.object({ password: z.string() }) },
				async (ctx) => {
					const session = current(ctx);
					const enrolment = await enrolmentFor(ctx, session.user.id);
					const choice = chooseMethods(enrolment);
					if (!choice.methods.includes('password')) rejectMethod('password', choice);
					const account = (await ctx.context.internalAdapter.findCredentialAccount(
						session.user.id,
					)) as { password?: string | null } | null;
					if (!account?.password)
						throw new APIError('BAD_REQUEST', {
							message: 'This account has no password.',
							code: 'STEP_UP_PASSWORD_NOT_SET',
						});
					const ok = await ctx.context.password.verify({
						password: ctx.body.password,
						hash: account.password,
					});
					if (!ok)
						failedAttempt(
							ctx,
							session.session.id,
							session.user.id,
							orgFor(session.user.id, session.session.activeOrganizationId),
							'password',
							undefined,
							'That password is not correct.',
						);
					verified(ctx, 'password', undefined);
					return ctx.json({ ok: true, class: 'basic', method: 'password' });
				},
			),

			stepUpEmailSend: createAuthEndpoint(
				'/step-up/email/send',
				{ method: 'POST', use: [sessionMiddleware], body: z.object({ action: z.string().max(120).optional() }) },
				async (ctx) => {
					const session = current(ctx);
					const enrolment = await enrolmentFor(ctx, session.user.id);
					const choice = chooseMethods(enrolment);
					if (!choice.methods.includes('email')) rejectMethod('email', choice);
					if (!resendThrottle.take(session.session.id))
						throw new APIError('TOO_MANY_REQUESTS', {
							message: 'A code was sent recently. Wait a minute before asking for another.',
							code: 'STEP_UP_EMAIL_THROTTLED',
						});

					const code = newEmailCode();
					const identifier = emailIdentifier(session.session.id);
					await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
					await ctx.context.internalAdapter.createVerificationValue({
						identifier,
						value: JSON.stringify({
							hash: hashEmailCode(code),
							attempts: 0,
							expiresAt: Date.now() + STEP_UP_EMAIL_TTL_MS,
							...(ctx.body.action ? { action: ctx.body.action } : {}),
						}),
						expiresAt: new Date(Date.now() + STEP_UP_EMAIL_TTL_MS),
					});
					// Send in the background: the response time should not say whether the address accepted mail.
					void sendEmailCode(session.user.email, code, ctx.body.action).catch((error) =>
						console.error('[step-up] could not send the email code:', error),
					);
					return ctx.json({ sent: true, expiresIn: STEP_UP_EMAIL_TTL_MS / 1000 });
				},
			),

			stepUpEmailVerify: createAuthEndpoint(
				'/step-up/email/verify',
				{
					method: 'POST',
					use: [sessionMiddleware],
					body: z.object({ code: z.string(), action: z.string().max(120).optional() }),
				},
				async (ctx) => {
					const session = current(ctx);
					const enrolment = await enrolmentFor(ctx, session.user.id);
					const choice = chooseMethods(enrolment);
					if (!choice.methods.includes('email')) rejectMethod('email', choice);
					const identifier = emailIdentifier(session.session.id);
					const row = await ctx.context.internalAdapter.findVerificationValue(identifier);
					const challenge = row ? parseEmailChallenge(row.value) : null;
					if (!challenge || !emailChallengeUsable(challenge))
						throw new APIError('BAD_REQUEST', {
							message: 'That code expired. Ask for a new one.',
							code: 'STEP_UP_EMAIL_EXPIRED',
						});
					if (challenge.action && ctx.body.action && challenge.action !== ctx.body.action)
						throw new APIError('BAD_REQUEST', {
							message: 'That code was requested for a different action. Ask for a new one.',
							code: 'STEP_UP_EMAIL_ACTION_MISMATCH',
						});
					if (!emailCodeMatches(challenge.hash, ctx.body.code)) {
						await ctx.context.internalAdapter.updateVerificationByIdentifier(identifier, {
							value: JSON.stringify({ ...challenge, attempts: challenge.attempts + 1 }),
						});
						failedAttempt(
							ctx,
							session.session.id,
							session.user.id,
							orgFor(session.user.id, session.session.activeOrganizationId),
							'email',
							challenge.action,
							'That code is not correct.',
						);
					}
					await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
					verified(ctx, 'email', challenge.action);
					return ctx.json({ ok: true, class: 'basic', method: 'email' });
				},
			),

			stepUpLock: createAuthEndpoint(
				'/step-up/lock',
				{ method: 'POST', use: [sessionMiddleware] },
				async (ctx) => {
					const session = current(ctx);
					sqlite.run(
						'UPDATE session SET verificationAt = NULL, verificationClass = NULL WHERE id = ?',
						[session.session.id],
					);
					failures.clear(session.session.id);
					return ctx.json({ ok: true });
				},
			),
		},
	};
}
