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

export interface TwilioOptions {
	accountSid: string;
	authToken: string;
	/** An E.164 number, a Messaging Service SID (`MG…`) or an alphanumeric sender ID. */
	from: string;
	/** Tests only. */
	baseUrl?: string;
	fetch?: typeof fetch;
}

/** Twilio's REST API (2010-04-01) over plain fetch; no SDK, so it also runs in scripts/skiff-alert.ts. */
export class TwilioSmsTransport {
	private readonly baseUrl: string;
	private readonly fetch: typeof fetch;
	constructor(private readonly options: TwilioOptions) {
		this.baseUrl = options.baseUrl ?? 'https://api.twilio.com';
		this.fetch = options.fetch ?? fetch;
	}

	private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
		const auth = Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString('base64');
		const response = await this.fetch(
			`${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.options.accountSid)}${path}`,
			{
				...init,
				headers: { authorization: `Basic ${auth}`, accept: 'application/json', ...init.headers },
				signal: init.signal ?? AbortSignal.timeout(15_000),
			},
		);
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok) {
			const message = typeof body.message === 'string' ? body.message : response.statusText;
			const code = body.code ? ` (Twilio error ${body.code})` : '';
			throw new Error(`Twilio returned ${response.status}: ${message}${code}`);
		}
		return body;
	}

	/** Proves the credentials without sending (or paying for) a message. */
	async verify(): Promise<{ friendlyName: string; status: string }> {
		const account = await this.request('.json');
		if (account.status && account.status !== 'active')
			throw new Error(`the Twilio account is ${String(account.status)}`);
		return { friendlyName: String(account.friendly_name ?? ''), status: String(account.status ?? '') };
	}

	async send(to: string, body: string): Promise<{ sid: string }> {
		const form = new URLSearchParams({ To: to, Body: body });
		if (/^MG[0-9a-f]{32}$/i.test(this.options.from)) form.set('MessagingServiceSid', this.options.from);
		else form.set('From', this.options.from);
		const message = await this.request('/Messages.json', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: form,
		});
		return { sid: String(message.sid ?? '') };
	}
}

/** Two GSM-7 segments: enough for the title and the first lines of the detail. */
export const SMS_MAX_LENGTH = 306;

/**
 * One non-GSM character (a curly quote, an em dash) makes the whole message UCS-2, which cuts a
 * segment from 160 to 70 characters and roughly doubles the bill, so fold the usual ones to ASCII.
 */
export function smsBody(alert: { title: string; detail: string; severity: string }): string {
	const text = `Skiff ${alert.severity}: ${alert.title}\n${alert.detail}`
		.replace(/[‘’‚′]/g, "'")
		.replace(/[“”„″]/g, '"')
		.replace(/[–—−]/g, '-')
		.replace(/…/g, '...')
		.replace(/[→⇒]/g, '->')
		.replace(/ /g, ' ')
		.replace(/\n{2,}/g, '\n')
		.trim();
	return text.length <= SMS_MAX_LENGTH ? text : `${text.slice(0, SMS_MAX_LENGTH - 3).trimEnd()}...`;
}

export class SmsNotifier implements Notifier {
	readonly name = 'sms';
	constructor(
		private readonly transport: Pick<TwilioSmsTransport, 'send'>,
		private readonly to: readonly string[],
	) {}

	/** Sends to every recipient; throws (after trying them all) if any number failed. */
	async notify(alert: { title: string; detail: string; severity: string }): Promise<void> {
		const body = smsBody(alert);
		const results = await Promise.allSettled(this.to.map((number) => this.transport.send(number, body)));
		const failures = results.flatMap((result, index) =>
			result.status === 'rejected' ? [`${this.to[index]}: ${(result.reason as Error).message}`] : [],
		);
		if (failures.length) throw new Error(failures.join('; '));
	}
}
