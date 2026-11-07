<script lang="ts">
	import ServiceLogs from '../../../_lib/service/ServiceLogs.svelte';
	import BrokerHeader from '../../_lib/BrokerHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Logs · {data.broker.name} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<BrokerHeader broker={data.broker} can={data.brokerCan} />

	<ServiceLogs
		endpoint="/api/v1/brokers/{encodeURIComponent(data.broker.name)}/logs"
		filename="{data.broker.name}-{data.broker.engine}.log"
		canRead={data.canRead}
		initial={data.initial}
		loadError={data.logsError}
		emptyHint="The broker writes to the unit journal and the agent drains it every couple of seconds. A fresh broker may take a moment."
	/>
</div>
