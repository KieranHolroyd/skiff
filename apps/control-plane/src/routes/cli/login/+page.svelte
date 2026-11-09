<script lang="ts">
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import AuthShell from '#lib/components/yoal/AuthShell.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Authorize the CLI · Yoal</title>
</svelte:head>

<AuthShell
	eyebrow="CLI sign-in"
	title="Authorize the Yoal CLI"
	description="The CLI will receive an API key for {data.email ?? data.name ?? 'your account'}."
>
	<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
		<div class="flex items-center gap-2 border-b bg-muted/40 px-3.5 py-2">
			<TerminalIcon class="size-3.5 text-muted-foreground" aria-hidden="true" />
			<span class="text-xs font-medium text-muted-foreground">Terminal</span>
		</div>
		<pre class="px-4 py-3.5 font-mono text-sm"><span class="text-muted-foreground select-none"
				>$ </span>yoal login --web</pre>
	</div>

	<Alert.Root variant="warning" class="mt-4"
		><TriangleAlertIcon /><Alert.Description
			>Only continue if you just ran this command on this machine.</Alert.Description
		></Alert.Root
	>

	<p class="mt-4 text-sm leading-relaxed text-muted-foreground">
		The key gets the same access as your account{data.role ? ` (${data.role})` : ''}. You can revoke
		it later under Settings.
	</p>

	<form method="POST" class="mt-6 grid grid-cols-2 gap-3">
		<input type="hidden" name="redirect_uri" value={data.redirectUri} />
		<input type="hidden" name="state" value={data.state} />
		<input type="hidden" name="code_challenge" value={data.codeChallenge} />
		<input type="hidden" name="code_challenge_method" value="S256" />
		<Button type="submit" variant="outline" size="lg" class="h-10" name="decision" value="deny"
			>Cancel</Button
		>
		<Button type="submit" size="lg" class="h-10" name="decision" value="approve">Authorize</Button>
	</form>
</AuthShell>
