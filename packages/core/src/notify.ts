import nodemailer from 'nodemailer';
import type { AlertMessage, EmailMessage, EmailTransport, Notifier } from './config.ts';
import { signatureHeaders } from './webhook-signature.ts';

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

/**
 * An IAM notification (JIT request, decision, review) on the same channels as alerts. It is not a
 * system alert: nothing is recorded in the alert history and the system-alert routing filters do
 * not apply. The payload deliberately carries identifiers and user-written text only, never a
 * credential, token or hash.
 */
export interface IamNotification {
	key: string;
	title: string;
	detail: string;
	severity?: AlertMessage['severity'];
	url?: string;
	/**
	 * Addresses of the people this notification is for (an approver, requester or reviewer). The
	 * email notifier sends to these instead of its configured address. When omitted or empty, every
	 * configured channel receives the notification as before. Addresses are never written to audit.
	 */
	recipients?: readonly string[];
}

/** The email notifier's targeted send; other notifiers only implement `notify`. */
interface TargetedNotifier extends Notifier {
	notifyTo(to: readonly string[], alert: AlertMessage): Promise<void>;
}

function isTargetedNotifier(notifier: Notifier): notifier is TargetedNotifier {
	return notifier.name === 'email' && typeof (notifier as Partial<TargetedNotifier>).notifyTo === 'function';
}

/** Normalise addresses once; a malformed recipient is dropped rather than failing the caller. */
export function notificationRecipients(addresses: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const raw of addresses ?? []) {
		const address = raw.trim().toLowerCase();
		if (!address || address.length > 320 || !address.includes('@') || /[\r\n\0]/.test(address)) continue;
		if (!out.includes(address)) out.push(address);
		if (out.length >= 50) break;
	}
	return out;
}

/**
 * Deliver an IAM notification through every configured channel. A channel failing never fails the
 * caller (the governance write has already committed), and no channel configured is a no-op.
 *
 * When the notification names recipients, the email channel sends one targeted message per address
 * and does not also send to its configured inbox. Other channels still receive the notification, so
 * a webhook or chat alert keeps working. If no address could be resolved, the email channel falls
 * back to its configured address like any other channel.
 */
export async function notifyIam(notifiers: readonly Notifier[], notification: IamNotification): Promise<void> {
	if (notifiers.length === 0) return;
	const alert: AlertMessage = {
		key: notification.key,
		title: notification.title,
		detail: notification.detail,
		severity: notification.severity ?? 'info',
		status: 'firing',
		...(notification.url ? { url: notification.url } : {}),
	};
	const recipients = notificationRecipients(notification.recipients);
	const results = await Promise.allSettled(
		notifiers.map((notifier) =>
			recipients.length > 0 && isTargetedNotifier(notifier)
				? notifier.notifyTo(recipients, alert)
				: notifier.notify(alert),
		),
	);
	for (const [index, result] of results.entries()) {
		if (result.status === 'rejected')
			console.error(`[iam] ${notifiers[index]?.name ?? 'notifier'} failed:`, result.reason);
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
		await this.notifyTo([this.to], alert);
	}

	/** Send the same alert to an explicit list (JIT/review notifications name their people). */
	async notifyTo(
		to: readonly string[],
		alert: { title: string; detail: string; severity: string },
	): Promise<void> {
		const recipients = notificationRecipients(to);
		if (recipients.length === 0) return;
		await Promise.all(
			recipients.map((recipient) =>
				this.transport.send({
					to: recipient,
					subject: `[Skiff ${alert.severity}] ${alert.title}`,
					text: alert.detail,
				}),
			),
		);
	}
}

export interface WebhookNotifierOptions {
	/** Signs each request with `X-Skiff-Signature` (`SKIFF_ALERT_WEBHOOK_SECRET`, webhook-signature.ts). */
	secret?: string;
	/** Tests only. */
	fetch?: typeof fetch;
	now?: () => number;
}

/**
 * The generic webhook body (docs/ALERTS.md §3). `title`, `message`, `severity` and `key` are the
 * original four fields; `status`, `url` and `labels` were added after them, so receivers written
 * for the first shape keep working. `url` is null only where no dashboard page exists (the host's
 * systemd failure alerts).
 */
export function webhookPayload(alert: AlertMessage): {
	title: string;
	message: string;
	severity: AlertMessage['severity'];
	key: string;
	status: 'firing' | 'resolved';
	url: string | null;
	labels: Record<string, string>;
} {
	return {
		title: `Skiff: ${alert.title}`,
		message: alert.detail,
		severity: alert.severity,
		key: alert.key,
		status: alert.status ?? 'firing',
		url: alert.url ?? null,
		labels: alert.labels ?? {},
	};
}

/** Generic webhook: ntfy, Discord, Home Assistant all accept a JSON body. */
export class WebhookNotifier implements Notifier {
	readonly name = 'webhook';
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	constructor(
		private readonly url: string,
		private readonly options: WebhookNotifierOptions = {},
	) {
		this.fetch = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}

	async notify(alert: AlertMessage): Promise<void> {
		const body = JSON.stringify(webhookPayload(alert));
		const response = await this.fetch(this.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...signatureHeaders(this.options.secret, body, this.now()) },
			body,
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
