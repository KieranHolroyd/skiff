import { ConsoleEmailTransport, SmtpEmailTransport, type EmailTransport } from '@skiff/core';
import { smtp } from './config';

let transport: EmailTransport | undefined;

function emailTransport(): EmailTransport {
	if (transport) return transport;
	transport = smtp ? new SmtpEmailTransport(smtp) : new ConsoleEmailTransport();
	return transport;
}

export async function sendMagicLinkEmail(email: string, url: string): Promise<void> {
	await emailTransport().send({
		to: email,
		subject: 'Sign in to Skiff',
		text: `Sign in to Skiff: ${url}\n\nThis link expires in 10 minutes. If you didn't request it, ignore this email.`,
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
