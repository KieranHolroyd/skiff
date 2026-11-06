import type { Notifier } from './config.ts';
import { WebhookNotifier } from './notify.ts';

/**
 * Chat and push channels for alerts: Discord, Slack (and Slack-compatible incoming webhooks such as
 * Mattermost), Telegram and ntfy. Each speaks its service's own payload, so messages render as a
 * proper message rather than a blob of JSON. Plain fetch, no SDKs, so `scripts/skiff-alert.ts` can
 * use them while the control plane is down.
 */

/** `status` and `url` are optional extras from the alert rules engine; older callers omit them. */
type Alert = Parameters<Notifier['notify']>[0] & { status?: 'firing' | 'resolved'; url?: string };
type Severity = Alert['severity'];

export interface ChatNotifierOptions {
	/** Overrides the channel name (e.g. `webhook` when a generic webhook URL turned out to be Discord). */
	name?: string;
	/** Per-request timeout; the maintenance loop awaits every notifier, so none may hang. */
	timeoutMs?: number;
	/** Tests only. */
	fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const SEVERITY = {
	critical: { color: 0xdc2626, slack: ':rotating_light:', ntfyPriority: 5, ntfyTag: 'rotating_light', label: 'Critical' },
	warning: { color: 0xf59e0b, slack: ':warning:', ntfyPriority: 4, ntfyTag: 'warning', label: 'Warning' },
	info: { color: 0x3b82f6, slack: ':information_source:', ntfyPriority: 3, ntfyTag: 'information_source', label: 'Info' },
} as const satisfies Record<Severity, unknown>;

const RESOLVED = { color: 0x16a34a, slack: ':white_check_mark:', ntfyPriority: 3, ntfyTag: 'white_check_mark', label: 'Resolved' } as const;

/** How an alert looks: a resolved alert is green whatever its severity. */
const style = (alert: Alert) => (alert.status === 'resolved' ? RESOLVED : (SEVERITY[alert.severity as Severity] ?? SEVERITY.info));

/** Only http(s) links are rendered; anything else is dropped rather than linked. */
function safeUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
	} catch {
		return null;
	}
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

abstract class HttpNotifier implements Notifier {
	readonly name: string;
	protected readonly fetch: typeof fetch;
	private readonly timeoutMs: number;

	constructor(defaultName: string, options: ChatNotifierOptions = {}) {
		this.name = options.name ?? defaultName;
		this.fetch = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	abstract notify(alert: Alert): Promise<void>;

	/**
	 * POST and throw a readable error on failure. Errors never include the URL: for Discord, Slack
	 * and Telegram the URL itself is the credential, and errors end up in logs and toasts.
	 */
	protected async post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
		let response: Response;
		try {
			response = await this.fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			const err = error as Error;
			const reason = err.name === 'TimeoutError' ? `timed out after ${this.timeoutMs / 1000}s` : 'could not connect';
			throw new Error(`${this.label} ${reason}`);
		}
		if (!response.ok) {
			const text = (await response.text().catch(() => '')).trim();
			throw new Error(`${this.label} returned ${response.status}${this.describe(text)}`);
		}
		return response;
	}

	protected abstract readonly label: string;

	/** Pull a short human reason out of an error body. */
	protected describe(text: string): string {
		if (!text) return '';
		try {
			const body = JSON.parse(text) as Record<string, unknown>;
			const message = body.description ?? body.message ?? body.error;
			if (typeof message === 'string') return `: ${truncate(message, 200)}`;
		} catch {
			// Slack answers with plain text such as `invalid_token` or `no_service`.
		}
		return /^[\x20-\x7e]{1,200}$/.test(text) ? `: ${text}` : '';
	}
}

/** Discord channel webhook (Server Settings → Integrations → Webhooks). */
export class DiscordNotifier extends HttpNotifier {
	protected readonly label = 'Discord';
	constructor(
		private readonly url: string,
		options?: ChatNotifierOptions,
	) {
		super('discord', options);
	}

	async notify(alert: Alert): Promise<void> {
		const level = style(alert);
		await this.post(this.url, {
			username: 'Skiff',
			// Alert text includes user-chosen names; never let it ping @everyone or a role.
			allowed_mentions: { parse: [] },
			embeds: [
				{
					title: truncate(alert.title, 256),
					...(safeUrl(alert.url) ? { url: safeUrl(alert.url) } : {}),
					description: truncate(alert.detail, 4096),
					color: level.color,
					footer: { text: truncate(`${level.label} · ${alert.key}`, 2048) },
					timestamp: new Date().toISOString(),
				},
			],
		});
	}
}

/** Slack's `&`, `<` and `>` are control characters (`<!channel>`, links); escape them. */
export function slackEscape(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Slack incoming webhook. Only `text` is sent, so Slack-compatible endpoints that reject unknown
 * fields (Mattermost, Rocket.Chat, Google Chat) accept it too.
 */
export class SlackNotifier extends HttpNotifier {
	protected readonly label = 'Slack';
	constructor(
		private readonly url: string,
		options?: ChatNotifierOptions,
	) {
		super('slack', options);
	}

	async notify(alert: Alert): Promise<void> {
		const level = style(alert);
		const link = safeUrl(alert.url);
		const body = truncate(`${level.slack} *${slackEscape(alert.title)}*\n${slackEscape(alert.detail)}`, 3800);
		await this.post(this.url, { text: link ? `${body}\n<${slackEscape(link)}|Open in Skiff>` : body });
	}
}

export function htmlEscape(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Telegram bot (create one with @BotFather; the chat id is a user, group or `@channel`). */
export class TelegramNotifier extends HttpNotifier {
	protected readonly label = 'Telegram';
	private readonly baseUrl: string;
	constructor(
		private readonly botToken: string,
		private readonly chatId: string,
		options?: ChatNotifierOptions & { baseUrl?: string },
	) {
		super('telegram', options);
		this.baseUrl = options?.baseUrl ?? 'https://api.telegram.org';
	}

	async notify(alert: Alert): Promise<void> {
		const level = style(alert);
		const title = `<b>${htmlEscape(`${level.label}: ${alert.title}`)}</b>`;
		const link = safeUrl(alert.url);
		await this.post(`${this.baseUrl}/bot${this.botToken}/sendMessage`, {
			chat_id: this.chatId,
			text: [title, htmlEscape(truncate(alert.detail, 3700)), link ? `<a href="${htmlEscape(link)}">Open in Skiff</a>` : '']
				.filter(Boolean)
				.join('\n'),
			parse_mode: 'HTML',
			link_preview_options: { is_disabled: true },
		});
	}
}

/**
 * ntfy topic (ntfy.sh or self-hosted). Uses JSON publishing to the server root (title, priority
 * and tags in the body), because HTTP headers cannot carry the non-Latin-1 text alerts may contain.
 */
export class NtfyNotifier extends HttpNotifier {
	protected readonly label = 'ntfy';
	private readonly endpoint: string;
	private readonly topic: string;
	constructor(
		topicUrl: string,
		private readonly token?: string,
		options?: ChatNotifierOptions,
	) {
		super('ntfy', options);
		const url = new URL(topicUrl);
		const segments = url.pathname.split('/').filter(Boolean);
		const topic = segments.pop();
		if (!topic) throw new Error('ntfy URL must include the topic, e.g. https://ntfy.sh/my-topic');
		this.topic = decodeURIComponent(topic);
		this.endpoint = `${url.origin}/${segments.join('/')}`;
	}

	async notify(alert: Alert): Promise<void> {
		const level = style(alert);
		const link = safeUrl(alert.url);
		await this.post(
			this.endpoint,
			{
				topic: this.topic,
				title: truncate(`Skiff: ${alert.title}`, 250),
				message: truncate(alert.detail, 4000),
				priority: level.ntfyPriority,
				tags: [level.ntfyTag],
				...(link ? { click: link } : {}),
			},
			this.token ? { authorization: `Bearer ${this.token}` } : {},
		);
	}
}

/** Which payload a webhook URL expects, judged by its host. */
export function webhookFormat(url: string): 'discord' | 'slack' | 'generic' {
	try {
		const { hostname, pathname } = new URL(url);
		if (/(^|\.)discord(app)?\.com$/i.test(hostname) && pathname.startsWith('/api/webhooks/')) return 'discord';
		if (hostname.toLowerCase() === 'hooks.slack.com') return 'slack';
	} catch {
		// Fall through: validated elsewhere.
	}
	return 'generic';
}

/**
 * The notifier for the generic `SKIFF_ALERT_WEBHOOK`. A Discord or Slack URL there gets that
 * service's payload, because neither accepts the generic `{title, message, …}` body (Discord needs
 * `content`/`embeds`, Slack needs `text`).
 */
export function webhookNotifierFor(url: string, options: ChatNotifierOptions = {}): Notifier {
	const format = webhookFormat(url);
	if (format === 'discord') return new DiscordNotifier(url, { name: 'webhook', ...options });
	if (format === 'slack') return new SlackNotifier(url, { name: 'webhook', ...options });
	return new WebhookNotifier(url);
}

/** Env keys per chat channel; they live in the `alerts` platform-config section. */
export const CHAT_CHANNEL_KEYS = {
	discord: ['SKIFF_ALERT_DISCORD_WEBHOOK'],
	slack: ['SKIFF_ALERT_SLACK_WEBHOOK'],
	telegram: ['SKIFF_ALERT_TELEGRAM_BOT_TOKEN', 'SKIFF_ALERT_TELEGRAM_CHAT_ID'],
	ntfy: ['SKIFF_ALERT_NTFY_URL', 'SKIFF_ALERT_NTFY_TOKEN'],
} as const;

export type ChatChannel = keyof typeof CHAT_CHANNEL_KEYS;

/** Build one chat channel's notifier from env-shaped values, or null when it is not configured. */
export function chatNotifier(
	channel: ChatChannel,
	env: Record<string, string | undefined>,
	options: ChatNotifierOptions = {},
): Notifier | null {
	switch (channel) {
		case 'discord':
			return env.SKIFF_ALERT_DISCORD_WEBHOOK ? new DiscordNotifier(env.SKIFF_ALERT_DISCORD_WEBHOOK, options) : null;
		case 'slack':
			return env.SKIFF_ALERT_SLACK_WEBHOOK ? new SlackNotifier(env.SKIFF_ALERT_SLACK_WEBHOOK, options) : null;
		case 'telegram':
			return env.SKIFF_ALERT_TELEGRAM_BOT_TOKEN && env.SKIFF_ALERT_TELEGRAM_CHAT_ID
				? new TelegramNotifier(env.SKIFF_ALERT_TELEGRAM_BOT_TOKEN, env.SKIFF_ALERT_TELEGRAM_CHAT_ID, options)
				: null;
		case 'ntfy':
			return env.SKIFF_ALERT_NTFY_URL
				? new NtfyNotifier(env.SKIFF_ALERT_NTFY_URL, env.SKIFF_ALERT_NTFY_TOKEN || undefined, options)
				: null;
	}
}

/** Every configured chat channel, in a stable order. A malformed value is logged and skipped. */
export function chatNotifiersFromEnv(env: Record<string, string | undefined>, options: ChatNotifierOptions = {}): Notifier[] {
	const notifiers: Notifier[] = [];
	for (const channel of Object.keys(CHAT_CHANNEL_KEYS) as ChatChannel[]) {
		try {
			const notifier = chatNotifier(channel, env, options);
			if (notifier) notifiers.push(notifier);
		} catch (error) {
			console.error(`[alerts] ${channel} is misconfigured: ${(error as Error).message}`);
		}
	}
	return notifiers;
}
