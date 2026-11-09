<script lang="ts">
	import Logo from '#lib/components/yoal/Logo.svelte';
</script>

<svelte:head>
	<title>Yoal</title>
</svelte:head>

<main class="grid min-h-svh place-items-center bg-background p-6">
	<div class="flex flex-col items-center gap-4">
		<Logo size="lg" />
		<p class="flex items-center gap-2 text-sm text-muted-foreground">
			<span class="size-1.5 animate-pulse rounded-full bg-brand"></span>
			Redirecting…
		</p>
	</div>
</main>
