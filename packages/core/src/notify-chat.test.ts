import { describe, expect, test } from 'bun:test';
import {
	DiscordNotifier,
	NtfyNotifier,
	SlackNotifier,
	TelegramNotifier,
	chatNotifiersFromEnv,
	webhookFormat,
	webhookNotifierFor,
} from './notify-chat.ts';
import { WebhookNotifier } from './notify.ts';

function stubFetch(respond: () => Response = () => new Response(null, { status: 204 })) {
	const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
	const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		calls.push({ url: String(input), init, body: JSON.parse(String(init.body)) });
		return respond();
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const alert = {
	key: 'node-offline:n1',
	title: 'Node homelab is offline',
	detail: 'No heartbeat for 3 minutes. <!channel> @everyone & co',
	severity: 'critical' as const,
};

const DISCORD = 'https://discord.com/api/webhooks/123456789/abcDEF-123_x';
const SLACK = 'https://hooks.slack.com/services/T000/B000/XXXX';

describe('DiscordNotifier', () => {
	test('sends an embed and suppresses mentions', async () => {
		const { fetch, calls } = stubFetch();
		await new DiscordNotifier(DISCORD, { fetch }).notify(alert);
		const { url, body } = calls[0]!;
		expect(url).toBe(DISCORD);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		const [embed] = body.embeds as Array<Record<string, unknown>>;
		expect(embed!.title).toBe(alert.title);
		expect(embed!.description).toBe(alert.detail);
		expect(embed!.color).toBe(0xdc2626);
	});

	test('colours resolved alerts green and links to the dashboard', async () => {
		const { fetch, calls } = stubFetch();
		await new DiscordNotifier(DISCORD, { fetch }).notify({
			...alert,
			severity: 'info',
			status: 'resolved',
			url: 'https://skiff.example.com/alerts/1',
		} as Parameters<DiscordNotifier['notify']>[0]);
		const [embed] = calls[0]!.body.embeds as Array<Record<string, unknown>>;
		expect(embed!.color).toBe(0x16a34a);
		expect(embed!.url).toBe('https://skiff.example.com/alerts/1');
	});

	test('errors never include the webhook URL (it is the credential)', async () => {
		const { fetch } = stubFetch(() => new Response(JSON.stringify({ message: 'Unknown Webhook' }), { status: 404 }));
		const error = await new DiscordNotifier(DISCORD, { fetch }).notify(alert).catch((e: Error) => e);
		expect((error as Error).message).toBe('Discord returned 404: Unknown Webhook');
		expect((error as Error).message).not.toContain('abcDEF');
	});
});

describe('SlackNotifier', () => {
	test('sends escaped mrkdwn text only', async () => {
		const { fetch, calls } = stubFetch(() => new Response('ok'));
		await new SlackNotifier(SLACK, { fetch }).notify(alert);
		const { body } = calls[0]!;
		expect(Object.keys(body)).toEqual(['text']);
		expect(body.text).toContain('*Node homelab is offline*');
		expect(body.text).toContain('&lt;!channel&gt;');
		expect(body.text).toContain('&amp; co');
		expect(body.text).not.toContain('<!channel>');
	});

	test('surfaces Slack plain-text errors', async () => {
		const { fetch } = stubFetch(() => new Response('invalid_token', { status: 403 }));
		await expect(new SlackNotifier(SLACK, { fetch }).notify(alert)).rejects.toThrow('Slack returned 403: invalid_token');
	});
});

describe('TelegramNotifier', () => {
	test('posts HTML to sendMessage', async () => {
		const { fetch, calls } = stubFetch(() => new Response(JSON.stringify({ ok: true })));
		await new TelegramNotifier('123:token', '-100200', { fetch }).notify(alert);
		const { url, body } = calls[0]!;
		expect(url).toBe('https://api.telegram.org/bot123:token/sendMessage');
		expect(body.chat_id).toBe('-100200');
		expect(body.parse_mode).toBe('HTML');
		expect(body.text).toStartWith('<b>Critical: Node homelab is offline</b>\n');
		expect(body.text).toContain('&lt;!channel&gt;');
	});

	test('reports the API description, not the token', async () => {
		const { fetch } = stubFetch(
			() => new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 }),
		);
		const error = await new TelegramNotifier('123:secret', '1', { fetch }).notify(alert).catch((e: Error) => e);
		expect((error as Error).message).toBe('Telegram returned 400: Bad Request: chat not found');
	});
});

describe('NtfyNotifier', () => {
	test('publishes JSON to the server root with priority and token', async () => {
		const { fetch, calls } = stubFetch(() => new Response('{}'));
		await new NtfyNotifier('https://ntfy.example.com/sub/skiff-alerts', 'tk_abc', { fetch }).notify(alert);
		const { url, body, init } = calls[0]!;
		expect(url).toBe('https://ntfy.example.com/sub');
		expect(body.topic).toBe('skiff-alerts');
		expect(body.priority).toBe(5);
		expect(body.tags).toEqual(['rotating_light']);
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer tk_abc');
	});

	test('rejects a URL without a topic', () => {
		expect(() => new NtfyNotifier('https://ntfy.sh/')).toThrow('topic');
	});
});

describe('factories', () => {
	test('detects Discord and Slack URLs in the generic webhook', () => {
		expect(webhookFormat(DISCORD)).toBe('discord');
		expect(webhookFormat('https://discordapp.com/api/webhooks/1/x')).toBe('discord');
		expect(webhookFormat(SLACK)).toBe('slack');
		expect(webhookFormat('https://ntfy.sh/topic')).toBe('generic');
		expect(webhookFormat('https://evil.example/discord.com/api/webhooks/1/x')).toBe('generic');

		const discord = webhookNotifierFor(DISCORD);
		expect(discord).toBeInstanceOf(DiscordNotifier);
		expect(discord.name).toBe('webhook');
		expect(webhookNotifierFor('https://ntfy.sh/topic')).toBeInstanceOf(WebhookNotifier);
	});

	test('builds only the configured channels, with stable names', () => {
		const notifiers = chatNotifiersFromEnv({
			SKIFF_ALERT_DISCORD_WEBHOOK: DISCORD,
			SKIFF_ALERT_TELEGRAM_BOT_TOKEN: '123:token',
			// Telegram needs both; without a chat id it is skipped.
			SKIFF_ALERT_NTFY_URL: 'https://ntfy.sh/skiff',
		});
		expect(notifiers.map((n) => n.name)).toEqual(['discord', 'ntfy']);
	});

	test('a times-out request fails with a readable error', async () => {
		const fetch = ((_: unknown, init: RequestInit) =>
			new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof globalThis.fetch;
		await expect(new SlackNotifier(SLACK, { fetch, timeoutMs: 20 }).notify(alert)).rejects.toThrow(
			'Slack timed out after 0.02s',
		);
	});
});
