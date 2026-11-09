import { fail, type Actions } from '@sveltejs/kit';
import type { PlatformConfigKey } from '@yoal/contracts';
import { CHAT_CHANNEL_KEYS, type ChatChannel } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { testChatChannel } from '#lib/server/platform-config.js';
import { formBoolean, formRawString, formString } from '../../_lib/errors.js';
import { collect, fieldFailure, queueConfig, requireOwnerPage } from '../_platform.server.js';

/**
 * Settings → Notifications → Chat & push channels: Discord, Slack, Telegram and ntfy. Each channel
 * is saved on its own (its keys in the `alerts` section) and is sent a test alert before saving.
 */

const CHANNELS = Object.keys(CHAT_CHANNEL_KEYS) as ChatChannel[];

const LABELS: Record<ChatChannel, string> = {
	discord: 'Discord',
	slack: 'Slack',
	telegram: 'Telegram',
	ntfy: 'ntfy'
};

export interface ChatChannelView {
	id: ChatChannel;
	label: string;
	configured: boolean;
	/** Running in this control plane (false right after saving, until the restart). */
	active: boolean;
	/** Non-secret description of where alerts go. */
	summary: string | null;
	/** Non-secret values the edit form may prefill. */
	values: Record<string, string>;
}

const env = process.env;

function summarize(channel: ChatChannel): Pick<ChatChannelView, 'configured' | 'summary' | 'values'> {
	switch (channel) {
		case 'discord': {
			const url = env.YOAL_ALERT_DISCORD_WEBHOOK;
			// The id is not a secret; the token after it is.
			const id = url && /\/webhooks\/(\d+)\//.exec(url)?.[1];
			return { configured: Boolean(url), summary: url ? `Webhook ${id ?? ''}`.trim() : null, values: {} };
		}
		case 'slack': {
			const url = env.YOAL_ALERT_SLACK_WEBHOOK;
			let host: string | null = null;
			try {
				host = url ? new URL(url).host : null;
			} catch {
				host = 'invalid URL';
			}
			return { configured: Boolean(url), summary: host ? `Incoming webhook on ${host}` : null, values: {} };
		}
		case 'telegram': {
			const chatId = env.YOAL_ALERT_TELEGRAM_CHAT_ID;
			const configured = Boolean(env.YOAL_ALERT_TELEGRAM_BOT_TOKEN && chatId);
			return {
				configured,
				summary: configured ? `Chat ${chatId}` : null,
				values: chatId ? { chatId } : {}
			};
		}
		case 'ntfy': {
			const url = env.YOAL_ALERT_NTFY_URL;
			const token = Boolean(env.YOAL_ALERT_NTFY_TOKEN);
			return {
				configured: Boolean(url),
				summary: url ? `${url}${token ? ' (with access token)' : ''}` : null,
				values: url ? { url } : {}
			};
		}
	}
}

export function chatChannelsState(): ChatChannelView[] {
	const running = new Set(core.ctx.notifiers.map((notifier) => notifier.name));
	return CHANNELS.map((id) => ({
		id,
		label: LABELS[id],
		active: running.has(id),
		...summarize(id)
	}));
}

function fieldsFor(channel: ChatChannel, data: FormData) {
	switch (channel) {
		case 'discord':
			return [
				{
					field: 'url',
					key: 'YOAL_ALERT_DISCORD_WEBHOOK' as const,
					value: formString(data, 'url'),
					secret: true,
					required: true,
					label: 'Webhook URL'
				}
			];
		case 'slack':
			return [
				{
					field: 'url',
					key: 'YOAL_ALERT_SLACK_WEBHOOK' as const,
					value: formString(data, 'url'),
					secret: true,
					required: true,
					label: 'Webhook URL'
				}
			];
		case 'telegram':
			return [
				{
					field: 'token',
					key: 'YOAL_ALERT_TELEGRAM_BOT_TOKEN' as const,
					value: formRawString(data, 'token').trim(),
					secret: true,
					required: true,
					label: 'Bot token'
				},
				{
					field: 'chatId',
					key: 'YOAL_ALERT_TELEGRAM_CHAT_ID' as const,
					value: formString(data, 'chatId'),
					required: true,
					label: 'Chat ID'
				}
			];
		case 'ntfy':
			return [
				{
					field: 'url',
					key: 'YOAL_ALERT_NTFY_URL' as const,
					value: formString(data, 'url'),
					required: true,
					label: 'Topic URL'
				},
				{
					field: 'token',
					key: 'YOAL_ALERT_NTFY_TOKEN' as const,
					value: formRawString(data, 'token').trim(),
					secret: true,
					label: 'Access token'
				}
			];
	}
}

function channelFrom(data: FormData): ChatChannel | null {
	const value = formString(data, 'channel');
	return (CHANNELS as string[]).includes(value) ? (value as ChatChannel) : null;
}

export const chatActions = {
	saveChat: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		const channel = channelFrom(data);
		if (!channel) return fail(400, { message: 'Unknown channel.' });
		const { set, unset, fieldErrors } = collect(fieldsFor(channel, data));
		if (Object.keys(fieldErrors).length) return fieldFailure(fieldErrors);
		// A secret left blank keeps the saved value; ntfy's token can also be cleared on purpose.
		if (channel === 'ntfy' && formBoolean(data, 'clearToken') && !set.YOAL_ALERT_NTFY_TOKEN)
			unset.push('YOAL_ALERT_NTFY_TOKEN');

		const merged: Record<string, string | undefined> = {};
		for (const key of CHAT_CHANNEL_KEYS[channel]) merged[key] = env[key];
		Object.assign(merged, set);
		for (const key of unset) delete merged[key];

		const result = await testChatChannel(channel, merged, locals.user?.email ?? principal.userId);
		if (!result.ok)
			return fail(400, {
				message: `Not saved — the test alert to ${LABELS[channel]} failed: ${result.error}`
			});
		return queueConfig(
			locals,
			{
				action: 'configure',
				section: 'alerts',
				set,
				unset: unset as PlatformConfigKey[]
			},
			`Test alert sent to ${LABELS[channel]}. Saving — the dashboard restarts for a few seconds.`
		);
	},

	removeChat: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const channel = channelFrom(await request.formData());
		if (!channel) return fail(400, { message: 'Unknown channel.' });
		return queueConfig(
			locals,
			{ action: 'configure', section: 'alerts', set: {}, unset: [...CHAT_CHANNEL_KEYS[channel]] },
			`Removing ${LABELS[channel]} alerts.`
		);
	},

	/** Tests the running notifier, so it proves what alerts will actually use. */
	testChat: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const channel = channelFrom(await request.formData());
		if (!channel) return fail(400, { message: 'Unknown channel.' });
		const notifier = core.ctx.notifiers.find((candidate) => candidate.name === channel);
		if (!notifier)
			return fail(409, {
				message: `${LABELS[channel]} is not active yet. If you just saved it, wait for the restart.`
			});
		try {
			await notifier.notify({
				key: 'test',
				title: 'Test alert',
				detail: `This is a test alert from Yoal, sent by ${locals.user?.email ?? principal.userId}. Real alerts look like this.`,
				severity: 'info'
			});
		} catch (error) {
			return fail(502, {
				message: `Test alert to ${LABELS[channel]} failed: ${(error as Error).message}`
			});
		}
		return { success: `Test alert sent to ${LABELS[channel]}.` };
	}
} satisfies Actions;
