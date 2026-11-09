<script lang="ts">
	import type { AccessPolicy, AccessPolicyRule, AccessServiceToken } from '@skiff/contracts';
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { notify, runAction } from '#lib/actions.js';
	import { formatRelative } from '../../_lib/format.js';
	import { rulesToText } from './_lib/rules.js';
	import type { PageProps } from './$types';

	type PolicyWithTokens = AccessPolicy & { serviceTokens: AccessServiceToken[] };

	let { data }: PageProps = $props();

	let createOpen = $state(false);
	let createScope = $state('org');
	let createRules = $state('allow member');
	let rulesOpen = $state(false);
	let rulesPolicy = $state<AccessPolicy | null>(null);
	let rulesText = $state('');

	let tokenOpen = $state(false);
	let tokenPolicy = $state<PolicyWithTokens | null>(null);
	let tokenName = $state('');
	let tokenHeader = $state('X-Skiff-Access-Token');
	let tokenSecret = $state('');
	let tokenError = $state('');
	let tokenPending = $state(false);

	$effect(() => {
		// Drop the one-time secret from memory when the dialog closes.
		if (!tokenOpen) {
			tokenSecret = '';
			tokenError = '';
			tokenName = '';
		}
	});

	let assignProject = $state(untrack(() => data.focusProject ?? data.projects[0]?.slug ?? ''));
	let assignTarget = $state('production');
	let assignPolicy = $state('');

	const selectedProject = $derived(data.projects.find((project) => project.slug === assignProject));
	const scopeOptions = $derived([
		{ value: 'org', label: 'Whole organisation' },
		...data.projects.map((project) => ({ value: `project:${project.id}`, label: `Project · ${project.name}` })),
		...data.projects.flatMap((project) =>
			project.environments
				.filter((environment) => environment.slug !== 'production')
				.map((environment) => ({
					value: `env:${environment.id}:${project.id}`,
					label: `Environment · ${project.name} / ${environment.name}`,
				})),
		),
	]);
	const targetOptions = $derived([
		{ value: 'production', label: 'Production' },
		{ value: 'previews', label: 'Previews' },
		...(selectedProject?.environments ?? [])
			.filter((environment) => environment.slug !== 'production')
			.map((environment) => ({ value: `env:${environment.id}`, label: environment.name })),
	]);

	function openRules(policy: AccessPolicy) {
		rulesPolicy = policy;
		rulesText = rulesToText(policy);
		rulesOpen = true;
	}

	function openServiceToken(policy: PolicyWithTokens) {
		tokenPolicy = policy;
		tokenName = '';
		tokenHeader = 'X-Skiff-Access-Token';
		tokenSecret = '';
		tokenError = '';
		tokenOpen = true;
	}

	const createServiceToken: SubmitFunction = () => {
		tokenPending = true;
		tokenError = '';
		tokenSecret = '';
		return async ({ result, update }) => {
			await update({ reset: false });
			tokenPending = false;
			if (result.type === 'success') {
				const created = result.data as { serviceToken?: string; serviceTokenHeader?: string };
				tokenSecret = created.serviceToken ?? '';
				tokenHeader = created.serviceTokenHeader ?? tokenHeader;
				notify(result);
			} else if (result.type === 'failure') {
				const message = (result.data as { message?: unknown } | undefined)?.message;
				tokenError = typeof message === 'string' ? message : 'Could not create the service token.';
			} else {
				tokenError = 'Something went wrong. Please try again.';
			}
		};
	};

	function revokeServiceToken(policy: AccessPolicy, rule: AccessPolicyRule) {
		if (rule.matcher.type !== 'serviceToken') return;
		askConfirm({
			title: `Revoke the ${rule.matcher.header} token?`,
			description:
				'The token stops working within seconds, and existing Skiff Access cookies for this policy are signed out.',
			confirmLabel: 'Revoke token',
			tone: 'danger',
			action: '?/revokeServiceToken',
			fields: { id: policy.id, idx: String(rule.idx) },
		});
	}

	function revokeMachineToken(policy: PolicyWithTokens, token: AccessServiceToken) {
		askConfirm({
			title: `Revoke the “${token.name}” machine token?`,
			description:
				'The machine stops working within seconds, and existing Skiff Access cookies for this policy are signed out.',
			confirmLabel: 'Revoke machine token',
			tone: 'danger',
			action: '?/revokeServiceToken',
			fields: { id: policy.id, tokenId: token.id },
		});
	}

	function remove(policy: AccessPolicy) {
		askConfirm({
			title: `Delete the policy “${policy.name}”?`,
			description: 'Rules are removed with it. Policies still assigned to a host cannot be deleted.',
			confirmLabel: 'Delete policy',
			tone: 'danger',
			action: '?/remove',
			fields: { id: policy.id },
		});
	}

	async function toggle(policy: AccessPolicy) {
		await runAction('?/toggle', { id: policy.id, enabled: policy.enabled ? 'false' : 'true' });
	}
</script>

<SettingsHeader
	id="access-policies"
	description="Skiff Access puts an identity-aware proxy in front of a site: Caddy asks the edge, and only a matching policy lets the visitor through. Rules are evaluated in order and a deny always wins."
>
	{#snippet actions()}
		<Button size="sm" onclick={() => (createOpen = true)}><PlusIcon />New policy</Button>
	{/snippet}
</SettingsHeader>

{#if data.denied}
	<EmptyState
		icon={ShieldCheckIcon}
		title="Access policy permission required"
		description="You need accessPolicy:read at this scope to see policies."
	/>
{:else}
	<Card.Root>
		<Card.Header>
			<Card.Title>Turn on Skiff Access</Card.Title>
			<Card.Description>
				Pick a project scope and a policy. The host switches to the <code class="font-mono text-xs">access</code>
				protection mode; clearing the policy leaves it behind platform login.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<form
				method="POST"
				action="?/assign"
				class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
				use:enhance={() =>
					async ({ result, update }) => {
						await update();
						notify(result);
					}}
			>
				<Field.Field>
					<Field.Label for="assign-project">Project</Field.Label>
					<NativeSelect.Root id="assign-project" name="project" bind:value={assignProject} required>
						{#each data.projects as project (project.id)}
							<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="assign-target">Scope</Field.Label>
					<NativeSelect.Root id="assign-target" name="target" bind:value={assignTarget}>
						{#each targetOptions as option (option.value)}
							<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="assign-policy">Policy</Field.Label>
					<NativeSelect.Root id="assign-policy" name="policyId" bind:value={assignPolicy}>
						<NativeSelect.Option value="">Off (platform login)</NativeSelect.Option>
						{#each data.policies as policy (policy.id)}
							<NativeSelect.Option value={policy.id}>{policy.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<div class="flex items-end"><Button type="submit" size="sm">Save</Button></div>
			</form>
			{#if selectedProject}
				<p class="mt-3 text-xs text-muted-foreground">
					Production: {selectedProject.productionAccess}
					{#if selectedProject.productionAccessPolicyId}· policy assigned{/if} · Previews:
					{selectedProject.previewAccess}
					{#if selectedProject.previewAccessPolicyId}· policy assigned{/if}
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	{#if data.policies.length === 0}
		<EmptyState
			icon={ShieldCheckIcon}
			title="No access policies yet"
			description="Create a policy, add ordered allow and deny rules, then assign it to a project or environment above."
		>
			<Button size="sm" onclick={() => (createOpen = true)}><PlusIcon />New policy</Button>
		</EmptyState>
	{:else}
		<div class="grid gap-4">
			{#each data.policies as policy (policy.id)}
				<Card.Root>
					<Card.Header class="flex flex-row flex-wrap items-start justify-between gap-3">
						<div class="min-w-0 space-y-1">
							<Card.Title class="flex flex-wrap items-center gap-2">
								{policy.name}
								<Badge variant="outline" class="font-mono text-[10px] uppercase">
									{policy.scope.type}
								</Badge>
								<Badge variant={policy.enabled ? 'info' : 'outline'}>
									{policy.enabled ? 'enabled' : 'disabled'}
								</Badge>
							</Card.Title>
							{#if policy.description}
								<Card.Description>{policy.description}</Card.Description>
							{/if}
						</div>
						<div class="flex flex-wrap gap-1">
							<Button variant="ghost" size="xs" onclick={() => openServiceToken(policy)}>
								<KeyRoundIcon class="size-3.5" />Machine token
							</Button>
							<Button variant="ghost" size="xs" onclick={() => toggle(policy)}>
								{policy.enabled ? 'Disable' : 'Enable'}
							</Button>
							<Button variant="ghost" size="xs" onclick={() => openRules(policy)}>
								<PencilIcon class="size-3.5" />Rules
							</Button>
							<Button variant="ghost" size="xs" aria-label="Delete policy" onclick={() => remove(policy)}>
								<Trash2Icon class="size-3.5" />
							</Button>
						</div>
					</Card.Header>
					<Card.Content>
						{#if policy.rules.length === 0}
							<p class="text-sm text-muted-foreground">No rules yet; nothing is allowed.</p>
						{:else}
							<ol class="space-y-1 font-mono text-xs">
								{#each policy.rules as rule (rule.idx)}
									<li class:opacity-60={!policy.enabled}>
										<span class="mr-2 inline-block w-6 text-right text-muted-foreground">{rule.idx + 1}.</span>
										<span class={rule.action === 'deny' ? 'text-danger' : 'text-success'}>{rule.action}</span>
										<span class="text-muted-foreground">
											{rule.matcher.type === 'emailDomain'
												? rule.matcher.domain
												: rule.matcher.type === 'email'
													? rule.matcher.email
													: rule.matcher.type === 'orgGroup'
														? rule.matcher.groupId
														: rule.matcher.type === 'ssoProvider'
															? rule.matcher.providerId
															: rule.matcher.type === 'userPool'
																? rule.matcher.poolId
																: rule.matcher.type === 'cidr'
																	? rule.matcher.cidrs.join(', ')
																	: rule.matcher.type === 'serviceToken'
																		? rule.matcher.header
																		: 'any member'}
										</span>
										{#if rule.matcher.type === 'serviceToken'}
											<Button
												variant="ghost"
												size="xs"
												class="ml-2 align-baseline"
												onclick={() => revokeServiceToken(policy, rule)}
											>
												Revoke
											</Button>
										{/if}
									</li>
								{/each}
							</ol>
						{/if}

						<div class="mt-4 border-t pt-3">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
									Machines
								</h3>
								<Button variant="ghost" size="xs" onclick={() => openServiceToken(policy)}>
									<PlusIcon class="size-3.5" />New machine token
								</Button>
							</div>
							{#if policy.serviceTokens.length === 0}
								<p class="mt-1 text-xs text-muted-foreground">
									No named machine tokens. Create one for a CI job or webhook; its secret is shown
									once.
								</p>
							{:else}
								<ul class="mt-1 divide-y text-xs">
									{#each policy.serviceTokens as token (token.id)}
										<li
											class="flex flex-wrap items-center justify-between gap-2 py-2"
											class:opacity-60={token.revokedAt !== null}
										>
											<div class="min-w-0">
												<p class="font-medium">{token.name}</p>
												<p class="font-mono text-muted-foreground">
													{token.header.toLowerCase()}
												</p>
											</div>
											<div class="flex flex-wrap items-center gap-2">
												<span class="text-muted-foreground">
													{token.lastUsedAt
														? `Last used ${formatRelative(token.lastUsedAt)}`
														: 'Never used'}
												</span>
												<Badge variant={token.revokedAt !== null ? 'outline' : 'info'}>
													{token.revokedAt !== null ? 'revoked' : 'active'}
												</Badge>
												{#if token.revokedAt === null}
													<Button
														variant="ghost"
														size="xs"
														onclick={() => revokeMachineToken(policy, token)}
													>
														Revoke
													</Button>
												{/if}
											</div>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
{/if}

<FormDialog
	bind:open={createOpen}
	icon={ShieldCheckIcon}
	title="New access policy"
	description="Rules run top to bottom; a matching deny always wins."
	action="?/create"
	submitLabel="Create policy"
>
	<Field.Group>
		<Field.Field>
			<Field.Label for="policy-name">Name</Field.Label>
			<Input id="policy-name" name="name" required maxlength={80} placeholder="Engineering staging" />
		</Field.Field>
		<Field.Field>
			<Field.Label for="policy-scope">Applies to</Field.Label>
			<NativeSelect.Root id="policy-scope" name="scope" bind:value={createScope}>
				{#each scopeOptions as option (option.value)}
					<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</Field.Field>
		<Field.Field>
			<Field.Label for="policy-description">Description (optional)</Field.Label>
			<Input id="policy-description" name="description" maxlength={500} />
		</Field.Field>
		<Field.Field>
			<Field.Label for="policy-rules">Rules, one per line</Field.Label>
			<Textarea
				id="policy-rules"
				name="rules"
				rows={6}
				bind:value={createRules}
				class="font-mono text-xs"
				placeholder={'allow domain example.com\ndeny cidr 10.0.0.0/8'}
			/>
			<Field.Description>
				Matchers: <code>member</code>, <code>group &lt;id&gt;</code>, <code>email &lt;address&gt;</code>,
				<code>domain &lt;domain&gt;</code>, <code>sso &lt;provider&gt;</code>,
				<code>pool &lt;id&gt; [groups]</code>, <code>cidr &lt;list&gt;</code>,
				<code>token &lt;header&gt; &lt;sha256&gt;</code>.
			</Field.Description>
		</Field.Field>
	</Field.Group>
</FormDialog>

<FormDialog
	bind:open={rulesOpen}
	icon={PencilIcon}
	title="Rules for {rulesPolicy?.name ?? 'policy'}"
	description="A deny anywhere in the list beats every allow."
	action="?/rules"
	submitLabel="Save rules"
>
	<input type="hidden" name="id" value={rulesPolicy?.id ?? ''} />
	<Field.Field>
		<Field.Label for="rules-edit">Rules, one per line</Field.Label>
		<Textarea id="rules-edit" name="rules" rows={10} bind:value={rulesText} class="font-mono text-xs" />
	</Field.Field>
</FormDialog>

<Dialog.Root bind:open={tokenOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<KeyRoundIcon class="size-4 text-muted-foreground" />
				Machine token for {tokenPolicy?.name ?? 'policy'}
			</Dialog.Title>
			<Dialog.Description>
				A machine sends this header pair. Only the SHA-256 of the value is stored; last use is
				reported by the edge.
			</Dialog.Description>
		</Dialog.Header>
		{#if tokenSecret}
			<div class="grid gap-3">
				<p class="text-sm font-medium">Copy this token now. It is shown once.</p>
				<div class="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
					<code class="min-w-0 flex-1 break-all font-mono text-xs">{tokenSecret}</code>
					<CopyButton value={tokenSecret} label="Copy token" iconOnly />
				</div>
				<p class="text-xs text-muted-foreground">
					Send it as <code class="font-mono">{tokenHeader.toLowerCase()}: {tokenSecret}</code>. Revoke it
					from this policy's machine list when it should stop working.
				</p>
				<Dialog.Footer>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button {...props}>Done</Button>
						{/snippet}
					</Dialog.Close>
				</Dialog.Footer>
			</div>
		{:else}
			<form method="POST" action="?/serviceToken" use:enhance={createServiceToken} class="grid gap-4">
				<input type="hidden" name="id" value={tokenPolicy?.id ?? ''} />
				<Field.Field>
					<Field.Label for="token-name">Name</Field.Label>
					<Input
						id="token-name"
						name="name"
						bind:value={tokenName}
						required
						maxlength={80}
						placeholder="GitHub Actions deploy"
					/>
					<Field.Description>
						A human name so this machine can be recognised in the list.
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="token-header">Header name</Field.Label>
					<Input
						id="token-header"
						name="header"
						bind:value={tokenHeader}
						required
						maxlength={80}
						pattern="[A-Za-z0-9-]+"
						placeholder="X-Skiff-Access-Token"
					/>
					<Field.Description>
						Most proxies pass a custom header unchanged. The value is generated for you.
					</Field.Description>
				</Field.Field>
				{#if tokenError}<p class="text-sm text-danger">{tokenError}</p>{/if}
				<Dialog.Footer>
					<Dialog.Close>
						{#snippet child({ props })}
							<Button variant="outline" {...props} disabled={tokenPending}>Cancel</Button>
						{/snippet}
					</Dialog.Close>
					<Button type="submit" disabled={tokenPending}>
						{tokenPending ? 'Creating…' : 'Create token'}
					</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
