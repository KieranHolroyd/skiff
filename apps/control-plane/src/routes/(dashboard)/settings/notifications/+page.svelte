<script lang="ts">
	import BellRingIcon from '@lucide/svelte/icons/bell-ring';
	import MailIcon from '@lucide/svelte/icons/mail';
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
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const fieldErrors = $derived(
		(form as { fieldErrors?: Record<string, string> } | null)?.fieldErrors ?? {}
	);

	let emailOpen = $state(false);
	let alertsOpen = $state(false);
	let testing = $state<'email' | 'alert' | null>(null);

	const ready = $derived(data.availability === 'ready' && !data.inFlight);
	const email = $derived(data.email.values);
	const alerts = $derived(data.alerts.values);
	const passwordSaved = $derived(data.email.secretsSet.includes('SKIFF_SMTP_PASSWORD'));

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

	function clearAlerts() {
		askConfirm({
			title: 'Turn off alerts?',
			description:
				'Node-offline, disk and failed-backup alerts are then only written to the server log.',
			confirmLabel: 'Turn off alerts',
			tone: 'danger',
			action: '?/saveAlerts',
			fields: { webhook: '', email: '' }
		});
	}

	const alertList = [
		'A node stops sending heartbeats for 2 minutes',
		'A server’s disk is more than 85% full',
		'Litestream stops backing up, or a restore drill fails'
	];
</script>

<svelte:head><title>Notifications · Settings · Skiff</title></svelte:head>

<div class="space-y-6">
	<ConfigProgress
		status={data.status}
		pending={data.pending}
		inFlight={data.inFlight}
		availability={data.availability}
		sections={['email', 'alerts']}
	/>

	<Panel
		title="Outbound email"
		icon={MailIcon}
		description="Sign-in links, invitations and email alerts. Any SMTP server works; Amazon SES is the tested default."
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
					<dd class="font-mono text-[13px] break-all">
						{email.SKIFF_SMTP_HOST}:{email.SKIFF_SMTP_PORT ?? '587'}
					</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">From</dt>
					<dd class="text-[13px] break-all">{email.SKIFF_SMTP_FROM ?? '—'}</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Username</dt>
					<dd class="font-mono text-[13px] break-all">{email.SKIFF_SMTP_USER ?? '—'}</dd>
				</div>
			</dl>
		{:else}
			<EmptyState
				icon={MailIcon}
				compact
				title="Email is not set up"
				description="Until it is, sign-in links and invitations are only written to the server log (journalctl -u skiff-control-plane)."
			>
				{#if data.availability === 'ready'}
					<Button variant="brand" onclick={() => (emailOpen = true)} disabled={!ready}
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
					{#if data.availability === 'ready'}
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
		title="Alerts"
		icon={BellRingIcon}
		description="Where Skiff tells you something needs attention."
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
					<dd class="font-mono text-[13px] break-all">{alerts.SKIFF_ALERT_WEBHOOK ?? '—'}</dd>
				</div>
				<div class="space-y-1">
					<dt class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<MailIcon class="size-3.5" />Email
					</dt>
					<dd class="text-[13px] break-all">{alerts.SKIFF_ALERT_EMAIL ?? '—'}</dd>
				</div>
			</dl>
			<div class="space-y-2">
				<p class="eyebrow">You’re alerted when</p>
				<ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
					{#each alertList as item (item)}<li>{item}</li>{/each}
				</ul>
			</div>
		</div>
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
				{#if data.availability === 'ready'}
					<Button
						variant={data.alerts.configured ? 'outline' : 'brand'}
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
	description="Use either or both. A new webhook is sent a test alert before it is saved."
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
					Receives a JSON POST with <code>title</code>, <code>message</code>, <code>severity</code>
					and <code>key</code>. Works with ntfy, Home Assistant and most chat webhooks.
				</Field.Description>{/if}
		</Field.Field>
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
	</Field.Group>
</FormDialog>
