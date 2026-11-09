<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import MailIcon from '@lucide/svelte/icons/mail';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SmartphoneIcon from '@lucide/svelte/icons/smartphone';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { toast } from 'svelte-sonner';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { settleVerify, verifyState, type VerifyStatus } from '#lib/verify.svelte.js';

	type MethodName = Exclude<VerifyStatus['preferred'], null> | 'backup-code';

	const request = $derived(verifyState.request);
	let status = $state<VerifyStatus | null>(null);
	let selected = $state<MethodName | null>(null);
	let loading = $state(false);
	let busy = $state(false);
	let error = $state('');
	let code = $state('');
	let password = $state('');
	let emailSent = $state(false);
	let showAll = $state(false);

	const methods = $derived(
		status ? ([status.preferred, ...status.alternatives].filter(Boolean) as MethodName[]) : [],
	);
	const labels: Record<MethodName, string> = {
		passkey: 'Use a passkey',
		totp: 'Authenticator code',
		'backup-code': 'Backup code',
		password: 'Password',
		email: 'Email code',
	};

	$effect(() => {
		if (!request) {
			status = null;
			selected = null;
			error = '';
			code = '';
			password = '';
			emailSent = false;
			showAll = false;
			return;
		}
		void load();
	});

	async function load() {
		loading = true;
		error = '';
		showAll = false;
		emailSent = false;
		code = '';
		password = '';
		try {
			status = await get<VerifyStatus>('/api/auth/step-up/status');
			selected = status.preferred;
			if (status.preferred === 'email') emailSent = false;
		} catch (caught) {
			error = messageOf(caught);
		} finally {
			loading = false;
		}
	}

	function close() {
		if (busy) return;
		settleVerify(false);
	}

	function succeed(message: string) {
		toast.success(message);
		void invalidateAll();
		settleVerify(true);
	}

	function pick(method: MethodName) {
		selected = method;
		code = '';
		password = '';
		error = '';
		emailSent = false;
	}

	async function submitCode(event: SubmitEvent) {
		event.preventDefault();
		if (!selected || busy) return;
		busy = true;
		error = '';
		try {
			if (selected === 'totp') {
				await post('/api/auth/step-up/totp', { code });
				succeed('Verified with your authenticator app.');
			} else if (selected === 'backup-code') {
				await post('/api/auth/step-up/backup-code', { code });
				succeed('Verified with a backup code.');
			} else if (selected === 'email') {
				await post('/api/auth/step-up/email/verify', {
					code,
					...(request?.permission ? { action: request.permission } : {}),
				});
				succeed('Verified by email.');
			}
		} catch (caught) {
			error = messageOf(caught);
		} finally {
			busy = false;
		}
	}

	async function submitPassword(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		busy = true;
		error = '';
		try {
			await post('/api/auth/step-up/password', { password });
			succeed('Verified with your password.');
		} catch (caught) {
			error = messageOf(caught);
		} finally {
			busy = false;
		}
	}

	async function sendEmail() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			await post('/api/auth/step-up/email/send', {
				...(request?.permission ? { action: request.permission } : {}),
			});
			emailSent = true;
		} catch (caught) {
			error = messageOf(caught);
		} finally {
			busy = false;
		}
	}

	async function usePasskey() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			const options = await post<AuthenticationOptions>('/api/auth/step-up/passkey/options', {});
			const credential = (await navigator.credentials.get({
				publicKey: {
					challenge: fromBase64Url(options.challenge),
					rpId: options.rpId,
					timeout: options.timeout,
					userVerification: (options.userVerification ?? 'required') as UserVerificationRequirement,
					allowCredentials: options.allowCredentials?.map((allowed) => ({
						id: fromBase64Url(allowed.id),
						type: 'public-key',
						transports: allowed.transports as AuthenticatorTransport[] | undefined,
					})),
				},
			})) as PublicKeyCredential | null;
			if (!credential) throw new Error('The passkey prompt was dismissed.');
			await post('/api/auth/step-up/passkey/verify', {
				response: serializeAssertion(credential),
			});
			succeed('Verified with your passkey.');
		} catch (caught) {
			error = messageOf(caught);
		} finally {
			busy = false;
		}
	}

	interface AuthenticationOptions {
		challenge: string;
		rpId?: string;
		timeout?: number;
		userVerification?: string;
		allowCredentials?: Array<{ id: string; type?: string; transports?: string[] }>;
	}

	function serializeAssertion(credential: PublicKeyCredential) {
		const response = credential.response as AuthenticatorAssertionResponse;
		return {
			id: credential.id,
			rawId: toBase64Url(credential.rawId),
			type: credential.type,
			response: {
				clientDataJSON: toBase64Url(response.clientDataJSON),
				authenticatorData: toBase64Url(response.authenticatorData),
				signature: toBase64Url(response.signature),
				...(response.userHandle ? { userHandle: toBase64Url(response.userHandle) } : {}),
			},
			clientExtensionResults: credential.getClientExtensionResults(),
			...(credential.authenticatorAttachment
				? { authenticatorAttachment: credential.authenticatorAttachment }
				: {}),
		};
	}

	function toBase64Url(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer);
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	function fromBase64Url(value: string): ArrayBuffer {
		const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const buffer = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(buffer).set(bytes);
		return buffer;
	}

	async function get<T>(url: string): Promise<T> {
		const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
		if (!response.ok) throw new Error(await errorMessage(response));
		return (await response.json()) as T;
	}

	async function post<T = unknown>(url: string, body: unknown): Promise<T> {
		const response = await fetch(url, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(await errorMessage(response));
		return (await response.json()) as T;
	}

	async function errorMessage(response: Response): Promise<string> {
		try {
			const body = (await response.json()) as { message?: unknown };
			if (typeof body.message === 'string' && body.message) return body.message;
		} catch {
			// Not JSON.
		}
		return `Verification failed (${response.status}).`;
	}

	function messageOf(caught: unknown): string {
		return caught instanceof Error && caught.message ? caught.message : 'Verification failed.';
	}
</script>

<Dialog.Root open={request !== null} onOpenChange={(open) => !open && close()}>
	<Dialog.Content class="sm:max-w-md" showCloseButton={!busy}>
		<Dialog.Header class="flex-row items-start gap-3.5">
			<span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
				<ShieldCheckIcon class="size-4" />
			</span>
			<div class="space-y-1.5">
				<Dialog.Title>Verify it’s you</Dialog.Title>
				<Dialog.Description>
					{request?.action ?? request?.permission
						? `Confirm this sensitive action: ${request?.action ?? request?.permission}.`
						: 'Confirm this sensitive action before continuing.'}
					{#if request?.level === 'always'}
						This action asks every time, even inside the 30-minute window.
					{:else if status?.freshUntil}
						Your last check is no longer fresh enough for this action.
					{/if}
				</Dialog.Description>
			</div>
		</Dialog.Header>

		{#if loading}
			<div class="flex items-center gap-2 py-6 text-sm text-muted-foreground">
				<Spinner />Checking which methods you can use…
			</div>
		{:else if error}
			<Alert.Root variant="destructive">
				<TriangleAlertIcon />
				<Alert.Description>{error}</Alert.Description>
			</Alert.Root>
		{/if}

		{#if status && !loading}
			{#if !status.preferred}
				<Alert.Root variant="warning">
					<TriangleAlertIcon />
					<Alert.Title>No verification method yet</Alert.Title>
					<Alert.Description>
						Add a passkey in <a class="font-medium underline underline-offset-4" href="/settings/account">Settings → Account</a>
						before using sensitive actions.
					</Alert.Description>
				</Alert.Root>
			{:else}
				{#if showAll && methods.length > 1}
					<div class="flex flex-wrap gap-2">
						{#each methods as method (method)}
							<Button
								size="sm"
								variant={selected === method ? 'default' : 'outline'}
								onclick={() => pick(method)}
							>
								{#if method === 'passkey'}<FingerprintIcon />{:else if method === 'password'}<KeyRoundIcon />{:else if method === 'email'}<MailIcon />{:else}<SmartphoneIcon />{/if}
								{labels[method]}
							</Button>
						{/each}
					</div>
				{/if}

				{#if selected === 'passkey'}
					<div class="grid gap-3">
						<Button size="lg" disabled={busy} onclick={usePasskey}>
							{#if busy}<Spinner />{:else}<FingerprintIcon />{/if}
							{labels.passkey}
						</Button>
						<p class="text-xs text-muted-foreground">
							Your browser will ask for your fingerprint, face or security key.
						</p>
					</div>
				{:else if selected === 'totp' || selected === 'backup-code'}
					<form class="grid gap-4" onsubmit={submitCode}>
						<Field.Field>
							<Field.Label for="step-up-code">
								{selected === 'totp' ? 'Code from your authenticator app' : 'One of your backup codes'}
							</Field.Label>
							<Input
								id="step-up-code"
								bind:value={code}
								autocomplete="one-time-code"
								inputmode={selected === 'totp' ? 'numeric' : 'text'}
								placeholder={selected === 'totp' ? '123456' : 'abcde-12345'}
								required
							/>
						</Field.Field>
						<Button type="submit" disabled={busy || !code.trim()}>
							{#if busy}<Spinner />{/if}Verify
						</Button>
					</form>
				{:else if selected === 'password'}
					<form class="grid gap-4" onsubmit={submitPassword}>
						<Field.Field>
							<Field.Label for="step-up-password">Your password</Field.Label>
							<Input
								id="step-up-password"
								type="password"
								bind:value={password}
								autocomplete="current-password"
								required
							/>
						</Field.Field>
						<Button type="submit" disabled={busy || !password}>
							{#if busy}<Spinner />{/if}Verify
						</Button>
					</form>
				{:else if selected === 'email'}
					{#if !emailSent}
						<div class="grid gap-4">
							<p class="text-sm text-muted-foreground">
								We’ll send a six-digit code to {status.email ?? 'your email address'}.
							</p>
							<Button disabled={busy} onclick={sendEmail}>
								{#if busy}<Spinner />{:else}<MailIcon />{/if}Send code
							</Button>
						</div>
					{:else}
						<form class="grid gap-4" onsubmit={submitCode}>
							<Field.Field>
								<Field.Label for="step-up-email-code">Code sent to {status.email ?? 'your email'}</Field.Label>
								<Input
									id="step-up-email-code"
									bind:value={code}
									autocomplete="one-time-code"
									inputmode="numeric"
									placeholder="123456"
									required
								/>
							</Field.Field>
							<div class="flex items-center gap-2">
								<Button type="submit" disabled={busy || !code.trim()}>
									{#if busy}<Spinner />{/if}Verify
								</Button>
								<Button type="button" variant="ghost" disabled={busy} onclick={sendEmail}>Resend</Button>
							</div>
						</form>
					{/if}
				{/if}

				{#if methods.length > 1 && !showAll}
					<button
						type="button"
						class="text-sm font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
						onclick={() => (showAll = true)}
					>
						Try another way
					</button>
				{/if}
			{/if}
		{/if}

		<Dialog.Footer>
			<Dialog.Close>
				{#snippet child({ props })}<Button variant="outline" disabled={busy} {...props}>Cancel</Button>{/snippet}
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
