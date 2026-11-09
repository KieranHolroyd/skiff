import { describe, expect, test } from 'bun:test';
import {
	PLATFORM_CONFIG_SECRET_KEYS,
	parsePlatformConfigRequest,
	validatePlatformConfigValue as validate,
} from './platform-config.ts';

describe('chat alert channels', () => {
	test('Discord webhook URLs', () => {
		expect(validate('YOAL_ALERT_DISCORD_WEBHOOK', 'https://discord.com/api/webhooks/123456789012/abcDEF_ghi-JKLmnopqrstu')).toBeNull();
		expect(
			validate('YOAL_ALERT_DISCORD_WEBHOOK', 'https://discordapp.com/api/webhooks/123456789012/abcDEF_ghi-JKLmnopqrstu?thread_id=98765'),
		).toBeNull();
		expect(validate('YOAL_ALERT_DISCORD_WEBHOOK', 'https://example.com/api/webhooks/1234567/abcdefghijklmnopqrstuv')).not.toBeNull();
		expect(validate('YOAL_ALERT_DISCORD_WEBHOOK', 'http://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuv')).not.toBeNull();
	});

	test('Slack-compatible webhook URLs', () => {
		expect(validate('YOAL_ALERT_SLACK_WEBHOOK', 'https://hooks.slack.com/services/T0/B0/XXXX')).toBeNull();
		expect(validate('YOAL_ALERT_SLACK_WEBHOOK', 'https://mattermost.example.com/hooks/abc')).toBeNull();
		expect(validate('YOAL_ALERT_SLACK_WEBHOOK', 'http://hooks.slack.com/services/x')).not.toBeNull();
		expect(validate('YOAL_ALERT_SLACK_WEBHOOK', 'https://u:p@hooks.slack.com/x')).not.toBeNull();
	});

	test('Telegram token and chat id', () => {
		expect(validate('YOAL_ALERT_TELEGRAM_BOT_TOKEN', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toBeNull();
		expect(validate('YOAL_ALERT_TELEGRAM_BOT_TOKEN', 'not-a-token')).not.toBeNull();
		expect(validate('YOAL_ALERT_TELEGRAM_CHAT_ID', '-1001234567890')).toBeNull();
		expect(validate('YOAL_ALERT_TELEGRAM_CHAT_ID', '@yoal_alerts')).toBeNull();
		expect(validate('YOAL_ALERT_TELEGRAM_CHAT_ID', 'yoal alerts')).not.toBeNull();
	});

	test('ntfy topic URL and token', () => {
		expect(validate('YOAL_ALERT_NTFY_URL', 'https://ntfy.sh/my-yoal-alerts')).toBeNull();
		expect(validate('YOAL_ALERT_NTFY_URL', 'http://ntfy.lan:8080/sub/alerts')).toBeNull();
		expect(validate('YOAL_ALERT_NTFY_URL', 'https://ntfy.sh/')).not.toBeNull();
		expect(validate('YOAL_ALERT_NTFY_URL', 'https://ntfy.sh/topic?auth=x')).not.toBeNull();
		expect(validate('YOAL_ALERT_NTFY_TOKEN', 'tk_AgQdq7mVBoFD37zQVN29RhuMzNIz2')).toBeNull();
		expect(validate('YOAL_ALERT_NTFY_TOKEN', 'bad token')).not.toBeNull();
	});

	test('credential-bearing keys are secret and settable from the alerts section', () => {
		for (const key of ['YOAL_ALERT_DISCORD_WEBHOOK', 'YOAL_ALERT_SLACK_WEBHOOK', 'YOAL_ALERT_TELEGRAM_BOT_TOKEN', 'YOAL_ALERT_NTFY_TOKEN'])
			expect(PLATFORM_CONFIG_SECRET_KEYS.has(key)).toBe(true);
		const parsed = parsePlatformConfigRequest({
			id: 'req_12345678',
			requestedAt: new Date().toISOString(),
			by: 'user_1',
			action: 'configure',
			section: 'alerts',
			set: { YOAL_ALERT_NTFY_URL: 'https://ntfy.sh/yoal' },
			unset: ['YOAL_ALERT_DISCORD_WEBHOOK'],
		});
		expect(parsed.ok).toBe(true);
	});
});
