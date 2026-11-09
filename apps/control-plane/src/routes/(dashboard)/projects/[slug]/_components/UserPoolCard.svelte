<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import {
		nextEnvPrefix,
		userPoolDefaultEnvPrefix,
		type UserPoolAttachmentView
	} from '@skiff/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Panel from '../../../_lib/Panel.svelte';
	import RowMenu from '../../../_lib/RowMenu.svelte';
	import { formatDate } from '../../../_lib/format.js';
	import EnvNames from '../../../_lib/service/EnvNames.svelte';

	/** Managed user pools attached to a process, container or function project (IAM.md I28). */
	let {
		slug,
		attachments,
		pools,
		fieldErrors = {},
		can
	}: {
		slug: string;
		attachments: UserPoolAttachmentView[];
		pools: Array<{
			name: string;
			issuer: string;
			disabled: boolean;
			clients: Array<{ name: string; clientId: string }>;
		}>;
		fieldErrors?: Record<string, string>;
		can: { readUserPools: boolean; attachUserPool: boolean };
	} = $props();

	let attachOpen = $state(false);
	let prefix = $state('AUTH');
	let poolName = $state('');
	let clientName = $state('');

	const selectedPool = $derived(pools.find((pool) => pool.name === poolName) ?? pools[0]);
	const clients = $derived(selectedPool?.clients ?? []);

	function suggestPrefix(name: string): string {
		return nextEnvPrefix(
			userPoolDefaultEnvPrefix(name || 'AUTH'),
			attachments.map((item) => item.envPrefix)
		);
	}

	function selectPool(name: string) {
		const before = suggestPrefix(poolName);
		poolName = name;
		clientName = pools.find((pool) => pool.name === name)?.clients[0]?.name ?? '';
		if (!prefix || prefix === before) prefix = suggestPrefix(name);
	}

	const createHref = $derived(
		`${resolve('/(dashboard)/settings/identity')}`
	);

	function openAttach() {
		const first = pools[0];
		poolName = first?.name ?? '';
		clientName = first?.clients[0]?.name ?? '';
		prefix = suggestPrefix(poolName);
		attachOpen = true;
	}

	function detach(item: UserPoolAttachmentView) {
		askConfirm({
			title: `Detach ${item.poolName}?`,
			description: `${slug} restarts without ${item.envPrefix}_ISSUER, ${item.envPrefix}_CLIENT_ID and ${item.envPrefix}_CLIENT_SECRET. The pool, its users and its signing key are untouched.`,
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detachUserPool',
			fields: { pool: item.poolName }
		});
	}
</script>

{#if can.readUserPools}
	<Panel
		title="User pools"
		icon={FingerprintIcon}
		count={attachments.length}
		description="A hosted OIDC issuer for this app's own users. Connection values are injected at start-up; functions also get env.AUTH.verify(request)."
		flush
	>
		{#snippet actions()}
			{#if can.attachUserPool && pools.length > 0}
				<Button size="sm" variant="outline" onclick={openAttach}><PlugIcon />Attach</Button>
			{/if}
			{#if can.attachUserPool}
				<Button size="sm" href={createHref}><PlusIcon />Manage pools</Button>
			{/if}
		{/snippet}

		{#if attachments.length === 0}
			<div class="p-4">
				<EmptyState
					icon={FingerprintIcon}
					compact
					title="No user pool attached"
					description="Attach a pool with a confidential OIDC client and this app receives SHOP_ISSUER, SHOP_CLIENT_ID and SHOP_CLIENT_SECRET at start-up."
				>
					{#if can.attachUserPool && pools.length > 0}
						<Button size="sm" onclick={openAttach}><PlugIcon />Attach a user pool</Button>
					{:else if can.attachUserPool}
						<Button size="sm" variant="outline" href={createHref}>
							<PlusIcon />Create a pool and client
						</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<ul class="divide-y">
				{#each attachments as item (item.id)}
					<li class="flex items-start gap-3 px-4 py-3">
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
							aria-hidden="true"
						>
							<FingerprintIcon class="size-4" />
						</span>
						<div class="min-w-0 flex-1 space-y-1.5">
							<div>
								<a
									href={createHref}
									class="font-mono text-sm font-medium underline-offset-4 hover:underline"
								>
									{item.poolName}
								</a>
								<p class="text-xs text-muted-foreground">
									Client <span class="font-mono">{item.clientName}</span> · injected as
									<span class="font-mono">{item.envPrefix}_*</span> · attached
									{formatDate(item.createdAt)}
								</p>
							</div>
							<EnvNames names={item.envNames} />
						</div>
						<RowMenu label="Actions for {item.poolName}">
							<DropdownMenu.Item onSelect={() => goto(createHref)}>
								<ArrowUpRightIcon />Open Identity settings
							</DropdownMenu.Item>
							{#if can.attachUserPool}
								<DropdownMenu.Separator />
								<DropdownMenu.Item variant="destructive" onSelect={() => detach(item)}>
									<UnplugIcon />Detach
								</DropdownMenu.Item>
							{/if}
						</RowMenu>
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>

	{#if can.attachUserPool && pools.length > 0}
		<FormDialog
			bind:open={attachOpen}
			icon={PlugIcon}
			title="Attach a user pool"
			description="The app restarts with the pool's issuer, client id and sealed client secret. A function also gets env.AUTH, resolved against the pool's JWKS. The issuer lives on auth.<contentDomain>, which needs the domain's wildcard DNS and certificate."
			action="?/attachUserPool"
			submitLabel="Attach"
		>
			<Field.Group>
				<Field.Field data-invalid={fieldErrors.pool ? true : undefined}>
					<Field.Label for="attach-user-pool">User pool</Field.Label>
					<NativeSelect.Root
						id="attach-user-pool"
						name="pool"
						class="w-full"
						required
						bind:value={() => poolName, selectPool}
					>
						{#each pools as pool (pool.name)}
							<NativeSelect.Option value={pool.name}>
								{pool.name} · {pool.issuer}
							</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if fieldErrors.pool}<Field.Error>{fieldErrors.pool}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={fieldErrors.client ? true : undefined}>
					<Field.Label for="attach-user-pool-client">OIDC client</Field.Label>
					<NativeSelect.Root
						id="attach-user-pool-client"
						name="client"
						class="w-full"
						required
						bind:value={clientName}
					>
						{#each clients as client (client.clientId)}
							<NativeSelect.Option value={client.name}>
								{client.name} · {client.clientId}
							</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					<Field.Description>
						Only confidential clients have a secret to inject. A public client uses PKCE and
						cannot be attached.
					</Field.Description>
					{#if fieldErrors.client}<Field.Error>{fieldErrors.client}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={fieldErrors.envPrefix ? true : undefined}>
					<Field.Label for="attach-user-pool-prefix">Env prefix</Field.Label>
					<Input
						id="attach-user-pool-prefix"
						name="envPrefix"
						bind:value={prefix}
						maxlength={64}
						autocapitalize="characters"
						spellcheck="false"
						class="font-mono text-sm uppercase"
						aria-invalid={fieldErrors.envPrefix ? 'true' : undefined}
					/>
					<Field.Description class="font-mono text-xs">
						{(prefix || 'AUTH').toUpperCase()}_ISSUER {(prefix || 'AUTH').toUpperCase()}_CLIENT_ID
						{(prefix || 'AUTH').toUpperCase()}_CLIENT_SECRET
					</Field.Description>
					{#if fieldErrors.envPrefix}<Field.Error>{fieldErrors.envPrefix}</Field.Error>{/if}
				</Field.Field>
			</Field.Group>
		</FormDialog>
	{/if}
{/if}
