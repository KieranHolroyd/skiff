<script lang="ts">
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import type { PlatformPolicies, PlatformPolicyKey } from '@skiff/contracts';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type Item = {
		key: PlatformPolicyKey;
		label: string;
		unit?: string;
		min?: number;
		max?: number;
		/** Free text (cron) instead of a number. */
		text?: boolean;
		/** Dropdown values instead of a text/number input. */
		options?: Array<{ value: string; label: string }>;
		description: string;
	};
	type Group = {
		title: string;
		description: string;
		icon: typeof ArchiveRestoreIcon;
		items: Item[];
		note?: string;
	};

	const GROUPS: Group[] = [
		{
			title: 'Retention',
			description:
				'How long deleted resources and history are kept before maintenance purges them.',
			icon: ArchiveRestoreIcon,
			items: [
				{
					key: 'trashDays',
					label: 'Trash period',
					unit: 'days',
					min: 1,
					max: 90,
					description:
						'Deleted apps, databases, storage and app volumes can be restored for this long. Applies to items deleted from now on.'
				},
				{
					key: 'retainedDeployments',
					label: 'Deployments kept per app',
					min: 1,
					max: 500,
					description:
						'Unpinned deployments kept when neither the org nor the app quota (Usage & limits) sets its own number.'
				},
				{
					key: 'logRetentionDays',
					label: 'Log retention',
					unit: 'days',
					min: 1,
					max: 90,
					description:
						'Build and runtime log lines older than this are pruned. A 500,000-line ceiling still applies.'
				},
				{
					key: 'deletedHistoryDays',
					label: 'Deleted-history retention',
					unit: 'days',
					min: 1,
					max: 365,
					description:
						'Soft-deleted deployment records, revoked share links and expired redemptions.'
				},
				{
					key: 'operationHistoryDays',
					label: 'Operation history',
					unit: 'days',
					min: 1,
					max: 365,
					description: 'Finished bulk operations and prunes shown under Settings → Maintenance.'
				}
			]
		},
		{
			title: 'New databases',
			description:
				'Backup policy given to managed databases created from now on. Each database can still change its own.',
			icon: DatabaseIcon,
			items: [
				{
					key: 'databaseBackupSchedule',
					label: 'Backup schedule',
					text: true,
					description: 'Five-field cron expression in UTC, e.g. 0 3 * * * for 03:00 daily.'
				},
				{
					key: 'databaseBackupRetentionDays',
					label: 'Backup retention',
					unit: 'days',
					min: 1,
					max: 365,
					description: 'Older backups are deleted; the newest is always kept.'
				}
			]
		},
		{
			title: 'Ingress & failover',
			description:
				'How the platform hostname follows a healthy ingress node. DNS changing requires a Cloudflare token; direct keeps the single edge.',
			icon: GlobeIcon,
			items: [
				{
					key: 'ingressDriver',
					label: 'Ingress driver',
					options: [
						{ value: 'direct', label: 'Direct — one edge' },
						{ value: 'dns-failover', label: 'DNS failover' },
						{ value: 'cloudflare-lb', label: 'Cloudflare Load Balancing' },
						{ value: 'cloudflare-tunnel', label: 'Cloudflare Tunnel' }
					],
					description: 'DNS failover maintains a record set of healthy ingress nodes; the others are documented drivers.'
				},
				{
					key: 'ingressHoldDownSeconds',
					label: 'Ingress hold-down',
					unit: 'seconds',
					min: 10,
					max: 600,
					description: 'Failed probes before an ingress is withdrawn from DNS.'
				},
				{
					key: 'ingressReaddSeconds',
					label: 'Ingress re-add hold-down',
					unit: 'seconds',
					min: 30,
					max: 3600,
					description: 'Healthy time before a recovered ingress is added back.'
				}
			]
		},
		{
			title: 'Assistant',
			description:
				'Cost caps for the dashboard assistant. Each turn can call the model and tools several times.',
			icon: SparklesIcon,
			items: [
				{
					key: 'assistantMaxRounds',
					label: 'Model calls per turn',
					min: 1,
					max: 50,
					description: 'The turn stops after this many model calls.'
				},
				{
					key: 'assistantMaxToolCalls',
					label: 'Tool calls per turn',
					min: 1,
					max: 200,
					description: 'Further tool calls are refused and the model answers with what it has.'
				},
				{
					key: 'assistantTurnsPerMinute',
					label: 'Turns per user per minute',
					min: 1,
					max: 120,
					description: 'Rate limit on starting turns, per signed-in user.'
				}
			]
		}
	];

	let values = $state<Record<PlatformPolicyKey, string>>({} as Record<PlatformPolicyKey, string>);
	let saving = $state(false);

	function seed(policies: PlatformPolicies) {
		values = Object.fromEntries(
			Object.entries(policies).map(([key, value]) => [key, String(value)])
		) as Record<PlatformPolicyKey, string>;
	}

	$effect.pre(() => seed(data.policies));

	const errors = $derived(
		((form as { fieldErrors?: Record<string, string> } | null)?.fieldErrors ?? {}) as Record<
			string,
			string
		>
	);
	/** Alert thresholds are policies too, but they are edited on Alerts → System alerts. */
	const shown = new Set(GROUPS.flatMap((group) => group.items.map((item) => item.key)));
	const changedFromDefault = $derived(
		(Object.keys(data.defaults) as PlatformPolicyKey[]).filter(
			(key) => shown.has(key) && String(data.defaults[key]) !== values[key]
		)
	);
</script>

<svelte:head><title>Policies · Settings · Skiff</title></svelte:head>

<SettingsHeader id="policies" />

<form
	method="POST"
	action="?/save"
	class="space-y-6"
	use:enhance={() => {
		saving = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			saving = false;
			if (result.type === 'success') toast.success('Policies saved');
			else if (result.type === 'failure')
				toast.error(
					String((result.data as { message?: unknown } | undefined)?.message ?? 'Could not save')
				);
		};
	}}
>
	<p class="text-sm text-muted-foreground">
		Alert thresholds (node offline, disk, certificates, database and storage limits) and which
		alerts notify are on <Button
			variant="link"
			class="h-auto p-0 align-baseline"
			href={`${resolve('/(dashboard)/alerts')}?tab=system`}>Alerts → System alerts</Button
		>.
	</p>

	{#each GROUPS as group (group.title)}
		<Panel title={group.title} description={group.description} icon={group.icon}>
			{#if group.title === 'Assistant' && !data.assistantConfigured}
				<p class="mb-4 text-sm text-muted-foreground">
					The assistant is not set up yet (Settings → Assistant). These caps apply once it is.
				</p>
			{/if}
			<div class="grid gap-5 sm:grid-cols-2">
				{#each group.items as item (item.key)}
					<Field.Field data-invalid={errors[item.key] ? true : undefined}>
						<Field.Label for={`policy-${item.key}`}>
							{item.label}
							{#if item.unit}<span class="font-normal text-muted-foreground">({item.unit})</span
								>{/if}
						</Field.Label>
						{#if item.options}
							<NativeSelect.Root
								id={`policy-${item.key}`}
								name={item.key}
								class="w-full"
								bind:value={values[item.key]}
							>
								{#each item.options as option (option.value)}
									<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
						{:else if item.text}
							<Input
								id={`policy-${item.key}`}
								name={item.key}
								required
								class="font-mono"
								bind:value={values[item.key]}
								aria-invalid={errors[item.key] ? true : undefined}
							/>
						{:else}
							<Input
								id={`policy-${item.key}`}
								name={item.key}
								type="number"
								required
								min={item.min}
								max={item.max}
								step={1}
								bind:value={values[item.key]}
								aria-invalid={errors[item.key] ? true : undefined}
							/>
						{/if}
						<Field.Description>
							{item.description}
							<span class="text-muted-foreground/80">
								Default {data.defaults[item.key]}{item.min !== undefined
									? `; ${item.min}–${item.max}`
									: ''}.
							</span>
						</Field.Description>
						{#if errors[item.key]}<Field.Error>{errors[item.key]}</Field.Error>{/if}
					</Field.Field>
				{/each}
			</div>
		</Panel>
	{/each}

	<div class="flex flex-wrap items-center justify-end gap-3">
		{#if changedFromDefault.length}
			<Button type="button" variant="ghost" onclick={() => seed(data.defaults)}
				>Reset all to defaults</Button
			>
		{/if}
		<Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
	</div>
</form>
