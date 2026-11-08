<script lang="ts">
	import type { AccessPolicy } from '@skiff/contracts';
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { notify, runAction } from '#lib/actions.js';
	import { rulesToText } from './_lib/rules.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let createOpen = $state(false);
	let createScope = $state('org');
	let createRules = $state('allow member');
	let rulesOpen = $state(false);
	let rulesPolicy = $state<AccessPolicy | null>(null);
	let rulesText = $state('');

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
									</li>
								{/each}
							</ol>
						{/if}
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
