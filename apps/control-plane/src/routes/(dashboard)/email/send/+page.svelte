<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import SendIcon from '@lucide/svelte/icons/send';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import NotSetUp from '../_lib/NotSetUp.svelte';
	import type { PageProps } from './$types';

	interface SendFormResult {
		message?: string;
		values?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const area = $derived(data.emailArea);
	const failed = $derived(form as SendFormResult | null);
	const previous = $derived(failed?.values ?? {});

	let domain = $state('');
	let format = $state<'text' | 'html'>('text');
	let sending = $state(false);
	$effect(() => {
		if (!domain) domain = (data.preferred && data.domains.includes(data.preferred) ? data.preferred : data.domains[0]) ?? '';
	});

	const sandbox = $derived(data.org?.state === 'sandbox');
	const paused = $derived(data.org?.state === 'paused' || area.paused);
	const defaultBody = 'This is a test message from Skiff.\n\nIf it reached your inbox, DKIM, SPF and the mail node are working.';
</script>

<svelte:head>
	<title>Send a test · Email · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		title="Send a test"
		eyebrow="Email"
		description="Send one real message from a verified domain to check delivery end to end. It goes through the same checks as the API: limits, suppressions and the sandbox."
	/>

	{#if !area.configured}
		<NotSetUp platformAdmin={area.can.platform} compact />
	{:else if !area.can.send}
		<Notice tone="info">Sending needs the <code class="font-mono">email:send</code> permission.</Notice>
	{:else if data.domains.length === 0}
		<EmptyState
			icon={GlobeIcon}
			title="No verified sending domain"
			description="Add a domain and publish its DKIM record; once its check passes you can send from it here."
		>
			<Button href={resolve('/(dashboard)/email/domains')} variant="outline" size="sm">Go to domains</Button>
		</EmptyState>
	{:else}
		{#if paused}
			<Notice tone="warning" title="Sending is paused">
				{data.org?.pausedReason ?? 'Sends are refused until a platform admin resumes them.'}
			</Notice>
		{:else if sandbox}
			<Notice tone="info" title="Sandbox">
				This organisation is in the sandbox, so only verified recipients are accepted: addresses on your own
				domains and your team's sign-in addresses.
			</Notice>
		{/if}

		<Panel title="Message" icon={SendIcon}>
			<form
				method="POST"
				action="?/send"
				class="space-y-5"
				use:enhance={() => {
					sending = true;
					return async ({ update }) => {
						await update({ reset: false });
						sending = false;
					};
				}}
			>
				{#if failed?.message}
					<Notice tone="danger">{failed.message}</Notice>
				{/if}
				<Field.Group>
					<div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
						<Field.Field>
							<Field.Label for="from-name">From name <span class="font-normal text-muted-foreground">optional</span></Field.Label>
							<Input id="from-name" name="fromName" value={previous.fromName ?? ''} maxlength={120} placeholder="Acme" />
						</Field.Field>
						<Field.Field>
							<Field.Label for="from-local">From address</Field.Label>
							<InputGroup.Root>
								<InputGroup.Input id="from-local" name="fromLocal" value={previous.fromLocal ?? 'test'} required maxlength={64} spellcheck="false" class="font-mono text-sm" />
								<InputGroup.Addon align="inline-end" class="pr-1">
									<span class="font-mono text-sm text-muted-foreground">@</span>
									<NativeSelect.Root name="domain" bind:value={domain} aria-label="Sending domain" class="h-7 border-0 font-mono text-sm shadow-none">
										{#each data.domains as name (name)}
											<NativeSelect.Option value={name}>{name}</NativeSelect.Option>
										{/each}
									</NativeSelect.Root>
								</InputGroup.Addon>
							</InputGroup.Root>
						</Field.Field>
					</div>
					<Field.Field>
						<Field.Label for="to">To</Field.Label>
						<Input id="to" name="to" required value={previous.to ?? data.me ?? ''} placeholder="you@example.com, team@example.com" spellcheck="false" />
						<Field.Description>Separate several with commas; at most 50.</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="subject">Subject</Field.Label>
						<Input id="subject" name="subject" required maxlength={998} value={previous.subject ?? 'Skiff test message'} />
					</Field.Field>
					<Field.Field>
						<div class="flex items-center justify-between gap-3">
							<Field.Label for="body">Body</Field.Label>
							<NativeSelect.Root name="format" bind:value={format} aria-label="Body format" class="h-7 text-xs">
								<NativeSelect.Option value="text">Plain text</NativeSelect.Option>
								<NativeSelect.Option value="html">HTML</NativeSelect.Option>
							</NativeSelect.Root>
						</div>
						<Textarea
							id="body"
							name="body"
							required
							rows={10}
							value={previous.body ?? (format === 'html' ? '<p>This is a test message from <strong>Skiff</strong>.</p>' : defaultBody)}
							class={format === 'html' ? 'font-mono text-xs' : ''}
						/>
					</Field.Field>
				</Field.Group>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<p class="text-xs text-muted-foreground">
						Real recipients receive this. It is tagged <code class="font-mono">source=dashboard-test</code> in Activity.
					</p>
					<Button type="submit" disabled={sending || paused}>
						{#if sending}<Spinner />{:else}<SendIcon />{/if}
						Send message
					</Button>
				</div>
			</form>
		</Panel>
	{/if}
</div>
