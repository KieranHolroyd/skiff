import nodemailer from 'nodemailer';
import type { EmailMessage, EmailTransport, Notifier } from './config.ts';

/** SES SMTP in v1; the interface keeps webhooks and future transports symmetric (D22). */
export class SmtpEmailTransport implements EmailTransport {
	private readonly transporter;
	constructor(
		private readonly options: {
			host: string;
			port: number;
			user: string;
			password: string;
			from: string;
			secure?: boolean;
		},
	) {
		this.transporter = nodemailer.createTransport({
			host: options.host,
			port: options.port,
			secure: options.secure ?? options.port === 465,
			auth: { user: options.user, pass: options.password },
		});
	}

	async send(message: EmailMessage): Promise<void> {
		await this.transporter.sendMail({
			from: this.options.from,
			to: message.to,
			subject: message.subject,
			text: message.text,
			html: message.html,
		});
	}
}

/** Log transport for development; never used in production. */
export class ConsoleEmailTransport implements EmailTransport {
	async send(message: EmailMessage): Promise<void> {
		console.log(`[email] to=${message.to} subject=${message.subject}\n${message.text}`);
	}
}

export class EmailNotifier implements Notifier {
	readonly name = 'email';
	constructor(
		private readonly transport: EmailTransport,
		private readonly to: string,
	) {}

	async notify(alert: { title: string; detail: string; severity: string }): Promise<void> {
		await this.transport.send({
			to: this.to,
			subject: `[Skiff ${alert.severity}] ${alert.title}`,
			text: alert.detail,
		});
	}
}

/** Generic webhook: ntfy, Discord, Home Assistant all accept a JSON body. */
export class WebhookNotifier implements Notifier {
	readonly name = 'webhook';
	constructor(private readonly url: string) {}

	async notify(alert: { key: string; title: string; detail: string; severity: string }): Promise<void> {
		const response = await fetch(this.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				title: `Skiff: ${alert.title}`,
				message: alert.detail,
				severity: alert.severity,
				key: alert.key,
			}),
		});
		if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
	}
}
