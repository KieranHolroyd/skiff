<script lang="ts">
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { confirmEnableWrites, openReadOnly } from '#lib/studio/shell/actions.js';
	import OpenSessionPanel from '#lib/studio/shell/OpenSessionPanel.svelte';
	import StudioShell from '#lib/studio/shell/StudioShell.svelte';
	import DatabaseHeader from '../../_lib/DatabaseHeader.svelte';
	import type { PageProps } from './$types';

	/** The native database studio (plan 22). The workspace itself lives in `#lib/studio/shell`. */
	let { data }: PageProps = $props();

	const db = $derived(data.database);
	const can = $derived(data.dbCan);
	const deleted = $derived(db.deletedAt !== null);
	const session = $derived(data.studio?.active && data.studio.sessionId ? data.studio : null);
</script>

<svelte:head>
	<title>Studio · {db.name} · Yoal</title>
</svelte:head>

<div class="space-y-4">
	<DatabaseHeader {db} {can} />

	{#if !can.console}
		<Notice tone="warning" title="Studio access required">
			Opening the database studio needs <code class="font-mono">database:console</code>. Ask an
			owner if you need it.
		</Notice>
	{:else if deleted}
		<Notice tone="warning" title="This database is in the trash">
			Restore it to open the studio.
		</Notice>
	{:else if data.studioError}
		<Notice tone="danger" title="Could not read the studio session">{data.studioError}</Notice>
	{:else if !session}
		<OpenSessionPanel
			name={db.name}
			idleMinutes={data.studio?.idleMinutes ?? 15}
			canWrite={data.canWrite}
			onopenreadonly={openReadOnly}
			onenablewrites={() => confirmEnableWrites(db.name)}
		/>
	{:else}
		{#key `${session.sessionId}:${session.readOnly}`}
			<StudioShell
				database={db.name}
				engine={db.engine}
				nodeLabel={db.nodeName ?? db.nodeId}
				sessionId={session.sessionId!}
				readOnly={session.readOnly}
				expiresAt={session.expiresAt}
				canWrite={data.canWrite}
				principal={session.principal}
				principalError={session.principalError}
			/>
		{/key}
	{/if}
</div>
