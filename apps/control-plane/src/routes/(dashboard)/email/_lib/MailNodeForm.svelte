<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { notify } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	/**
	 * Pick the mail node and the IPv4 it sends from (EMAIL.md §3.1). Posts to the page's `node`
	 * action, which both the overview and Email → Mail server spread in from mail-server.server.ts.
	 */
	let {
		nodes,
		nodeId: savedNodeId,
		ip: savedIp,
		enabled,
		turnOff = false
	}: {
		nodes: { id: string; name: string; mode: string; mail: boolean }[];
		nodeId: string | null;
		ip: string | null;
		enabled: boolean;
		/** Offer "Turn off" once a node is chosen (Mail server only). */
		turnOff?: boolean;
	} = $props();

	let nodeId = $state('');
	let ipInput = $state('');
	let saving = $state(false);
	$effect.pre(() => {
		nodeId = savedNodeId ?? '';
		ipInput = savedIp ?? '';
	});

	function confirmTurnOff() {
		askConfirm({
			title: 'Turn email off?',
			description:
				'No node sends or receives mail. Queued messages stay on the old mail node until one is picked again; every send is refused meanwhile.',
			confirmLabel: 'Turn off',
			tone: 'danger',
			action: '?/node',
			fields: { nodeId: '' }
		});
	}
</script>

<form
	method="POST"
	action="?/node"
	class="flex flex-wrap items-end gap-3"
	use:enhance={() => {
		saving = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			saving = false;
			notify(result);
		};
	}}
>
	<Field.Field class="min-w-64 flex-1">
		<Field.Label for="mail-node">Node</Field.Label>
		<NativeSelect.Root
			id="mail-node"
			name="nodeId"
			bind:value={nodeId}
			class="w-full"
			disabled={!enabled}
		>
			<NativeSelect.Option value="" disabled={savedNodeId !== null}
				>Pick a node…</NativeSelect.Option
			>
			{#each nodes as node (node.id)}
				<NativeSelect.Option value={node.id} disabled={!node.mail}>
					{node.name} · {node.mode}{node.mail ? '' : ' — update its agent'}
				</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
	</Field.Field>
	<Field.Field class="w-44">
		<Field.Label for="mail-ip">Public IPv4</Field.Label>
		<InputGroup.Root>
			<InputGroup.Input
				id="mail-ip"
				name="ip"
				bind:value={ipInput}
				placeholder="203.0.113.10"
				inputmode="decimal"
				autocomplete="off"
				class="font-mono"
				disabled={!enabled}
			/>
		</InputGroup.Root>
	</Field.Field>
	<Button
		type="submit"
		disabled={!enabled ||
			saving ||
			!nodeId ||
			(nodeId === savedNodeId && ipInput.trim() === (savedIp ?? ''))}
	>
		{#if saving}<Spinner />{/if}
		{!savedNodeId ? 'Use this node' : nodeId === savedNodeId ? 'Save' : 'Move mail node'}
	</Button>
	{#if turnOff && savedNodeId}
		<Button variant="outline" onclick={confirmTurnOff} disabled={!enabled}>Turn off</Button>
	{/if}
</form>
<p class="mt-3 text-xs text-muted-foreground">
	The IP the node sends from, the one its provider sets reverse DNS on. Left blank, Skiff uses a
	public IPv4 in the node's address, or for the edge the platform host's record in the Cloudflare
	zone, and asks when it finds neither.
</p>
{#if nodes.some((node) => !node.mail)}
	<p class="mt-2 text-xs text-muted-foreground">
		Greyed-out nodes run an agent without mail support. Update their agent from
		<a href={resolve('/(dashboard)/nodes')} class="underline underline-offset-4">Nodes</a> to make them
		selectable.
	</p>
{/if}
