<script lang="ts">
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
	const theme = $derived(data.pool.theme);
	const primary = $derived(theme.primaryColor ?? '#4f46e5');
	const background = $derived(theme.backgroundColor ?? '#f8fafc');
</script>

<div
	class="pool-shell"
	style="--pool-primary: {primary}; --pool-bg: {background};"
>
	<main class="pool-card">
		<header class="pool-header">
			{#if theme.logoUrl}
				<img class="pool-logo" src={theme.logoUrl} alt="" />
			{/if}
			<h1>{theme.displayName ?? data.pool.name}</h1>
		</header>
		{@render children()}
		<footer class="pool-footer">
			Secured by Yoal Identity · {data.pool.issuer}
		</footer>
	</main>
</div>

<style>
	.pool-shell {
		min-height: 100svh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		background: var(--pool-bg);
		color: #111827;
	}
	.pool-card {
		width: 100%;
		max-width: 26rem;
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 0.9rem;
		padding: 2rem;
		box-shadow: 0 20px 45px -25px rgb(15 23 42 / 0.35);
	}
	.pool-header {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1.5rem;
		text-align: center;
	}
	.pool-header h1 {
		font-size: 1.35rem;
		font-weight: 650;
		line-height: 1.2;
	}
	.pool-logo {
		max-height: 3rem;
		max-width: 10rem;
		object-fit: contain;
	}
	.pool-footer {
		margin-top: 1.75rem;
		text-align: center;
		font-size: 0.72rem;
		color: #6b7280;
		overflow-wrap: anywhere;
	}
	:global(.pool-field) {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-bottom: 0.9rem;
	}
	:global(.pool-field label) {
		font-size: 0.82rem;
		font-weight: 550;
	}
	:global(.pool-field input) {
		width: 100%;
		border: 1px solid #d1d5db;
		border-radius: 0.5rem;
		padding: 0.6rem 0.7rem;
		font: inherit;
		background: #fff;
	}
	:global(.pool-field input:focus) {
		outline: 2px solid var(--pool-primary);
		outline-offset: 1px;
		border-color: transparent;
	}
	:global(.pool-submit) {
		width: 100%;
		border: 0;
		border-radius: 0.5rem;
		padding: 0.7rem 1rem;
		background: var(--pool-primary);
		color: #fff;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	:global(.pool-submit:hover) {
		filter: brightness(0.95);
	}
	:global(.pool-error) {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #991b1b;
		border-radius: 0.5rem;
		padding: 0.6rem 0.75rem;
		font-size: 0.85rem;
		margin-bottom: 1rem;
	}
	:global(.pool-notice) {
		background: #f0fdf4;
		border: 1px solid #bbf7d0;
		color: #166534;
		border-radius: 0.5rem;
		padding: 0.6rem 0.75rem;
		font-size: 0.85rem;
		margin-bottom: 1rem;
	}
	:global(.pool-alt) {
		margin-top: 1.25rem;
		text-align: center;
		font-size: 0.85rem;
		color: #4b5563;
	}
	:global(.pool-alt a) {
		color: var(--pool-primary);
		font-weight: 550;
	}
</style>
