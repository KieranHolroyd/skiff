<script lang="ts">
	import { resolve } from '$app/paths';
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import MailIcon from '@lucide/svelte/icons/mail';
	import MessageSquareTextIcon from '@lucide/svelte/icons/message-square-text';
	import SendIcon from '@lucide/svelte/icons/send';
	import SettingsIcon from '@lucide/svelte/icons/settings-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WebhookIcon from '@lucide/svelte/icons/webhook';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import ConfigProgress from '../ConfigProgress.svelte';
	import ChatChannels from './ChatChannels.svelte';
	import PushChannel from './PushChannel.svelte';
	import type { PageProps } from './$types';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';

	let { data, form }: PageProps = $props();
	const fieldErrors = $derived(
		(form as { fieldErrors?: Record<string, string> } | null)?.fieldErrors ?? {}
	);

	let emailOpen = $state(false);
	let smsOpen = $state(false);
	let alertsOpen = $state(false);
	let testing = $state<'email' | 'alert' | null>(null);

	/** Installed host (root helper) or a dev server (local settings file). */
	const canEdit = $derived(data.availability === 'ready' || data.availability === 'local');
	const ready = $derived(canEdit && !data.inFlight);
	const email = $derived(data.email.values);
	const alerts = $derived(data.alerts.values);
	const passwordSaved = $derived(data.email.secretsSet.includes('SKIFF_SMTP_PASSWORD'));
	const sms = $derived(data.sms.values);
	const authTokenSaved = $derived(data.sms.secretsSet.includes('SKIFF_TWILIO_AUTH_TOKEN'));
	const webhookSecretSaved = $derived(data.alerts.secretsSet.includes('SKIFF_ALERT_WEBHOOK_SECRET'));
	const smsNumbers = $derived(
		(alerts.SKIFF_ALERT_SMS ?? '')
			.split(',')
			.map((n) => n.trim())
			.filter(Boolean)
	);

	async function test(kind: 'email' | 'alert') {
		testing = kind;
		await runAction(kind === 'email' ? '?/testEmail' : '?/testAlert', {}, { apply: false });
		testing = null;
	}

	function removeEmail() {
		askConfirm({
			title: 'Remove the SMTP settings?',
			description:
				'Skiff stops sending email: sign-in links, invitations and email alerts are only written to the server log until you set it up again. Passkey and GitHub sign-in keep working.',
			confirmLabel: 'Remove',
			tone: 'danger',
			action: '?/removeEmail'
		});
	}

	function removeSms() {
		askConfirm({
			title: 'Remove the Twilio settings?',
			description: smsNumbers.length
				? 'SMS alerts stop. The numbers stay listed under Alerts and start receiving texts again if you set Twilio up later.'
				: 'Skiff stops being able to send SMS.',
			confirmLabel: 'Remove',
			tone: 'danger',
			action: '?/removeSms'
		});
	}

	function clearAlerts() {
		askConfirm({
			title: 'Turn off alerts?',
			description:
				'Node-offline, disk and failed-backup alerts are then only written to the server log.',
			confirmLabel: 'Turn off alerts',
			tone: 'danger',
			action: '?/saveAlerts',
			fields: { webhook: '', email: '', sms: '' }
		});
	}

</script>

<svelte:head><title>Notifications · Settings · Skiff</title></svelte:head>

<SettingsHeader id="notifications" />

<div class="space-y-6">
	<ConfigProgress
		status={data.status}
		pending={data.pending}
		inFlight={data.inFlight}
		availability={data.availability}
		restartPending={data.restartPending}
		sections={['email', 'sms', 'alerts', 'push-keys']}
	/>

	<Panel
		title="Outbound email"
		icon={MailIcon}
		description="Skiff's own mail: sign-in links, invitations and email alerts. Organisations send through the mail server in Email instead. Any SMTP server works; Amazon SES is the tested default."
	>
		{#snippet actions()}
			<StatusBadge
				status={data.email.configured ? 'active' : 'unverified'}
				label={data.email.configured ? 'Configured' : 'Not set up'}
			/>
		{/snippet}
		{#if data.email.configured}
			<dl class="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-3">
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Server</dt>
					<dd class="font-mono text-sm break-all">
						{email.SKIFF_SMTP_HOST}:{email.SKIFF_SMTP_PORT ?? '587'}
					</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">From</dt>
					<dd class="text-sm break-all">{email.SKIFF_SMTP_FROM ?? '—'}</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Username</dt>
					<dd class="font-mono text-sm break-all">{email.SKIFF_SMTP_USER ?? '—'}</dd>
				</div>
			</dl>
		{:else}
			<EmptyState
				icon={MailIcon}
				compact
				title="Email is not set up"
				description="Until it is, sign-in links and invitations are only written to the server log (journalctl -u skiff-control-plane)."
			>
				{#if canEdit}
					<Button onclick={() => (emailOpen = true)} disabled={!ready}
						><MailIcon />Set up email</Button
					>
				{/if}
			</EmptyState>
		{/if}
		{#snippet footer()}
			{#if data.email.configured}
				<div class="flex w-full flex-wrap items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onclick={() => test('email')}
						disabled={testing !== null}
					>
						{#if testing === 'email'}<Spinner />{:else}<SendIcon />{/if}
						Send test{data.adminEmail ? ` to ${data.adminEmail}` : ''}
					</Button>
					{#if canEdit}
						<Button variant="outline" size="sm" onclick={() => (emailOpen = true)} disabled={!ready}
							><SettingsIcon />Edit</Button
						>
						<span class="flex-1"></span>
						<Button variant="ghost-danger" size="sm" onclick={removeEmail} disabled={!ready}
							>Remove</Button
						>
					{/if}
				</div>
			{:else}
				For SES: use the SMTP endpoint for your region, an SMTP credential (not an IAM key), and a
				verified sender.
			{/if}
		{/snippet}
	</Panel>

	<Panel
		title="SMS"
		icon={MessageSquareTextIcon}
		description="Text alerts through your own Twilio account. Each alert is one or two SMS segments per number, billed by Twilio."
	>
		{#snippet actions()}
			<StatusBadge
				status={data.sms.configured ? 'active' : 'unverified'}
				label={data.sms.configured ? 'Configured' : 'Not set up'}
			/>
		{/snippet}
		{#if data.sms.configured}
			<dl class="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-3">
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Provider</dt>
					<dd class="text-sm">Twilio</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Account SID</dt>
					<dd class="font-mono text-sm break-all">{sms.SKIFF_TWILIO_ACCOUNT_SID}</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Sends from</dt>
					<dd class="font-mono text-sm break-all">{sms.SKIFF_TWILIO_FROM}</dd>
				</div>
			</dl>
		{:else}
			<EmptyState
				icon={MessageSquareTextIcon}
				compact
				title="SMS is not set up"
				description="Connect a Twilio account, then add phone numbers under Alerts."
			>
				{#if canEdit}
					<Button onclick={() => (smsOpen = true)} disabled={!ready}
						><MessageSquareTextIcon />Set up SMS</Button
					>
				{/if}
			</EmptyState>
		{/if}
		{#snippet footer()}
			{#if data.sms.configured}
				<div class="flex w-full flex-wrap items-center gap-2">
					{#if canEdit}
						<Button variant="outline" size="sm" onclick={() => (smsOpen = true)} disabled={!ready}
							><SettingsIcon />Edit</Button
						>
						<span class="flex-1"></span>
						<Button variant="ghost-danger" size="sm" onclick={removeSms} disabled={!ready}
							>Remove</Button
						>
					{/if}
				</div>
			{:else}
				Find the Account SID and Auth Token on your Twilio Console dashboard. Send from a Twilio
				number, a Messaging Service, or (where carriers allow it, e.g. the UK) a sender name.
			{/if}
		{/snippet}
	</Panel>

	<Panel
		title="Alert recipients"
		icon={BellRingIcon}
		description="The email address, webhook and phone numbers alerts are delivered to."
	>
		{#snippet actions()}
			<StatusBadge
				status={data.alerts.configured ? 'active' : 'unverified'}
				label={data.alerts.configured ? 'On' : 'Not set up'}
			/>
		{/snippet}
		<div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
			<dl class="space-y-4 text-sm">
				<div class="space-y-1">
					<dt class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<WebhookIcon class="size-3.5" />Webhook
					</dt>
					<dd class="font-mono text-sm break-all">{alerts.SKIFF_ALERT_WEBHOOK ?? '—'}</dd>
					{#if alerts.SKIFF_ALERT_WEBHOOK}
						<dd class="text-xs text-muted-foreground">
							{webhookSecretSaved ? 'Signed with X-Skiff-Signature' : 'Not signed'}
						</dd>
					{/if}
				</div>
				<div class="space-y-1">
					<dt class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<MailIcon class="size-3.5" />Email
					</dt>
					<dd class="text-sm break-all">{alerts.SKIFF_ALERT_EMAIL ?? '—'}</dd>
				</div>
				<div class="space-y-1">
					<dt class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<MessageSquareTextIcon class="size-3.5" />SMS
					</dt>
					<dd class="font-mono text-sm break-all">
						{smsNumbers.length ? smsNumbers.join(', ') : '—'}
					</dd>
				</div>
			</dl>
			<div class="space-y-2 text-sm text-muted-foreground">
				<p class="text-xs font-medium">What triggers an alert</p>
				<p>
					Built-in alerts (node offline, disk, certificates, backups, database and storage limits)
					and your own metric rules are managed on the Alerts page: turn each on or off, pick its
					channels and set its thresholds there.
				</p>
				<div class="flex flex-wrap gap-2 pt-1">
					<Button size="sm" variant="outline" href={`${resolve('/(dashboard)/alerts')}?tab=system`}>System alerts</Button>
					<Button size="sm" variant="outline" href={`${resolve('/(dashboard)/alerts')}?tab=rules`}>Alert rules</Button>
					<Button size="sm" variant="ghost" href={`${resolve('/(dashboard)/alerts')}?tab=channels`}>Channel status</Button>
				</div>
			</div>
		</div>
		{#if smsNumbers.length && !data.sms.configured}
			<Alert.Root variant="warning" class="mt-4">
				<TriangleAlertIcon />
				<Alert.Description
					>SMS numbers are listed but Twilio is not set up, so no texts are sent.</Alert.Description
				>
			</Alert.Root>
		{/if}
		{#if !data.alerts.configured}
			<Alert.Root variant="warning" class="mt-4">
				<TriangleAlertIcon />
				<Alert.Description
					>No alert channel is set up, so failures are only written to the server log.</Alert.Description
				>
			</Alert.Root>
		{/if}
		{#snippet footer()}
			<div class="flex w-full flex-wrap items-center gap-2">
				{#if data.alertChannels.length}
					<Button
						variant="outline"
						size="sm"
						onclick={() => test('alert')}
						disabled={testing !== null}
					>
						{#if testing === 'alert'}<Spinner />{:else}<SendIcon />{/if}
						Send test alert
					</Button>
				{/if}
				{#if canEdit}
					<Button
						variant={data.alerts.configured ? 'outline' : 'default'}
						size="sm"
						onclick={() => (alertsOpen = true)}
						disabled={!ready}
					>
						<SettingsIcon />{data.alerts.configured ? 'Edit' : 'Set up alerts'}
					</Button>
					{#if data.alerts.configured}
						<span class="flex-1"></span>
						<Button variant="ghost-danger" size="sm" onclick={clearAlerts} disabled={!ready}
							>Turn off</Button
						>
					{/if}
				{/if}
			</div>
		{/snippet}
	</Panel>

	<ChatChannels channels={data.chatChannels} {canEdit} {ready} {fieldErrors} />

	<PushChannel push={data.push} {ready} />
</div>

<FormDialog
	bind:open={emailOpen}
	icon={MailIcon}
	title={data.email.configured ? 'Edit outbound email' : 'Set up outbound email'}
	description="Skiff sends a test email to {data.adminEmail ??
		'you'} with these settings, and only saves them if it arrives at the server."
	action="?/saveEmail"
	submitLabel="Send test and save"
	size="lg"
>
	<Field.Group>
		<div class="grid gap-4 sm:grid-cols-[1fr_7rem]">
			<Field.Field data-invalid={fieldErrors.host ? true : undefined}>
				<Field.Label for="smtp-host">SMTP server</Field.Label>
				<Input
					id="smtp-host"
					name="host"
					required
					autocomplete="off"
					spellcheck={false}
					class="font-mono"
					value={email.SKIFF_SMTP_HOST ?? ''}
					placeholder="email-smtp.eu-west-2.amazonaws.com"
					aria-invalid={fieldErrors.host ? 'true' : undefined}
				/>
				{#if fieldErrors.host}<Field.Error>{fieldErrors.host}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={fieldErrors.port ? true : undefined}>
				<Field.Label for="smtp-port">Port</Field.Label>
				<Input
					id="smtp-port"
					name="port"
					inputmode="numeric"
					class="font-mono"
					value={email.SKIFF_SMTP_PORT ?? '587'}
					aria-invalid={fieldErrors.port ? 'true' : undefined}
				/>
				{#if fieldErrors.port}<Field.Error>{fieldErrors.port}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={fieldErrors.user ? true : undefined}>
				<Field.Label for="smtp-user">Username</Field.Label>
				<Input
					id="smtp-user"
					name="user"
					autocomplete="off"
					spellcheck={false}
					class="font-mono"
					value={email.SKIFF_SMTP_USER ?? ''}
				/>
				{#if fieldErrors.user}<Field.Error>{fieldErrors.user}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={fieldErrors.password ? true : undefined} class="sm:col-span-1">
				<Field.Label for="smtp-password">Password</Field.Label>
				<Input
					id="smtp-password"
					name="password"
					type="password"
					autocomplete="new-password"
					placeholder={passwordSaved ? 'Saved — leave blank to keep' : ''}
				/>
				{#if fieldErrors.password}<Field.Error>{fieldErrors.password}</Field.Error>{/if}
			</Field.Field>
		</div>
		<Field.Field data-invalid={fieldErrors.from ? true : undefined}>
			<Field.Label for="smtp-from">From</Field.Label>
			<Input
				id="smtp-from"
				name="from"
				required
				autocomplete="off"
				value={email.SKIFF_SMTP_FROM ?? ''}
				placeholder="Skiff <noreply@example.com>"
				aria-invalid={fieldErrors.from ? 'true' : undefined}
			/>
			{#if fieldErrors.from}<Field.Error>{fieldErrors.from}</Field.Error>
			{:else}<Field.Description
					>Must be a verified sender (or domain) with your provider.</Field.Description
				>{/if}
		</Field.Field>
		<Field.Field orientation="horizontal" class="gap-2">
			<Checkbox
				id="smtp-secure"
				name="secure"
				value="1"
				checked={email.SKIFF_SMTP_SECURE === '1'}
			/>
			<Field.Label for="smtp-secure" class="font-normal"
				>Use implicit TLS (port 465). Leave off for STARTTLS on 587.</Field.Label
			>
		</Field.Field>
	</Field.Group>
</FormDialog>

<FormDialog
	bind:open={alertsOpen}
	icon={BellRingIcon}
	title="Alert channels"
	description="Use any combination. A new webhook or phone number is sent a test alert before it is saved."
	action="?/saveAlerts"
	submitLabel="Save"
	size="lg"
>
	<Field.Group>
		<Field.Field data-invalid={fieldErrors.webhook ? true : undefined}>
			<Field.Label for="alert-webhook">Webhook URL</Field.Label>
			<Input
				id="alert-webhook"
				name="webhook"
				type="url"
				autocomplete="off"
				spellcheck={false}
				class="font-mono"
				value={alerts.SKIFF_ALERT_WEBHOOK ?? ''}
				placeholder="https://ntfy.sh/your-topic"
				aria-invalid={fieldErrors.webhook ? 'true' : undefined}
			/>
			{#if fieldErrors.webhook}<Field.Error>{fieldErrors.webhook}</Field.Error>
			{:else}<Field.Description>
					Receives a JSON POST with <code>title</code>, <code>message</code>, <code>severity</code>,
					<code>key</code>, <code>status</code>, <code>url</code> and <code>labels</code>. Works with
					ntfy, Home Assistant and most chat webhooks.
				</Field.Description>{/if}
		</Field.Field>
		<Field.Field data-invalid={fieldErrors.webhookSecret ? true : undefined}>
			<Field.Label for="alert-webhook-secret">Signing secret (optional)</Field.Label>
			<Input
				id="alert-webhook-secret"
				name="webhookSecret"
				type="password"
				autocomplete="new-password"
				spellcheck={false}
				class="font-mono"
				placeholder={webhookSecretSaved ? 'Saved — leave blank to keep' : 'openssl rand -hex 32'}
				aria-invalid={fieldErrors.webhookSecret ? 'true' : undefined}
			/>
			{#if fieldErrors.webhookSecret}<Field.Error>{fieldErrors.webhookSecret}</Field.Error>
			{:else}<Field.Description>
					Signs each request with an HMAC-SHA256 <code>X-Skiff-Signature</code> header, so the receiver
					can check it came from Skiff. Not used for Discord or Slack URLs.
				</Field.Description>{/if}
		</Field.Field>
		{#if webhookSecretSaved}
			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="alert-webhook-secret-remove" name="removeWebhookSecret" value="1" />
				<Field.Label for="alert-webhook-secret-remove" class="font-normal"
					>Remove the signing secret</Field.Label
				>
			</Field.Field>
		{/if}
		<Field.Field data-invalid={fieldErrors.email ? true : undefined}>
			<Field.Label for="alert-email">Email alerts to</Field.Label>
			<Input
				id="alert-email"
				name="email"
				type="email"
				autocomplete="email"
				value={alerts.SKIFF_ALERT_EMAIL ?? ''}
				placeholder={data.adminEmail ?? 'ops@example.com'}
				disabled={!data.email.configured}
				aria-invalid={fieldErrors.email ? 'true' : undefined}
			/>
			{#if fieldErrors.email}<Field.Error>{fieldErrors.email}</Field.Error>
			{:else if !data.email.configured}<Field.Description
					>Set up outbound email first.</Field.Description
				>{/if}
		</Field.Field>
		<Field.Field data-invalid={fieldErrors.sms ? true : undefined}>
			<Field.Label for="alert-sms">Text alerts to</Field.Label>
			<Input
				id="alert-sms"
				name="sms"
				type="text"
				inputmode="tel"
				autocomplete="tel"
				spellcheck={false}
				class="font-mono"
				value={smsNumbers.join(', ')}
				placeholder="+447700900123"
				disabled={!data.sms.configured}
				aria-invalid={fieldErrors.sms ? 'true' : undefined}
			/>
			{#if fieldErrors.sms}<Field.Error>{fieldErrors.sms}</Field.Error>
			{:else if !data.sms.configured}<Field.Description>Set up SMS first.</Field.Description>
			{:else}<Field.Description
					>International format, up to 5 numbers separated by commas. Each new number is sent a test
					SMS.</Field.Description
				>{/if}
		</Field.Field>
	</Field.Group>
</FormDialog>

<FormDialog
	bind:open={smsOpen}
	icon={MessageSquareTextIcon}
	title={data.sms.configured ? 'Edit SMS' : 'Set up SMS'}
	description="Skiff checks these credentials with Twilio before saving them. Nothing is sent and nothing is billed until you add a number under Alerts."
	action="?/saveSms"
	submitLabel="Verify and save"
	size="lg"
>
	<Field.Group>
		<Field.Field data-invalid={fieldErrors.accountSid ? true : undefined}>
			<Field.Label for="twilio-sid">Account SID</Field.Label>
			<Input
				id="twilio-sid"
				name="accountSid"
				required
				autocomplete="off"
				spellcheck={false}
				class="font-mono"
				value={sms.SKIFF_TWILIO_ACCOUNT_SID ?? ''}
				placeholder="AC…"
				aria-invalid={fieldErrors.accountSid ? 'true' : undefined}
			/>
			{#if fieldErrors.accountSid}<Field.Error>{fieldErrors.accountSid}</Field.Error>{/if}
		</Field.Field>
		<Field.Field data-invalid={fieldErrors.authToken ? true : undefined}>
			<Field.Label for="twilio-token">Auth Token</Field.Label>
			<Input
				id="twilio-token"
				name="authToken"
				type="password"
				autocomplete="new-password"
				class="font-mono"
				required={!authTokenSaved}
				placeholder={authTokenSaved ? 'Saved — leave blank to keep' : ''}
				aria-invalid={fieldErrors.authToken ? 'true' : undefined}
			/>
			{#if fieldErrors.authToken}<Field.Error>{fieldErrors.authToken}</Field.Error>{/if}
		</Field.Field>
		<Field.Field data-invalid={fieldErrors.from ? true : undefined}>
			<Field.Label for="twilio-from">Send from</Field.Label>
			<Input
				id="twilio-from"
				name="from"
				required
				autocomplete="off"
				spellcheck={false}
				class="font-mono"
				value={sms.SKIFF_TWILIO_FROM ?? ''}
				placeholder="+447700900000"
				aria-invalid={fieldErrors.from ? 'true' : undefined}
			/>
			{#if fieldErrors.from}<Field.Error>{fieldErrors.from}</Field.Error>
			{:else}<Field.Description
					>A Twilio phone number, a Messaging Service SID (<code>MG…</code>), or a sender name of up
					to 11 letters and digits where your recipients' carriers support it.</Field.Description
				>{/if}
		</Field.Field>
	</Field.Group>
</FormDialog>
