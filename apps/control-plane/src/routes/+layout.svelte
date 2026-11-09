<script lang="ts">
	import './layout.css';
	import { ModeWatcher } from 'mode-watcher';
	import favicon from '#lib/assets/favicon.svg';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import ConfirmHost from '#lib/components/yoal/ConfirmHost.svelte';
	import VerifyDialog from '#lib/components/yoal/VerifyDialog.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!-- Installable app (manifest + src/service-worker) for Web Push alerts, D108. -->
	<link rel="manifest" href="/manifest.webmanifest" />
	<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
	<meta name="apple-mobile-web-app-title" content="Yoal" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
</svelte:head>

<ModeWatcher themeColors={{ light: '#ffffff', dark: '#0a0a0a' }} />
<Toaster position="bottom-right" richColors closeButton />
<ConfirmHost />
<VerifyDialog />

<Tooltip.Provider delayDuration={250}>
	{@render children()}
</Tooltip.Provider>
