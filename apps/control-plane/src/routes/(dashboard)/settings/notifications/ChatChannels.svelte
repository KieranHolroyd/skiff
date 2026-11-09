<script lang="ts">
	import BellIcon from '@lucide/svelte/icons/bell';
	import HashIcon from '@lucide/svelte/icons/hash';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import MessagesSquareIcon from '@lucide/svelte/icons/messages-square';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SendIcon from '@lucide/svelte/icons/send';
	import SettingsIcon from '@lucide/svelte/icons/settings-2';
	import type { Component } from 'svelte';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import type { PageProps } from './$types';

	type ChatChannelView = PageProps['data']['chatChannels'][number];

	/**
	 * Discord, Slack, Telegram and ntfy alert channels. Each is configured, tested and removed on
	 * its own; actions live in _chat.server.ts.
	 */
	let {
		channels,
		canEdit,
		ready,
		fieldErrors
	}: {
		channels: ChatChannelView[];
		canEdit: boolean;
		ready: boolean;
		fieldErrors: Record<string, string>;
	} = $props();

	const ICONS: Record<ChatChannelView['id'], Component<{ class?: string }>> = {
		discord: MessagesSquareIcon,
		slack: HashIcon,
		telegram: SendIcon,
		ntfy: BellIcon
	};

	const HINTS: Record<ChatChannelView['id'], string> = {
		discord: 'Rich embeds in a Discord channel; @mentions are never pinged.',
		slack: 'Slack, or any Slack-compatible incoming webhook (Mattermost, Rocket.Chat).',
		telegram: 'A message from your bot to a chat, group or channel.',
		ntfy: 'Push notifications to your phone through ntfy.sh or your own ntfy server.'
	};

	let editing = $state<ChatChannelView | null>(null);
	let open = $state(false);
	let testing = $state<string | null>(null);

	function edit(channel: ChatChannelView) {
		editing = channel;
		open = true;
	}

	async function test(channel: ChatChannelView) {
		testing = channel.id;
		await runAction('?/testChat', { channel: channel.id }, { apply: false });
		testing = null;
	}

	function remove(channel: ChatChannelView) {
		askConfirm({
			title: `Remove ${channel.label} alerts?`,
			description: `Yoal stops sending alerts to ${channel.label}. Your other channels keep working.`,
			confirmLabel: 'Remove',
			tone: 'danger',
			action: '?/removeChat',
			fields: { channel: channel.id }
		});
	}

	const connected = $derived(channels.filter((channel) => channel.configured).length);
</script>

<Panel
	title="Chat & push channels"
	icon={MessageSquareIcon}
	description="Send alerts to Discord, Slack, Telegram or ntfy. Use as many as you like."
>
	{#snippet actions()}
		<StatusBadge
			status={connected ? 'active' : 'unverified'}
			label={connected ? `${connected} connected` : 'None connected'}
		/>
	{/snippet}
	<Item.Group class="gap-2">
		{#each channels as channel (channel.id)}
			{@const Icon = ICONS[channel.id]}
			<Item.Root variant="outline" size="sm">
				<Item.Media variant="icon"><Icon /></Item.Media>
				<Item.Content class="min-w-0">
					<Item.Title>
						{channel.label}
						{#if channel.configured && !channel.active}
							<StatusBadge status="pending" label="Restart pending" />
						{:else if channel.configured}
							<StatusBadge status="active" label="Connected" />
						{/if}
					</Item.Title>
					<Item.Description class="truncate">
						{#if channel.summary}<span class="font-mono text-xs">{channel.summary}</span>
						{:else}{HINTS[channel.id]}{/if}
					</Item.Description>
				</Item.Content>
				<Item.Actions>
					{#if channel.configured}
						{#if channel.active}
							<Button
								variant="outline"
								size="sm"
								onclick={() => test(channel)}
								disabled={testing !== null}
							>
								{#if testing === channel.id}<Spinner />{:else}<SendIcon />{/if}
								Test
							</Button>
						{/if}
						{#if canEdit}
							<Button
								variant="outline"
								size="sm"
								onclick={() => edit(channel)}
								disabled={!ready}
								aria-label="Edit {channel.label}"><SettingsIcon />Edit</Button
							>
							<Button
								variant="ghost-danger"
								size="sm"
								onclick={() => remove(channel)}
								disabled={!ready}>Remove</Button
							>
						{/if}
					{:else if canEdit}
						<Button variant="outline" size="sm" onclick={() => edit(channel)} disabled={!ready}
							><PlusIcon />Connect</Button
						>
					{/if}
				</Item.Actions>
			</Item.Root>
		{/each}
	</Item.Group>
	{#snippet footer()}
		Each channel is sent a test alert before it is saved. Webhook URLs and tokens are stored as
		secrets and never shown again.
	{/snippet}
</Panel>

{#if editing}
	{@const channel = editing}
	{@const saved = channel.configured}
	<FormDialog
		bind:open
		icon={ICONS[channel.id]}
		title="{saved ? 'Edit' : 'Connect'} {channel.label}"
		description={HINTS[channel.id]}
		action="?/saveChat"
		submitLabel="Send test and save"
		size="lg"
	>
		<input type="hidden" name="channel" value={channel.id} />
		<Field.Group>
			{#if channel.id === 'discord' || channel.id === 'slack'}
				<Field.Field data-invalid={fieldErrors.url ? true : undefined}>
					<Field.Label for="chat-url">Webhook URL</Field.Label>
					<Input
						id="chat-url"
						name="url"
						type="password"
						required={!saved}
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						placeholder={saved
							? 'Saved — leave blank to keep'
							: channel.id === 'discord'
								? 'https://discord.com/api/webhooks/…'
								: 'https://hooks.slack.com/services/…'}
						aria-invalid={fieldErrors.url ? 'true' : undefined}
					/>
					{#if fieldErrors.url}<Field.Error>{fieldErrors.url}</Field.Error>
					{:else if channel.id === 'discord'}<Field.Description
							>In Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook
							URL.</Field.Description
						>
					{:else}<Field.Description
							>In Slack: create an app with Incoming Webhooks turned on, add it to a channel and
							copy the webhook URL.</Field.Description
						>{/if}
				</Field.Field>
			{:else if channel.id === 'telegram'}
				<Field.Field data-invalid={fieldErrors.token ? true : undefined}>
					<Field.Label for="chat-token">Bot token</Field.Label>
					<Input
						id="chat-token"
						name="token"
						type="password"
						required={!saved}
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						placeholder={saved ? 'Saved — leave blank to keep' : '123456789:AA…'}
						aria-invalid={fieldErrors.token ? 'true' : undefined}
					/>
					{#if fieldErrors.token}<Field.Error>{fieldErrors.token}</Field.Error>
					{:else}<Field.Description
							>Message @BotFather, send <code>/newbot</code> and paste the token it gives you.</Field.Description
						>{/if}
				</Field.Field>
				<Field.Field data-invalid={fieldErrors.chatId ? true : undefined}>
					<Field.Label for="chat-id">Chat ID</Field.Label>
					<Input
						id="chat-id"
						name="chatId"
						required
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						value={channel.values.chatId ?? ''}
						placeholder="-1001234567890 or @your_channel"
						aria-invalid={fieldErrors.chatId ? 'true' : undefined}
					/>
					{#if fieldErrors.chatId}<Field.Error>{fieldErrors.chatId}</Field.Error>
					{:else}<Field.Description
							>Send your bot a message (or add it to the group), then open
							<code>api.telegram.org/bot&lt;token&gt;/getUpdates</code> and copy
							<code>chat.id</code>.</Field.Description
						>{/if}
				</Field.Field>
			{:else if channel.id === 'ntfy'}
				<Field.Field data-invalid={fieldErrors.url ? true : undefined}>
					<Field.Label for="chat-url">Topic URL</Field.Label>
					<Input
						id="chat-url"
						name="url"
						type="url"
						required
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						value={channel.values.url ?? ''}
						placeholder="https://ntfy.sh/my-yoal-alerts"
						aria-invalid={fieldErrors.url ? 'true' : undefined}
					/>
					{#if fieldErrors.url}<Field.Error>{fieldErrors.url}</Field.Error>
					{:else}<Field.Description
							>Subscribe to the same topic in the ntfy app. On ntfy.sh anyone who knows the topic
							name can read it, so pick a long, unguessable one.</Field.Description
						>{/if}
				</Field.Field>
				<Field.Field data-invalid={fieldErrors.token ? true : undefined}>
					<Field.Label for="chat-token">Access token (optional)</Field.Label>
					<Input
						id="chat-token"
						name="token"
						type="password"
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						placeholder={channel.summary?.includes('access token')
							? 'Saved — leave blank to keep'
							: 'tk_…'}
						aria-invalid={fieldErrors.token ? 'true' : undefined}
					/>
					{#if fieldErrors.token}<Field.Error>{fieldErrors.token}</Field.Error>
					{:else}<Field.Description
							>For a protected topic on your own server (<code>ntfy token add</code>).</Field.Description
						>{/if}
				</Field.Field>
				{#if channel.summary?.includes('access token')}
					<Field.Field orientation="horizontal" class="gap-2">
						<Checkbox id="ntfy-clear-token" name="clearToken" value="1" />
						<Field.Label for="ntfy-clear-token" class="font-normal"
							>Remove the saved access token</Field.Label
						>
					</Field.Field>
				{/if}
			{/if}
		</Field.Group>
	</FormDialog>
{/if}
