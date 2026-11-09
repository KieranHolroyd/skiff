<script lang="ts">
	import ServiceLogs from '../../../_lib/service/ServiceLogs.svelte';
	import StorageHeader from '../../_lib/StorageHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · {data.storage.name} · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<StorageHeader st={data.storage} can={data.storageCan} />

	<ServiceLogs
		endpoint="/api/v1/storage/{encodeURIComponent(data.storage.name)}/logs"
		filename="{data.storage.name}-rustfs.log"
		canRead={data.canRead}
		initial={data.initial}
		loadError={data.logsError}
		emptyHint="RustFS writes to the unit journal and the agent drains it every couple of seconds. A fresh instance may take a moment."
	/>
</div>
