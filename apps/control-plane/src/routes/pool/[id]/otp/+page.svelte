<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const form = $derived(
		(data as { form?: { error?: string; email?: string } | null }).form
	);
	const error = $derived(form?.error);
	const email = $derived(form?.email ?? data.email);
</script>

<svelte:head>
	<title>One-time code · {data.pool.theme.displayName ?? data.pool.name}</title>
</svelte:head>

<h1 class="pool-heading">Sign in with a code</h1>
<p class="pool-intro">
	We will email a six-digit code to the address below. It can be used once and expires in ten
	minutes.
</p>

{#if data.sent}
	<div class="pool-notice">
		If that address has an account, a sign-in code is on its way.
	</div>
{/if}
{#if error}
	<div class="pool-error">{error}</div>
{/if}

<form method="POST" action="?/request">
	<input type="hidden" name="csrf" value={data.csrf} />
	<input type="hidden" name="return_to" value={data.returnTo ?? ''} />
	<div class="pool-field">
		<label for="otp-email">Email</label>
		<input id="otp-email" name="email" type="email" autocomplete="email" required value={email} />
	</div>
	<button class="pool-submit" type="submit">Email me a code</button>
</form>

<form method="POST" action="?/verify" class="pool-request">
	<input type="hidden" name="csrf" value={data.csrf} />
	<input type="hidden" name="return_to" value={data.returnTo ?? ''} />
	<div class="pool-field">
		<label for="otp-code">Six-digit code</label>
		<input
			id="otp-email-confirm"
			name="email"
			type="email"
			autocomplete="email"
			required
			value={email}
		/>
		<input
			id="otp-code-input"
			name="code"
			type="text"
			inputmode="numeric"
			autocomplete="one-time-code"
			pattern="[0-9]{6}"
			maxlength="6"
			required
		/>
	</div>
	<button class="pool-submit" type="submit">Sign in</button>
</form>

<div class="pool-alt">
	<a href={`/pool/${data.pool.id}/login`}>Back to sign in</a>
</div>
