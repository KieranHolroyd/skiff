<script lang="ts">
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import { Button } from '#lib/components/ui/button/index.js';
	import EmptyState from '../../../routes/(dashboard)/_lib/EmptyState.svelte';
	import Panel from '../../../routes/(dashboard)/_lib/Panel.svelte';

	/** Shown while no studio session is open (plan 22). */
	let {
		name,
		idleMinutes,
		canWrite,
		onopenreadonly,
		onenablewrites
	}: {
		name: string;
		idleMinutes: number;
		canWrite: boolean;
		onopenreadonly: () => void;
		onenablewrites: () => void;
	} = $props();
</script>

<Panel
	title="Database studio"
	icon={SquareTerminalIcon}
	description="Browse and query {name} from the dashboard. Nothing runs on the node until you open a session, and it closes itself when idle."
>
	<EmptyState
		icon={SquareTerminalIcon}
		title="Open the database studio"
		description={`Sessions are read-only unless you enable writes, and expire after ${idleMinutes} idle minutes.`}
	>
		<Button onclick={onopenreadonly}><PlayIcon />Open read-only</Button>
		{#if canWrite}
			<Button variant="outline" onclick={onenablewrites}><PencilIcon />Open with writes</Button>
		{/if}
	</EmptyState>
</Panel>
