import { ConsoleEmailTransport, SmtpEmailTransport, type EmailTransport } from '@skiff/core';
import { smtp } from './config';

let transport: EmailTransport | undefined;

function emailTransport(): EmailTransport {
	if (transport) return transport;
	transport = smtp ? new SmtpEmailTransport(smtp) : new ConsoleEmailTransport();
	return transport;
}

/**
 * Magic-link lifetime, passed to Better Auth's plugin (auth.ts) so the email can't promise a
 * different window than the link really has. Better Auth's own default is 5 minutes.
 */
export const MAGIC_LINK_TTL_SECONDS = 10 * 60;

export async function sendMagicLinkEmail(email: string, url: string): Promise<void> {
	await emailTransport().send({
		to: email,
		subject: 'Sign in to Skiff',
		text: `Sign in to Skiff: ${url}\n\nThis link expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes. If you didn't request it, ignore this email.`,
	});
}

export async function sendInviteEmail(email: string, orgName: string, url: string): Promise<void> {
	await emailTransport().send({
		to: email,
		subject: `You're invited to ${orgName} on Skiff`,
		text: `Join ${orgName} on Skiff: ${url}`,
	});
}

export { emailTransport };
