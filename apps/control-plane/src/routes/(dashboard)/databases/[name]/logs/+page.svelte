<script lang="ts">
	import ServiceLogs from '../../../_lib/service/ServiceLogs.svelte';
	import DatabaseHeader from '../../_lib/DatabaseHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · {data.database.name} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<DatabaseHeader db={data.database} can={data.dbCan} />

	<ServiceLogs
		endpoint="/api/v1/databases/{encodeURIComponent(data.database.name)}/logs"
		filename="{data.database.name}-postgres.log"
		canRead={data.canRead}
		initial={data.initial}
		loadError={data.logsError}
		emptyHint="Postgres writes to the unit journal and the agent drains it every couple of seconds. A fresh database may take a moment."
	/>
</div>
